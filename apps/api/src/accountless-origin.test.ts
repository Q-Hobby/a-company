import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";

describe("accountless request boundary", () => {
  it("rejects cross-site mutations before dispatch while retaining same-origin and local CLI access", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "acompany-origin-test-"));
    const origin = "http://127.0.0.1:45173";
    const handles = await createApp({
      nodeEnv: "development",
      databaseUrl: "pglite",
      realtimeDatabaseUrl: "pglite",
      dataDir,
      authSecret: "a".repeat(64),
      encryptionKey: "b".repeat(64),
      screenProxySecret: "c".repeat(64),
      sandboxProvider: "desktop",
      accountlessMode: true,
      authUrl: origin,
      webOrigin: origin,
      apiUrl: origin,
    });
    try {
      const before = await handles.prisma.space.count();
      for (const headers of [
        { origin: "https://attacker.example", "content-type": "text/plain" },
        { origin: "https://attacker.example", "content-type": "application/x-www-form-urlencoded" },
        { origin: "http://127.0.0.1:9999", "content-type": "application/json" },
        { origin: "null", "content-type": "application/json" },
        { origin, host: "attacker.example:45173", "content-type": "application/json" },
        { "sec-fetch-site": "cross-site", "content-type": "application/json" },
      ]) {
        const response = await handles.app.request(`${origin}/rpc/spaces/create`, {
          method: "POST",
          headers,
          body: JSON.stringify({ json: { name: "Forbidden fixture" } }),
        });
        expect(response.status).toBe(403);
      }
      expect(await handles.prisma.space.count()).toBe(before);
      for (const headers of [
        { origin, "content-type": "application/json" },
        { "content-type": "application/json" },
      ]) {
        const response = await handles.app.request(`${origin}/rpc/bootstrap`, {
          method: "POST",
          headers,
          body: JSON.stringify({ json: {} }),
        });
        expect(response.status).toBe(200);
      }
    } finally {
      await handles.stop();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
