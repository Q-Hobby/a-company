import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmbeddedDesktopServer } from "./embedded-server.js";

describe("EmbeddedDesktopServer", () => {
  let userDataDir = "";

  afterEach(async () => {
    if (userDataDir) {
      await rm(userDataDir, { recursive: true, force: true });
      userDataDir = "";
    }
  });

  it("boots on loopback with persistent secrets, accountless mode, and authenticated stack probe", async () => {
    userDataDir = await mkdtemp(path.join(tmpdir(), "acompany-embedded-desktop-"));
    const stopSpy = vi.fn(async () => undefined);
    let capturedOverrides: Record<string, unknown> = {};

    const server = new EmbeddedDesktopServer({
      userDataDir,
      packaged: false,
      resourcesPath: userDataDir,
      appPath: path.resolve(import.meta.dirname, ".."),
      imageTag: "v0.2.0",
      createApp: async (overrides) => {
        capturedOverrides = overrides;
        return {
          app: {
            fetch: async (req: Request) => {
              const u = new URL(req.url);
              if (u.pathname === "/rpc/health") {
                return Response.json({ json: { ok: true, version: "0.2.0" } });
              }
              return new Response("not found", { status: 404 });
            },
          },
          stop: stopSpy,
        };
      },
    });

    try {
      const origin = await server.start();
      expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(server.isRunning()).toBe(true);
      expect(server.webUrl()).toBe(origin);
      expect(server.token()).toMatch(/^[0-9a-f]{64}$/);
      expect(capturedOverrides.accountlessMode).toBe(true);
      expect(capturedOverrides.sandboxProvider).toBe("desktop");
      expect(String(capturedOverrides.databaseUrl)).toMatch(/^pglite:\/\//);

      const unauthProbe = await fetch(`${origin}/.well-known/acompany-desktop-stack`);
      expect(unauthProbe.status).toBe(404);

      const authProbe = await fetch(`${origin}/.well-known/acompany-desktop-stack`, {
        headers: { "x-acompany-desktop-stack-token": server.token()! },
      });
      expect(authProbe.status).toBe(200);
      await expect(authProbe.json()).resolves.toEqual({ ok: true, imageTag: "v0.2.0" });

      const health = await fetch(`${origin}/rpc/health`, { method: "POST" });
      expect(health.status).toBe(200);
    } finally {
      await server.stop();
    }

    expect(server.isRunning()).toBe(false);
    expect(stopSpy).toHaveBeenCalledOnce();

    const previousKey = capturedOverrides.encryptionKey;
    try {
      await Promise.all([server.start(), server.start()]);
      expect(capturedOverrides.encryptionKey).toBe(previousKey);
    } finally {
      await server.stop();
    }
    expect(stopSpy).toHaveBeenCalledTimes(2);

    const secretsFile = path.join(userDataDir, "embedded", ".embedded-secrets.json");
    await writeFile(secretsFile, "invalid-fixture");
    await expect(server.start()).rejects.toThrow("secrets are invalid");
    expect(await readFile(secretsFile, "utf8")).toBe("invalid-fixture");
  });
});
