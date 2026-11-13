import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import type { Actor } from "@acompany/contracts";
import { RPCHandler } from "@orpc/server/fetch";
import { afterEach, expect, it } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it("wires all import RPCs with actor authorization and shared schemas", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "portable-rpc-test-"));
  roots.push(dataDir);
  const handler = new RPCHandler(
    createRouter({
      dataDir,
      prisma: {},
      env: { sandboxProvider: "fake" },
    } as unknown as RouterDeps),
  );
  const actor: Actor = {
    userId: "fixture-user",
    spaceId: "fixture-space",
    email: "fixture@example.test",
    isDeploymentOwner: false,
  };
  const request = async (method: string, input: unknown, owner: Actor | null = actor) => {
    const result = await handler.handle(
      new Request(`http://127.0.0.1/rpc/imports/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: input }),
      }),
      { prefix: "/rpc", context: { actor: owner } },
    );
    return { status: result.response.status, body: await result.response.json() };
  };
  expect((await request("list", {})).body).toEqual({ json: [] });
  expect((await request("list", {}, null)).status).toBe(401);
  const packet = {
    encoding: "gzip-base64",
    data: gzipSync(
      JSON.stringify({
        version: 1,
        exportedAt: "2026-01-01T00:00:00.000Z",
        projects: [],
        sessions: [],
        skills: [],
        warnings: [],
      }),
    ).toString("base64"),
  };
  expect((await request("preview", { packet })).body).toEqual({
    json: { projects: [], sessions: [], skills: [], warnings: [] },
  });
  const committed = await request("commit", {
    packet,
    selection: { projectIds: [], sessionIds: [], skillIds: [] },
  });
  expect(committed.status).toBe(200);
  const id = committed.body.json.id;
  expect((await request("get", { id })).body.json.receipt.id).toBe(id);
  expect((await request("export", { id })).body.json.packet.encoding).toBe("gzip-base64");
  expect((await request("continue", { id })).status).toBe(400);
  expect((await request("get", { id }, { ...actor, userId: "other" })).status).toBe(404);
});
