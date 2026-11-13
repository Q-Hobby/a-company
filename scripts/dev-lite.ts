#!/usr/bin/env node
/**
 * Zero-Docker local launcher for A-Company:
 * - Boots an embedded PostgreSQL engine via PGlite (`DATABASE_URL=pglite`)
 * - Runs background jobs in-process (`WAKEUP_DRIVER=memory`)
 * - Generates persistent local development secrets inside `DATA_DIR/.lite-secrets.json`
 * - Starts `apps/api` and `apps/web` (Vite) together on `http://127.0.0.1:5173`
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.resolve(rootDir, process.env.DATA_DIR ?? "./data/lite");
fs.mkdirSync(dataDir, { recursive: true });

const secretsFile = path.join(dataDir, ".lite-secrets.json");
interface LiteSecrets {
  authSecret: string;
  encryptionKey: string;
  screenProxySecret: string;
}

function loadOrCreateLiteSecrets(): LiteSecrets {
  if (fs.existsSync(secretsFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(secretsFile, "utf8")) as Partial<LiteSecrets>;
      if (parsed.authSecret && parsed.encryptionKey && parsed.screenProxySecret) {
        return parsed as LiteSecrets;
      }
    } catch {
      // Regenerate below if unreadable.
    }
  }
  const created: LiteSecrets = {
    authSecret: randomBytes(32).toString("hex"),
    encryptionKey: randomBytes(32).toString("hex"),
    screenProxySecret: randomBytes(32).toString("hex"),
  };
  fs.writeFileSync(secretsFile, `${JSON.stringify(created, null, 2)}\n`, { mode: 0o600 });
  return created;
}

const secrets = loadOrCreateLiteSecrets();
const apiPort = process.env.API_PORT ?? "3100";
const webPort = process.env.WEB_PORT ?? "5173";
const webOrigin = process.env.WEB_ORIGIN ?? `http://127.0.0.1:${webPort}`;
const apiUrl = process.env.API_URL ?? `http://127.0.0.1:${apiPort}`;

const sharedEnv: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_ENV: process.env.NODE_ENV ?? "development",
  DATA_DIR: dataDir,
  DATABASE_URL: process.env.DATABASE_URL ?? "pglite",
  WAKEUP_DRIVER: process.env.WAKEUP_DRIVER ?? "memory",
  SANDBOX_PROVIDER: process.env.SANDBOX_PROVIDER ?? "desktop",
  EMAIL_EMULATOR: process.env.EMAIL_EMULATOR ?? "true",
  BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? secrets.authSecret,
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? secrets.encryptionKey,
  SCREEN_PROXY_SECRET: process.env.SCREEN_PROXY_SECRET ?? secrets.screenProxySecret,
  API_HOST: process.env.API_HOST ?? "127.0.0.1",
  API_PORT: apiPort,
  API_URL: apiUrl,
  API_PROXY_TARGET: apiUrl,
  WEB_PORT: webPort,
  WEB_ORIGIN: webOrigin,
  BETTER_AUTH_URL: process.env.BETTER_AUTH_URL ?? webOrigin,
  ACCOUNTLESS_MODE: process.env.ACCOUNTLESS_MODE ?? "true",
  VITE_ACCOUNTLESS_MODE:
    process.env.VITE_ACCOUNTLESS_MODE ?? process.env.ACCOUNTLESS_MODE ?? "true",
};

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");
const webRequire = createRequire(path.join(rootDir, "apps/web/package.json"));
const viteBin = path.resolve(path.dirname(webRequire.resolve("vite/package.json")), "bin/vite.js");

process.stdout.write(
  `\n[A-Company Lite] Starting zero-Docker local mode...\n` +
    `  Data directory : ${dataDir}\n` +
    `  Database       : ${sharedEnv.DATABASE_URL} (embedded PGlite)\n` +
    `  Web UI         : ${webOrigin}\n\n`,
);

const apiProc = spawn(process.execPath, [tsxCli, "src/index.ts"], {
  cwd: path.join(rootDir, "apps/api"),
  env: sharedEnv,
  stdio: ["ignore", "inherit", "inherit"],
});

const webProc = spawn(process.execPath, [viteBin], {
  cwd: path.join(rootDir, "apps/web"),
  env: sharedEnv,
  stdio: ["ignore", "inherit", "inherit"],
});

let shuttingDown = false;
function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (!apiProc.killed) apiProc.kill("SIGTERM");
  if (!webProc.killed) webProc.kill("SIGTERM");
  setTimeout(() => process.exit(exitCode), 500).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

apiProc.on("exit", (code: number | null) => {
  if (!shuttingDown) {
    process.stderr.write(`[A-Company Lite] API exited (${code ?? 0})\n`);
    shutdown(code ?? 1);
  }
});

webProc.on("exit", (code: number | null) => {
  if (!shuttingDown) {
    process.stderr.write(`[A-Company Lite] Web exited (${code ?? 0})\n`);
    shutdown(code ?? 1);
  }
});
