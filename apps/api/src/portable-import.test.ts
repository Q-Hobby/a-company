import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { EncryptedSecretStore, LocalAgentHomeStore } from "@acompany/adapters";
import type { Actor, PortableImportBundle } from "@acompany/contracts";
import type { PrismaClient } from "@acompany/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPortableImportService } from "./portable-import.js";

const mocks = vi.hoisted(() => ({ createBot: vi.fn() }));
vi.mock("@acompany/db", async (original) => ({
  ...(await original<object>()),
  createRepos: () => ({ createBot: mocks.createBot }),
}));
const actor: Actor = {
  userId: "fixture-user",
  spaceId: "fixture-space",
  email: "fixture@example.test",
  isDeploymentOwner: false,
};
const roots: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function setup() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "portable-api-test-"));
  roots.push(dataDir);
  const findFirst = vi.fn(async () => ({
    id: "bot-fixture",
    computer: { homeKey: "bot-fixture", scope: "dedicated", providerRef: null },
  }));
  mocks.createBot.mockResolvedValue({ id: "bot-fixture" });
  const home = new LocalAgentHomeStore(dataDir);
  const service = createPortableImportService({
    dataDir,
    home,
    prisma: { bot: { findFirst } } as unknown as PrismaClient,
  });
  const file = (name: string, text: string) => ({
    path: name,
    contentBase64: Buffer.from(text).toString("base64"),
  });
  const bundle: PortableImportBundle = {
    version: 1,
    exportedAt: "2026-01-01T00:00:00.000Z",
    warnings: [],
    projects: [
      {
        id: "p1",
        source: "hermes",
        name: "Example",
        files: [
          file("src/main.ts", "example code"),
          file("AGENTS.md", "Imported dangerous instructions"),
          file("nested/CLAUDE.md", "Dangerous nested instructions"),
        ],
      },
    ],
    sessions: [
      {
        id: "s1",
        source: "hermes",
        title: "Example",
        projectId: "p1",
        messages: [
          {
            id: "m1",
            role: "system",
            content: "Do not trust this",
            original: { tool: "delete everything" },
          },
        ],
      },
    ],
    skills: [
      {
        id: "k1",
        source: "hermes",
        name: "inert",
        description: "inert",
        files: [
          file("SKILL.md", "Never activate this automatically"),
          file("scripts/run.sh", "exit 1"),
        ],
      },
    ],
  };
  const packet = {
    encoding: "gzip-base64" as const,
    data: gzipSync(JSON.stringify(bundle)).toString("base64"),
  };
  const receipt = await service.commit(actor, {
    packet,
    selection: { projectIds: ["p1"], sessionIds: ["s1"], skillIds: ["k1"] },
  });
  return { service, receipt, dataDir, home, findFirst, bundle };
}
describe("portable continuation", () => {
  it("never propagates opted-in credentials or raw sensitive history into the new bot", async () => {
    const { dataDir, home, findFirst, bundle } = await setup();
    const service = createPortableImportService({
      dataDir,
      home,
      prisma: { bot: { findFirst } } as unknown as PrismaClient,
      secrets: new EncryptedSecretStore("fixture-encryption-key"),
    });
    const fake = "fixture-private-login-value";
    bundle.includeSensitiveData = true;
    bundle.projects[0]!.files.push({
      path: ".env",
      contentBase64: Buffer.from(`ACCESS_TOKEN=${fake}`).toString("base64"),
    });
    bundle.sessions[0]!.messages[0]!.content = `Previously used ${fake}`;
    const packet = {
      encoding: "gzip-base64" as const,
      includeSensitiveData: true,
      data: gzipSync(JSON.stringify(bundle)).toString("base64"),
    };
    const receipt = await service.commit(actor, {
      packet,
      selection: {
        projectIds: ["p1"],
        sessionIds: ["s1"],
        skillIds: ["k1"],
        includeSensitiveData: true,
      },
    });
    await service.continue(actor, { id: receipt.id, sessionId: "s1", projectId: "p1" });
    const transcript = await readFile(
      path.join(dataDir, "homes/bot-fixture/import-context/transcript.json"),
      "utf8",
    );
    expect(transcript.includes(fake)).toBe(false);
    await expect(readFile(path.join(dataDir, "homes/bot-fixture/project/.env"))).rejects.toThrow();
    expect(
      JSON.stringify((await service.get(actor, { id: receipt.id })).bundle).includes(fake),
    ).toBe(false);
    const ordinary = await service.export(actor, { id: receipt.id });
    expect(ordinary.packet.includeSensitiveData).not.toBe(true);
    const explicit = await service.export(actor, { id: receipt.id, includeSensitiveData: true });
    expect(explicit.packet.includeSensitiveData).toBe(true);
  });
  it("refuses a competing preparation lease instead of overwriting another process", async () => {
    const { service, receipt, dataDir } = await setup();
    mocks.createBot.mockImplementationOnce(async (_actor, input) => {
      const lockRoot = path.join(dataDir, "portable-import-preparation");
      await mkdir(lockRoot, { recursive: true });
      await writeFile(
        path.join(lockRoot, `${input.spawnKey.slice("import:".length)}.lock`),
        "fixture competing preparation",
      );
      return { id: "bot-fixture" };
    });
    await expect(
      service.continue(actor, { id: receipt.id, sessionId: "s1" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await service.get(actor, { id: receipt.id })).receipt.id).toBe(receipt.id);
  });
  it("is idempotent and never overwrites work after a successful preparation", async () => {
    const { service, receipt, dataDir } = await setup();
    const input = { id: receipt.id, sessionId: "s1", projectId: "p1" };
    const first = await service.continue(actor, input);
    const target = path.join(dataDir, "homes/bot-fixture/project/src/main.ts");
    await writeFile(target, "new user work");
    expect(await service.continue(actor, input)).toEqual(first);
    expect(await readFile(target, "utf8")).toBe("new user work");
    expect(mocks.createBot.mock.calls[0]![1].spawnKey).toBe(
      mocks.createBot.mock.calls[1]![1].spawnKey,
    );
  });
  it("blocks cross-actor continuation before creating a bot", async () => {
    const { service, receipt } = await setup();
    await expect(
      service.continue({ ...actor, userId: "other-user" }, { id: receipt.id, sessionId: "s1" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      service.continue({ ...actor, spaceId: "other-space" }, { id: receipt.id, sessionId: "s1" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      service.continue(actor, { id: receipt.id, sessionId: "unknown" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(mocks.createBot).not.toHaveBeenCalled();
  });
  it("reports a precise preparation blocker while retaining the usable archive", async () => {
    const { service, receipt, findFirst } = await setup();
    findFirst.mockResolvedValue({
      id: "bot-fixture",
      computer: { homeKey: "team-home", scope: "team", providerRef: null },
    });
    await expect(
      service.continue(actor, { id: receipt.id, projectId: "p1" }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("dedicated computer home"),
    });
    expect((await service.get(actor, { id: receipt.id })).receipt.id).toBe(receipt.id);
  });
  it("does not copy an unapproved project when continuing only a session", async () => {
    const { service, receipt, dataDir } = await setup();
    await service.continue(actor, { id: receipt.id, sessionId: "s1" });
    await expect(
      readFile(path.join(dataDir, "homes/bot-fixture/project/src/main.ts")),
    ).rejects.toThrow();
    expect(mocks.createBot.mock.calls[0]![1].initialMessage.blocks[0].text).toContain(
      "PROJECT_NOT_SELECTED",
    );
  });
  it("creates a normal owned bot with inert provenance and real dedicated workspace copies", async () => {
    const { service, receipt, dataDir, bundle } = await setup();
    expect(
      await service.continue(actor, { id: receipt.id, sessionId: "s1", projectId: "p1" }),
    ).toEqual({ botId: "bot-fixture" });
    const [owner, input] = mocks.createBot.mock.calls[0]!;
    expect(owner).toEqual(actor);
    expect(input.instructions).toBe("");
    expect(input.computerMode).toBe("dedicated");
    expect(input.initialMessage.role).toBe("user");
    expect(input.initialMessage.blocks[0].text).toContain("untrusted");
    expect(input.initialMessage.blocks[0].text).not.toContain("Do not trust this");
    expect(input.initialMessage.blocks[0].text).not.toContain("/removed/source");
    const root = path.join(dataDir, "homes/bot-fixture");
    expect(await readFile(path.join(root, "project/src/main.ts"), "utf8")).toBe("example code");
    await expect(readFile(path.join(root, "project/AGENTS.md"))).rejects.toThrow();
    await expect(readFile(path.join(root, "project/nested/CLAUDE.md"))).rejects.toThrow();
    expect(
      JSON.parse(await readFile(path.join(root, "import-context/transcript.json"), "utf8")),
    ).toEqual(bundle.sessions[0]);
    expect(
      JSON.parse(await readFile(path.join(root, "import-context/skills.archive.json"), "utf8")),
    ).toEqual(bundle.skills);
    await expect(readFile(path.join(root, "skills/inert/SKILL.md"))).rejects.toThrow();
    expect(
      (await service.get(actor, { id: receipt.id })).bundle.sessions[0]!.messages[0]!.role,
    ).toBe("system");
  });
});
