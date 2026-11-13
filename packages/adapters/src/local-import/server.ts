import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { ImportPacket, ImportSelection, LocalImportScan } from "@acompany/contracts";
import {
  ImportPacketSchema,
  ImportSelectionSchema,
  LocalImportScanSchema,
  PORTABLE_IMPORT_MAX_PACKET_CHARS,
} from "@acompany/contracts";

export interface LocalImportCollector {
  scan(): Promise<LocalImportScan>;
  bundle(selection: ImportSelection): Promise<ImportPacket>;
}

const DEFAULT_ORIGINS = ["http://127.0.0.1:5173", "http://localhost:5173"];
const token = () => randomBytes(32).toString("hex");

export function validateLocalImportOrigin(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error("Invalid app origin");
  }
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    )
  ) {
    throw new Error("Invalid app origin");
  }
  return origin;
}

interface Pairing {
  origin: string;
  expires: number;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  if (Number(req.headers["content-length"] ?? 0) > maxBytes)
    throw new HttpError(413, "Request too large");
  let size = 0;
  const chunks: Buffer[] = [];
  // Do not destroy the socket when rejecting an oversized chunked body.
  return new Promise((resolve, reject) => {
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new HttpError(413, "Request too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => reject(new HttpError(400, "Invalid request")));
    req.on("aborted", () => reject(new HttpError(400, "Invalid request")));
  });
}

export interface LocalImportServerOptions {
  collector?: LocalImportCollector;
  allowedOrigins?: string[];
  port?: number;
}

export function createLocalImportServer(options: LocalImportServerOptions = {}) {
  if (
    options.port !== undefined &&
    (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)
  )
    throw new Error("Invalid helper port");
  let collector = options.collector;
  async function getCollector() {
    // Deferred until a paired request: starting the helper never reads source data.
    collector ??= (await import("./collector.js")).createLocalImportCollector();
    return collector;
  }
  const allowedOrigins = new Set(
    (options.allowedOrigins ?? DEFAULT_ORIGINS).map(validateLocalImportOrigin),
  );
  const pending = new Map<string, Pairing>();
  const capabilities = new Map<string, Pairing>();
  const attempts = new Map<string, { start: number; count: number }>();
  let collecting = false;
  function rateLimit(key: string) {
    const now = Date.now();
    let window = attempts.get(key);
    if (!window || now - window.start >= 60_000) {
      window = { start: now, count: 0 };
      attempts.set(key, window);
    }
    if (++window.count > 20) throw new HttpError(429, "Try again later");
  }
  function prune() {
    for (const map of [pending, capabilities])
      for (const [key, value] of map) if (value.expires <= Date.now()) map.delete(key);
  }
  function send(res: ServerResponse, status: number, body: unknown, html = false) {
    const content = html ? (body as string) : JSON.stringify(body);
    const limit =
      res.req.url === "/scan" ? 2 * 1024 * 1024 : PORTABLE_IMPORT_MAX_PACKET_CHARS + 1024;
    if (Buffer.byteLength(content) > limit) throw new Error("Response too large");
    res.statusCode = status;
    res.setHeader(
      "Content-Type",
      html ? "text/html; charset=utf-8" : "application/json; charset=utf-8",
    );
    res.end(content);
  }
  const server = createServer(
    {
      maxHeaderSize: 8192,
      headersTimeout: 5_000,
      requestTimeout: 10_000,
      connectionsCheckingInterval: 1000,
    },
    (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("X-Frame-Options", "DENY");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Vary", "Origin");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      );
      void handle(req, res).catch((error: unknown) => {
        if (!res.destroyed && !res.writableEnded) {
          res.setHeader("Connection", "close");
          send(res, error instanceof HttpError ? error.status : 500, {
            error: error instanceof HttpError ? error.message : "Import failed",
          });
        }
      });
    },
  );
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const address = server.address();
    const port = address && typeof address !== "string" ? address.port : (options.port ?? 43123);
    const helperOrigin = `http://127.0.0.1:${port}`;
    if (req.headers.host !== `127.0.0.1:${port}`) throw new HttpError(403, "Forbidden");
    if (!req.url?.startsWith("/") || req.url.startsWith("//") || req.url.length > 2048)
      throw new HttpError(400, "Invalid request");
    const url = new URL(req.url ?? "/", helperOrigin);
    if (req.url.includes("#") || req.url.includes("\\") || url.pathname !== req.url.split("?")[0])
      throw new HttpError(400, "Invalid request");
    if (
      req.method === "GET" &&
      (Number(req.headers["content-length"] ?? 0) > 0 || req.headers["transfer-encoding"])
    )
      throw new HttpError(400, "Invalid request");
    prune();
    const methods: Record<string, string> = {
      "/health": "GET",
      "/connect": "GET",
      "/approve": "POST",
      "/scan": "GET",
      "/bundle": "POST",
    };
    const method = methods[url.pathname];
    if (!method) throw new HttpError(404, "Not found");
    if (url.pathname !== "/connect" && url.search) throw new HttpError(400, "Invalid request");
    if (req.method === "OPTIONS" && (url.pathname === "/scan" || url.pathname === "/bundle")) {
      if (
        !req.headers.origin ||
        !allowedOrigins.has(req.headers.origin) ||
        req.headers["access-control-request-method"] !== method
      )
        throw new HttpError(403, "Forbidden");
      const requested = String(req.headers["access-control-request-headers"] ?? "")
        .toLowerCase()
        .split(",")
        .map((h) => h.trim())
        .filter(Boolean);
      if (requested.some((h) => h !== "authorization" && h !== "content-type"))
        throw new HttpError(403, "Forbidden");
      res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
      res.setHeader("Access-Control-Allow-Methods", method);
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      return send(res, 204, null);
    }
    if (req.method !== method) throw new HttpError(405, "Method not allowed");
    if (req.headers["content-encoding"]) throw new HttpError(415, "Unsupported media type");
    if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { status: "ok" });
    if (req.method === "GET" && url.pathname === "/connect") {
      rateLimit("connect");
      if (pending.size >= 32 || capabilities.size >= 32)
        throw new HttpError(429, "Try again later");
      if ([...url.searchParams.keys()].length !== 1) throw new HttpError(400, "Invalid request");
      const origin = url.searchParams.get("origin");
      if (!origin || !allowedOrigins.has(origin)) return send(res, 403, { error: "Forbidden" });
      const nonce = token();
      pending.set(nonce, { origin, expires: Date.now() + 5 * 60_000 });
      const safeOrigin = origin.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
      // A no-referrer form submission serializes Origin as "null" in Chromium.
      // Preserve the same-origin approval check without leaking cross-origin referrers.
      res.setHeader("Referrer-Policy", "same-origin");
      return send(
        res,
        200,
        `<!doctype html><html lang="en"><meta charset="utf-8"><title>A-Company local import</title><h1>Allow local import?</h1><p>App: ${safeOrigin}</p><p>Only allow this if you opened import in A-Company. Source scanning starts only after approval.</p><form action="/approve" method="post"><input type="hidden" name="nonce" value="${nonce}"><button type="submit">Allow</button></form></html>`,
        true,
      );
    }
    if (req.method === "POST" && url.pathname === "/approve") {
      rateLimit("approve");
      if (req.headers.origin !== helperOrigin) return send(res, 403, { error: "Forbidden" });
      if (req.headers["content-type"] !== "application/x-www-form-urlencoded")
        throw new HttpError(415, "Unsupported media type");
      const form = new URLSearchParams(await readBody(req, 1024));
      if ([...form.keys()].length !== 1) throw new HttpError(400, "Invalid request");
      const nonce = form.get("nonce") ?? "";
      const pairing = pending.get(nonce);
      if (!pairing || pairing.expires <= Date.now()) return send(res, 403, { error: "Forbidden" });
      pending.delete(nonce);
      if (capabilities.size >= 32) throw new HttpError(429, "Try again later");
      const { origin } = pairing;
      const capability = token();
      capabilities.set(capability, { origin, expires: Date.now() + 30 * 60_000 });
      const scriptNonce = token();
      res.setHeader(
        "Content-Security-Policy",
        `default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; script-src 'nonce-${scriptNonce}'`,
      );
      return send(
        res,
        200,
        `<!doctype html><html lang="en"><meta charset="utf-8"><title>Connected</title><script nonce="${scriptNonce}">if(window.opener){window.opener.postMessage({type:"a-company-import-connected",capability:"${capability}"},${JSON.stringify(origin)});window.close();}</script><p>Return to A-Company.</p></html>`,
        true,
      );
    }
    if (url.pathname === "/scan" || url.pathname === "/bundle") {
      const capability = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization ?? "")?.[1];
      if (
        !capability ||
        !req.headers.origin ||
        capabilities.get(capability)?.origin !== req.headers.origin
      )
        return send(res, 401, { error: "Unauthorized" });
      res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
      if (collecting) throw new HttpError(429, "Try again later");
      collecting = true;
      try {
        if (url.pathname === "/scan")
          return send(res, 200, LocalImportScanSchema.parse(await (await getCollector()).scan()));
        if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers["content-type"] ?? ""))
          throw new HttpError(415, "Unsupported media type");
        const body = await readBody(req, 512 * 1024);
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          throw new HttpError(400, "Invalid request");
        }
        if (
          !parsed ||
          typeof parsed !== "object" ||
          Object.keys(parsed).length !== 1 ||
          !("selection" in parsed)
        )
          throw new HttpError(400, "Invalid request");
        const selection = ImportSelectionSchema.strict().safeParse(parsed.selection);
        if (!selection.success) throw new HttpError(400, "Invalid request");
        return send(
          res,
          200,
          ImportPacketSchema.parse(await (await getCollector()).bundle(selection.data)),
        );
      } finally {
        collecting = false;
      }
    }
    return send(res, 404, { error: "Not found" });
  }
  server.on("close", () => {
    pending.clear();
    capabilities.clear();
    attempts.clear();
  });
  server.maxConnections = 32;
  server.timeout = 10_000;
  server.keepAliveTimeout = 1000;
  server.maxRequestsPerSocket = 100;
  return server;
}

export async function startLocalImportServer(options: LocalImportServerOptions = {}) {
  const server = createLocalImportServer(options);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 43123, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}
