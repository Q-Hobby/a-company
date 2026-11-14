import type { ChildProcess } from "node:child_process";
import { fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readdir } from "node:fs/promises";
import type { Server } from "node:http";
import { createServer } from "node:http";
import path from "node:path";
import type { EmbeddedAppHandles, EmbeddedWorkerStartPayload } from "./embedded-worker.js";
import { readPrivateFile, writePrivateFile } from "./setup-store.js";

const EMBEDDED_SECRETS_FILE = ".embedded-secrets.json";
const EMBEDDED_TOKEN_FILE = ".embedded-stack-token";
const EMBEDDED_PORT_FILE = ".embedded-port";

interface EmbeddedSecrets {
  authSecret: string;
  encryptionKey: string;
  screenProxySecret: string;
}

export interface EmbeddedServerOptions {
  userDataDir: string;
  packaged: boolean;
  resourcesPath: string;
  appPath: string;
  imageTag: string;
  createApp?: (overrides: Record<string, unknown>) => Promise<EmbeddedAppHandles>;
}

async function allocatePort(preferredPort?: number): Promise<number> {
  const tryPort = (port: number) =>
    new Promise<number>((resolve, reject) => {
      const probe: Server = createServer();
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", () => {
        const addr = probe.address();
        const chosen = typeof addr === "object" && addr ? addr.port : 0;
        probe.close((err) => (err ? reject(err) : resolve(chosen)));
      });
    });
  if (preferredPort && preferredPort > 0) {
    try {
      return await tryPort(preferredPort);
    } catch {
      // Fall back to any ephemeral loopback port.
    }
  }
  return tryPort(0);
}

async function ensureEmbeddedSecrets(dir: string): Promise<EmbeddedSecrets> {
  const file = path.join(dir, EMBEDDED_SECRETS_FILE);
  const raw = await readPrivateFile(file, 8 * 1024);
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as Partial<EmbeddedSecrets>;
      if (
        typeof parsed.authSecret === "string" &&
        parsed.authSecret.length >= 32 &&
        typeof parsed.encryptionKey === "string" &&
        /^[0-9a-f]{64}$/.test(parsed.encryptionKey) &&
        typeof parsed.screenProxySecret === "string" &&
        parsed.screenProxySecret.length >= 32
      ) {
        return parsed as EmbeddedSecrets;
      }
    } catch {
      // Existing encryption keys must never be silently replaced.
    }
    throw new Error("Embedded workspace secrets are invalid; restore the original secrets file.");
  }
  try {
    await lstat(file);
    throw new Error(
      "Embedded workspace secrets are unreadable; restore access to the original file.",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if ((await readdir(path.join(dir, "pglite"))).length > 0) {
    throw new Error("Embedded workspace secrets are missing; restore the original secrets file.");
  }
  const created: EmbeddedSecrets = {
    authSecret: randomBytes(32).toString("hex"),
    encryptionKey: randomBytes(32).toString("hex"),
    screenProxySecret: randomBytes(32).toString("hex"),
  };
  await writePrivateFile(file, `${JSON.stringify(created, null, 2)}\n`);
  return created;
}

async function ensureEmbeddedToken(dir: string): Promise<string> {
  const file = path.join(dir, EMBEDDED_TOKEN_FILE);
  const raw = await readPrivateFile(file, 256);
  const trimmed = raw?.trim() ?? "";
  if (/^[0-9a-f]{64}$/.test(trimmed)) return trimmed;
  const token = randomBytes(32).toString("hex");
  await writePrivateFile(file, `${token}\n`);
  return token;
}

async function readPreferredPort(dir: string): Promise<number | undefined> {
  const raw = await readPrivateFile(path.join(dir, EMBEDDED_PORT_FILE), 64);
  const parsed = Number.parseInt(raw?.trim() ?? "", 10);
  return Number.isInteger(parsed) && parsed > 1024 && parsed < 65536 ? parsed : undefined;
}

function resolveMigrationsDir(options: EmbeddedServerOptions): string {
  if (options.packaged) {
    return path.join(options.resourcesPath, "migrations");
  }
  const fromApp = path.resolve(options.appPath, "../../packages/db/prisma/migrations");
  if (existsSync(fromApp)) return fromApp;
  return path.resolve(import.meta.dirname, "../../../packages/db/prisma/migrations");
}

export class EmbeddedDesktopServer {
  private url: string | null = null;
  private stackToken: string | null = null;
  private child: ChildProcess | null = null;
  private runtimeStop: (() => Promise<void>) | null = null;
  private starting: Promise<string> | null = null;

  constructor(private readonly options: EmbeddedServerOptions) {}

  webUrl(): string | null {
    return this.url;
  }
  token(): string | null {
    return this.stackToken;
  }
  isRunning(): boolean {
    return this.url !== null;
  }

  async start(): Promise<string> {
    if (this.url !== null) return this.url;
    if (this.starting !== null) return this.starting;
    const attempt = this.boot().finally(() => {
      if (this.starting === attempt) this.starting = null;
    });
    this.starting = attempt;
    return attempt;
  }

  async stop(): Promise<void> {
    await this.starting?.catch(() => undefined);
    const child = this.child;
    const runtimeStop = this.runtimeStop;
    this.child = null;
    this.runtimeStop = null;
    this.url = null;
    this.stackToken = null;
    if (child && child.exitCode === null && !child.killed) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => child.kill(), 15_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        if (child.connected) child.send({ type: "stop" });
        else child.kill();
      });
    }
    await runtimeStop?.();
  }

  private async boot(): Promise<string> {
    const rootDir = path.join(this.options.userDataDir, "embedded");
    const dataDir = path.join(rootDir, "data");
    const pgliteDir = path.join(rootDir, "pglite");
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    await mkdir(pgliteDir, { recursive: true, mode: 0o700 });
    const secrets = await ensureEmbeddedSecrets(rootDir);
    const token = await ensureEmbeddedToken(rootDir);
    const port = await allocatePort(await readPreferredPort(rootDir));
    await writePrivateFile(path.join(rootDir, EMBEDDED_PORT_FILE), `${port}\n`);
    const origin = `http://127.0.0.1:${port}`;
    const payload: EmbeddedWorkerStartPayload = {
      ...secrets,
      token,
      port,
      pgliteDir,
      dataDir,
      packaged: this.options.packaged,
      appPath: this.options.appPath,
      imageTag: this.options.imageTag,
      migrationsDir: resolveMigrationsDir(this.options),
      webDistRoot: this.options.packaged
        ? path.join(this.options.resourcesPath, "web")
        : path.resolve(this.options.appPath, "../web/dist"),
    };
    if (this.options.createApp) {
      const { startEmbeddedRuntime } = await import("./embedded-worker.js");
      const runtime = await startEmbeddedRuntime(payload, this.options.createApp);
      this.runtimeStop = runtime.stop;
    } else {
      await this.startChild(payload, origin);
    }
    this.stackToken = token;
    this.url = origin;
    return origin;
  }

  private async startChild(payload: EmbeddedWorkerStartPayload, origin: string): Promise<void> {
    const child = fork(path.join(import.meta.dirname, "embedded-worker.js"), [], {
      execPath: process.execPath,
      execArgv: [],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    this.child = child;
    child.once("exit", () => {
      if (this.child === child) {
        this.child = null;
        this.url = null;
        this.stackToken = null;
      }
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          child.removeListener("error", onError);
          child.removeListener("exit", onExit);
          child.removeListener("message", onMessage);
        };
        const onError = (error: Error) => {
          cleanup();
          reject(error);
        };
        const onExit = () => onError(new Error("Embedded engine exited during startup"));
        const onMessage = (raw: unknown) => {
          const message = raw as { type?: string; message?: string; origin?: string };
          if (message.type !== "started" && message.type !== "error") return;
          cleanup();
          if (message.type === "started" && message.origin === origin) resolve();
          else reject(new Error(message.message ?? "Invalid embedded engine response"));
        };
        const timer = setTimeout(
          () => onError(new Error("Embedded engine startup timed out")),
          90_000,
        );
        child.once("error", onError);
        child.once("exit", onExit);
        child.on("message", onMessage);
        child.send({ type: "start", payload }, (error) => {
          if (error) onError(error);
        });
      });
    } catch (error) {
      child.kill();
      this.child = null;
      throw error;
    }
  }
}
