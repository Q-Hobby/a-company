import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { DesktopStackProbeResponse } from "@acompany/contracts";
import {
  bundledRendererCandidates,
  contentType,
  immutableRendererAsset,
} from "./renderer-assets.js";

const DESKTOP_STACK_PROBE_PATH = "/.well-known/acompany-desktop-stack";
const DESKTOP_STACK_TOKEN_HEADER = "x-acompany-desktop-stack-token";

export interface EmbeddedAppHandles {
  app: { fetch: (request: Request) => Response | Promise<Response> };
  stop: () => Promise<void>;
}

type NodeHttpHandle = {
  once: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener: (event: string, listener: (...args: unknown[]) => void) => void;
  close: (cb?: (err?: Error) => void) => void;
  closeAllConnections?: () => void;
};

type ServeFn = (options: {
  hostname: string;
  port: number;
  fetch: (request: Request) => Response | Promise<Response>;
}) => NodeHttpHandle;

interface EmbeddedApiModule {
  createApp: (overrides: Record<string, unknown>) => Promise<EmbeddedAppHandles>;
  serve: ServeFn;
}

export interface EmbeddedWorkerStartPayload {
  packaged: boolean;
  port: number;
  pgliteDir: string;
  dataDir: string;
  migrationsDir: string;
  webDistRoot: string;
  appPath: string;
  imageTag: string;
  token: string;
  authSecret: string;
  encryptionKey: string;
  screenProxySecret: string;
}

function equalToken(expected: string, supplied: string | null): boolean {
  if (!expected || !supplied) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

async function loadRuntime(appPath: string): Promise<EmbeddedApiModule> {
  const bundled = path.join(import.meta.dirname, "embedded-api.mjs");
  if (existsSync(bundled)) {
    return (await import(pathToFileURL(bundled).href)) as EmbeddedApiModule;
  }
  const { serve } = await import("@hono/node-server");
  const workspaceSource = path.resolve(appPath, "../api/src/app.js");
  const mod = (await import(pathToFileURL(workspaceSource).href)) as {
    createApp: (overrides: Record<string, unknown>) => Promise<EmbeddedAppHandles>;
  };
  return { createApp: mod.createApp, serve: serve as unknown as ServeFn };
}

let activeServer: NodeHttpHandle | null = null;
let activeHandles: EmbeddedAppHandles | null = null;

async function stopActive(): Promise<void> {
  const server = activeServer;
  const handles = activeHandles;
  activeServer = null;
  activeHandles = null;
  if (server !== null) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }
  if (handles !== null) {
    await handles.stop();
  }
}

export async function startEmbeddedRuntime(
  payload: EmbeddedWorkerStartPayload,
  createAppOverride?: (overrides: Record<string, unknown>) => Promise<EmbeddedAppHandles>,
): Promise<{ origin: string; stop: () => Promise<void> }> {
  const origin = `http://127.0.0.1:${payload.port}`;
  process.env.ACOMPANY_MIGRATIONS_DIR = payload.migrationsDir;

  const runtime = createAppOverride
    ? {
        createApp: createAppOverride,
        serve: (await import("@hono/node-server")).serve as unknown as ServeFn,
      }
    : await loadRuntime(payload.appPath);
  const { createApp, serve } = runtime;
  const handles = await createApp({
    nodeEnv: payload.packaged ? "production" : "development",
    port: payload.port,
    databaseUrl: `pglite://${payload.pgliteDir}`,
    realtimeDatabaseUrl: `pglite://${payload.pgliteDir}`,
    authSecret: payload.authSecret,
    authUrl: origin,
    webOrigin: origin,
    apiUrl: origin,
    encryptionKey: payload.encryptionKey,
    screenProxySecret: payload.screenProxySecret,
    desktopStackToken: payload.token,
    accountlessMode: true,
    wakeupDriver: "memory",
    sandboxProvider: "desktop",
    mcpStdioEnabled: true,
    piSessionRecording: true,
    dataDir: payload.dataDir,
    imageTag: payload.imageTag,
  });

  const probeBody = JSON.stringify({
    ok: true,
    imageTag: payload.imageTag,
  } satisfies DesktopStackProbeResponse);

  const httpServer = serve({
    hostname: "127.0.0.1",
    port: payload.port,
    fetch: async (request) => {
      const parsed = new URL(request.url);
      if (parsed.pathname === DESKTOP_STACK_PROBE_PATH && request.method === "GET") {
        if (!equalToken(payload.token, request.headers.get(DESKTOP_STACK_TOKEN_HEADER))) {
          return new Response("Not found", { status: 404 });
        }
        return new Response(probeBody, {
          status: 200,
          headers: {
            "cache-control": "no-store",
            "content-type": "application/json; charset=utf-8",
          },
        });
      }
      const apiResponse = await handles.app.fetch(request);
      if (
        apiResponse.status !== 404 ||
        parsed.pathname.startsWith("/api/") ||
        parsed.pathname.startsWith("/rpc/")
      ) {
        return apiResponse;
      }
      if (
        (request.method === "GET" || request.method === "HEAD") &&
        existsSync(payload.webDistRoot)
      ) {
        const acceptsHtml = request.headers.get("accept")?.includes("text/html") ?? false;
        const candidates = bundledRendererCandidates(
          payload.webDistRoot,
          request.url,
          origin,
          acceptsHtml,
        );
        if (candidates) {
          for (const candidate of candidates) {
            try {
              if (!(await stat(candidate)).isFile()) continue;
              const body = request.method === "HEAD" ? null : await readFile(candidate);
              return new Response(body, {
                status: 200,
                headers: {
                  "cache-control": immutableRendererAsset(candidate)
                    ? "public, max-age=31536000, immutable"
                    : "no-cache",
                  "content-type": contentType(candidate),
                  "x-content-type-options": "nosniff",
                },
              });
            } catch {
              // Try next fallback candidate.
            }
          }
        }
      }
      return apiResponse;
    },
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: unknown) => reject(err);
      httpServer.once("error", onError);
      httpServer.once("listening", () => {
        httpServer.removeListener("error", onError);
        resolve();
      });
    });
  } catch (error) {
    await handles.stop();
    throw error;
  }

  activeHandles = handles;
  activeServer = httpServer;
  return { origin, stop: stopActive };
}

type ParentPortLike = {
  on: (event: "message", listener: (e: { data: unknown }) => void) => void;
  postMessage: (message: unknown) => void;
};

const parentPort = (process as NodeJS.Process & { parentPort?: ParentPortLike }).parentPort;
const isWorkerEntry =
  Boolean(process.argv[1]) &&
  pathToFileURL(path.resolve(process.argv[1]!)).href === import.meta.url;

function sendMessage(msg: unknown) {
  if (parentPort) parentPort.postMessage(msg);
  else if (typeof process.send === "function") process.send(msg);
}

async function handleIncoming(raw: unknown) {
  const msg = raw as { type?: string; payload?: EmbeddedWorkerStartPayload };
  if (msg?.type === "start" && msg.payload) {
    try {
      const { origin } = await startEmbeddedRuntime(msg.payload);
      sendMessage({ type: "started", origin });
    } catch (error) {
      sendMessage({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  } else if (msg?.type === "stop") {
    try {
      await stopActive();
    } finally {
      sendMessage({ type: "stopped" });
      process.exit(0);
    }
  }
}

if (isWorkerEntry && parentPort) {
  parentPort.on("message", (event) => {
    void handleIncoming(event.data);
  });
} else if (isWorkerEntry && typeof process.send === "function") {
  process.on("message", (msg) => {
    void handleIncoming(msg);
  });
}

// A crashed parent must not leave an accountless engine listening in the background.
if (isWorkerEntry && typeof process.send === "function") {
  process.once("disconnect", () => {
    void stopActive().finally(() => process.exit(0));
  });
}
