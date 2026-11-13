import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import type { Server } from "node:http";
import { request } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import type { LocalImportScan } from "@acompany/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { createLocalImportServer, startLocalImportServer } from "./server.js";

const appOrigin = "http://127.0.0.1:5173";
const servers: Server[] = [];
const scan: LocalImportScan = { projects: [], sessions: [], skills: [], warnings: [], sources: [] };
const packet = { encoding: "gzip-base64" as const, data: "ZmFrZQ==" };
async function start() {
  const collector = { scan: vi.fn(async () => scan), bundle: vi.fn(async () => packet) };
  const server = createLocalImportServer({ collector, port: 0 });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP server");
  return { server, collector, base: `http://127.0.0.1:${address.port}` };
}
async function call(
  base: string,
  path: string,
  headers: Record<string, string> = {},
  method = "GET",
  body?: string,
) {
  return new Promise<{ status: number; headers: Record<string, unknown>; text: string }>(
    (resolve, reject) => {
      const req = request(base, { path, method, headers, agent: false }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString(),
          }),
        );
      });
      req.on("error", reject);
      req.end(body);
    },
  );
}
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
  vi.restoreAllMocks();
});
async function approve(base: string, origin = appOrigin) {
  const page = await call(base, `/connect?origin=${encodeURIComponent(origin)}`);
  expect(page.status).toBe(200);
  expect(page.headers["referrer-policy"]).toBe("same-origin");
  expect(page.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(page.text).toContain(">Allow</button>");
  const nonce = /name="nonce" value="([a-f0-9]{64})"/.exec(page.text)?.[1];
  expect(nonce).toBeTruthy();
  const response = await call(
    base,
    "/approve",
    { Origin: base, "Content-Type": "application/x-www-form-urlencoded" },
    "POST",
    `nonce=${nonce}`,
  );
  expect(response.status).toBe(200);
  expect(response.text).toContain('type:"a-company-import-connected"');
  expect(response.text).toContain(`,${JSON.stringify(origin)})`);
  const capability = /capability:"([a-f0-9]{64})"/.exec(response.text)?.[1];
  expect(capability).toBeTruthy();
  return { capability: capability ?? "", nonce: nonce ?? "", page, response };
}
it("requires explicit one-time consent then pairs capability to the exact app origin", async () => {
  const { base, collector } = await start();
  expect((await call(base, "/scan", { Origin: appOrigin })).status).toBe(401);
  expect(collector.scan).not.toHaveBeenCalled();
  const { capability, nonce, page } = await approve(base);
  expect(page.text).not.toContain("capability");
  expect(collector.scan).not.toHaveBeenCalled();
  const headers = { Origin: appOrigin, Authorization: `Bearer ${capability}` };
  expect((await call(base, "/scan", headers)).status).toBe(200);
  expect(collector.scan).toHaveBeenCalledTimes(1);
  expect((await call(base, "/scan", { ...headers, Origin: "http://localhost:5173" })).status).toBe(
    401,
  );
  expect((await call(base, "/scan", { Authorization: headers.Authorization })).status).toBe(401);
  expect(
    (
      await call(
        base,
        "/approve",
        { Origin: base, "Content-Type": "application/x-www-form-urlencoded" },
        "POST",
        `nonce=${nonce}`,
      )
    ).status,
  ).toBe(403);
});
it("does not consume a pending nonce from a forged approval Origin", async () => {
  const { base, collector } = await start();
  const page = await call(base, `/connect?origin=${encodeURIComponent(appOrigin)}`);
  const nonce = /name="nonce" value="([a-f0-9]{64})"/.exec(page.text)?.[1];
  for (const origin of [appOrigin, "null", "https://attacker.example", ""]) {
    expect(
      (
        await call(
          base,
          "/approve",
          { Origin: origin, "Content-Type": "application/x-www-form-urlencoded" },
          "POST",
          `nonce=${nonce}`,
        )
      ).status,
    ).toBe(403);
  }
  const valid = await call(
    base,
    "/approve",
    { Origin: base, "Content-Type": "application/x-www-form-urlencoded" },
    "POST",
    `nonce=${nonce}`,
  );
  expect(valid.status).toBe(200);
  expect(valid.headers["access-control-allow-origin"]).toBeUndefined();
  expect(valid.headers["x-frame-options"]).toBe("DENY");
  expect(valid.headers["content-security-policy"]).toMatch(/script-src 'nonce-[a-f0-9]{64}'/);
  expect(valid.headers["cache-control"]).toBe("no-store");
  expect(valid.headers["referrer-policy"]).toBe("no-referrer");
  expect("location" in valid.headers).toBe(false);
  expect(valid.headers["set-cookie"]).toBeUndefined();
  expect(collector.scan).not.toHaveBeenCalled();
});
it("rejects normalized/fragment targets and body-bearing GET requests", async () => {
  const { base } = await start();
  for (const path of ["/x/../health", "/health#fragment", "/x\\\\../health"]) {
    expect((await call(base, path)).status).toBe(400);
  }
  expect((await call(base, "/health", { "Content-Length": "2" }, "GET", "{}")).status).toBe(400);
});
it("rejects rebinding, unknown routes, forbidden origins and incorrect methods", async () => {
  const { base } = await start();
  expect((await call(base, "/health", { Host: "attacker.example" })).status).toBe(403);
  expect((await call(base, "/health", { Host: `localhost:${new URL(base).port}` })).status).toBe(
    403,
  );
  expect((await call(base, "/health?x=1")).status).toBe(400);
  expect((await call(base, "/unknown")).status).toBe(404);
  expect((await call(base, "/health", {}, "POST")).status).toBe(405);
  expect((await call(base, "/connect?origin=https%3A%2F%2Fattacker.example")).status).toBe(403);
  expect((await call(base, `/connect?origin=${encodeURIComponent(`${appOrigin}/`)}`)).status).toBe(
    403,
  );
  const { capability, nonce } = await approve(base);
  expect(
    (
      await call(
        base,
        "/scan",
        { Origin: appOrigin, Authorization: `Bearer ${capability}` },
        "POST",
      )
    ).status,
  ).toBe(405);
  expect(
    (
      await call(
        base,
        "/approve",
        { Origin: appOrigin, "Content-Type": "application/x-www-form-urlencoded" },
        "POST",
        `nonce=${nonce}`,
      )
    ).status,
  ).toBe(403);
});
it("allows exact-origin preflights only for scan and bundle without credentials or wildcard", async () => {
  const { base } = await start();
  const headers = {
    Origin: appOrigin,
    "Access-Control-Request-Method": "POST",
    "Access-Control-Request-Headers": "authorization, content-type",
  };
  const response = await call(base, "/bundle", headers, "OPTIONS");
  expect(response.status).toBe(204);
  expect(response.headers["access-control-allow-origin"]).toBe(appOrigin);
  expect(response.headers["access-control-allow-headers"]).toBe("Authorization, Content-Type");
  expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
  expect(
    (await call(base, "/bundle", { ...headers, Origin: "https://attacker.example" }, "OPTIONS"))
      .status,
  ).toBe(403);
  expect(
    (
      await call(
        base,
        "/bundle",
        { ...headers, "Access-Control-Request-Headers": "cookie" },
        "OPTIONS",
      )
    ).status,
  ).toBe(403);
  expect((await call(base, "/approve", headers, "OPTIONS")).status).toBe(405);
});
it("validates and bounds bundle selection before calling the collector and hides raw errors", async () => {
  const { base, collector } = await start();
  const { capability } = await approve(base);
  const headers = {
    Origin: appOrigin,
    Authorization: `Bearer ${capability}`,
    "Content-Type": "application/json",
  };
  const selection = { projectIds: [], sessionIds: ["fake"], skillIds: [] };
  const response = await call(base, "/bundle", headers, "POST", JSON.stringify({ selection }));
  expect(response.status).toBe(200);
  expect(JSON.parse(response.text)).toEqual(packet);
  expect(collector.bundle).toHaveBeenCalledWith(selection);
  for (const body of [
    "{",
    "null",
    "{}",
    '{"selection":{"projectIds":[]}}',
    JSON.stringify({ selection, path: "forbidden" }),
  ]) {
    expect((await call(base, "/bundle", headers, "POST", body)).status).toBe(400);
  }
  expect(
    (await call(base, "/bundle", { ...headers, "Content-Type": "text/plain" }, "POST", "{}"))
      .status,
  ).toBe(415);
  expect((await call(base, "/bundle", headers, "POST", "x".repeat(512 * 1024 + 1))).status).toBe(
    413,
  );
  expect(collector.bundle).toHaveBeenCalledTimes(1);
  collector.scan.mockRejectedValueOnce(new Error("SECRET C:/private/config"));
  const failure = await call(base, "/scan", headers);
  expect(failure.status).toBe(500);
  expect(failure.text).toBe('{"error":"Import failed"}');
});
it("expires nonces and capabilities without exposing data and revokes them on close", async () => {
  const { base, server, collector } = await start();
  const now = Date.now();
  const { capability } = await approve(base);
  const page = await call(base, `/connect?origin=${encodeURIComponent(appOrigin)}`);
  const nonce = /name="nonce" value="([a-f0-9]{64})"/.exec(page.text)?.[1];
  vi.spyOn(Date, "now").mockReturnValue(now + 31 * 60 * 1000);
  expect(
    (await call(base, "/scan", { Origin: appOrigin, Authorization: `Bearer ${capability}` }))
      .status,
  ).toBe(401);
  expect(
    (
      await call(
        base,
        "/approve",
        { Origin: base, "Content-Type": "application/x-www-form-urlencoded" },
        "POST",
        `nonce=${nonce}`,
      )
    ).status,
  ).toBe(403);
  expect(collector.scan).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  const renewed = await approve(base);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  server.listen(Number(new URL(base).port), "127.0.0.1");
  await once(server, "listening");
  expect(
    (
      await call(base, "/scan", {
        Origin: appOrigin,
        Authorization: `Bearer ${renewed.capability}`,
      })
    ).status,
  ).toBe(401);
});
it("bounds collection concurrency without a queue", async () => {
  const { base, collector } = await start();
  const { capability } = await approve(base);
  const headers = { Origin: appOrigin, Authorization: `Bearer ${capability}` };
  let release: (value: typeof scan) => void = () => {};
  collector.scan.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const first = call(base, "/scan", headers);
  await vi.waitFor(() => expect(collector.scan).toHaveBeenCalledTimes(1));
  try {
    expect((await call(base, "/scan", headers)).status).toBe(429);
  } finally {
    release(scan);
  }
  expect((await first).status).toBe(200);
});
it("rate limits approval attempts including invalid nonces", async () => {
  const { base } = await start();
  const statuses: number[] = [];
  for (let i = 0; i < 21; i++)
    statuses.push(
      (
        await call(
          base,
          "/approve",
          { Origin: base, "Content-Type": "application/x-www-form-urlencoded" },
          "POST",
          "nonce=invalid",
        )
      ).status,
    );
  expect(statuses.slice(0, 20)).toEqual(Array(20).fill(403));
  expect(statuses[20]).toBe(429);
});
it("validates explicit app origins and never implicitly trusts remote apps", async () => {
  for (const origin of [
    "http://remote.example",
    "https://app.example/path",
    "https://user:pass@app.example",
    "https://app.example/",
    "null",
    "file://",
    "https://app.example#fragment",
  ]) {
    expect(() => createLocalImportServer({ allowedOrigins: [origin] })).toThrow(
      "Invalid app origin",
    );
  }
  const server = createLocalImportServer({
    allowedOrigins: ["https://app.example", "http://localhost:8000", "http://[::1]:8000"],
  });
  expect(server.listening).toBe(false);
});
it("enforces bounded scan output without leaking oversized provider content", async () => {
  const { base, collector } = await start();
  const { capability } = await approve(base);
  collector.scan.mockResolvedValueOnce({ ...scan, warnings: ["x".repeat(2 * 1024 * 1024)] });
  const response = await call(base, "/scan", {
    Origin: appOrigin,
    Authorization: `Bearer ${capability}`,
  });
  expect(response.status).toBe(500);
  expect(response.text).toBe('{"error":"Import failed"}');
});
it("serves only static health and never scans on startup or health", async () => {
  const { base, collector } = await start();
  const response = await call(base, "/health");
  expect(response.status).toBe(200);
  expect(JSON.parse(response.text)).toEqual({ status: "ok" });
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(collector.scan).not.toHaveBeenCalled();
  expect(collector.bundle).not.toHaveBeenCalled();
});

it("starts the helper only on IPv4 loopback with bounded connections and timeouts", async () => {
  const collector = { scan: vi.fn(async () => scan), bundle: vi.fn(async () => packet) };
  const server = await startLocalImportServer({ collector, port: 0 });
  servers.push(server);
  expect(server.address()).toMatchObject({ address: "127.0.0.1", family: "IPv4" });
  expect(server.maxConnections).toBe(32);
  expect(server.requestTimeout).toBe(10_000);
  expect(server.headersTimeout).toBe(5_000);
  expect(collector.scan).not.toHaveBeenCalled();
});
it.skipIf(process.platform !== "win32")(
  "Windows launcher finds local runtime offline and works outside repo",
  async () => {
    const result = await promisify(execFile)(
      process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe",
      ["/d", "/c", "call", join(process.cwd(), "import_local.bat"), "--help"],
      {
        cwd: process.env.TMPDIR,
        env: { ...process.env, PATH: "C:/Windows/System32" },
        timeout: 20_000,
      },
    );
    expect(result.stdout).toContain("Usage: pnpm import:local");
  },
);
it("CLI prints help and rejects unsafe origins without starting or scanning", async () => {
  const run = promisify(execFile);
  const args = ["--import", "tsx", "scripts/local-import.ts"];
  const help = await run(process.execPath, [...args, "--help"], { cwd: process.cwd() });
  expect(help.stdout).toContain("--app-origin");
  const invalid = await run(process.execPath, [...args, "--app-origin", "http://remote.example"], {
    cwd: process.cwd(),
  }).then(
    () => null,
    (error: { stdout: string; stderr: string; code: number }) => error,
  );
  expect(invalid?.code).toBe(1);
  expect(invalid?.stderr).toContain("Invalid app origin");
  expect(invalid?.stdout).not.toContain("43123");
});

it("runs the executable helper and serves static health over real HTTP", async () => {
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/local-import.ts"], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    errors += chunk.toString();
  });
  const exited = once(child, "exit");
  try {
    await vi.waitFor(
      () => expect(output).toContain("Local import helper: http://127.0.0.1:43123/health"),
      { timeout: 5000 },
    );
    expect(JSON.parse((await call("http://127.0.0.1:43123", "/health")).text)).toEqual({
      status: "ok",
    });
    expect((await call("http://127.0.0.1:43123", "/scan", { Origin: appOrigin })).status).toBe(401);
    expect(errors).toBe("");
    expect(output.split("\n").filter(Boolean)).toHaveLength(2);
  } finally {
    child.kill("SIGINT");
    await exited;
  }
});
