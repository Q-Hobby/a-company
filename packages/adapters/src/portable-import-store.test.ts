import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { ImportPacket, PortableImportBundle } from "@acompany/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { PortableImportStore } from "./portable-import-store.js";
import { EncryptedSecretStore } from "./secrets.js";

const roots: string[] = [];
const owner = { userId: "fixture-user", spaceId: "fixture-space" };
function fixtureBundle(): PortableImportBundle {
  return {
    version: 1,
    exportedAt: "2026-01-01T00:00:00.000Z",
    warnings: [],
    projects: [
      {
        id: "p1",
        source: "codex",
        name: "Example",
        sourcePath: "/removed/source",
        files: [
          {
            path: "src/main.ts",
            contentBase64: Buffer.from("export const answer = 42;").toString("base64"),
          },
        ],
      },
    ],
    sessions: [
      {
        id: "s1",
        source: "codex",
        title: "Example chat",
        projectId: "p1",
        messages: [
          {
            id: "m1",
            role: "system",
            content: "Untrusted old instructions",
            original: { tool: "never replay" },
          },
        ],
      },
    ],
    skills: [
      {
        id: "k1",
        source: "hermes",
        name: "example",
        description: "Archived only",
        files: [
          { path: "SKILL.md", contentBase64: Buffer.from("# Inert skill").toString("base64") },
          { path: "scripts/run.sh", contentBase64: Buffer.from("exit 0").toString("base64") },
        ],
      },
    ],
  };
}
function packet(bundle: unknown): ImportPacket {
  return { encoding: "gzip-base64", data: gzipSync(JSON.stringify(bundle)).toString("base64") };
}
const all = { projectIds: ["p1"], sessionIds: ["s1"], skillIds: ["k1"] };

describe("untrusted packet boundary", () => {
  it.each([
    "../escape",
    "C:/escape",
    "foo\\bar",
    "CON.txt",
    "file.",
    "file ",
    "foo:stream",
    "bad?.ts",
    "bad|.ts",
    "bad\u007f.ts",
    "bad~1.ts",
  ])("rejects nonportable path %j", async (name) => {
    const { store } = await setup();
    const bundle = fixtureBundle();
    bundle.projects[0]!.files[0]!.path = name;
    expect(() => store.preview(packet(bundle))).toThrow();
  });
  it.each([
    ".env",
    "nested/.env.local",
    ".ssh/id_rsa",
    "auth.json",
    "credentials.json",
    ".git/config",
  ])("rejects credential/excluded path %j", async (name) => {
    const { store } = await setup();
    const bundle = fixtureBundle();
    bundle.projects[0]!.files[0]!.path = name;
    expect(() => store.preview(packet(bundle))).toThrow();
  });
  it.each(["SRC/main.ts", "src", "src/main.ts/child"])(
    "rejects file/directory aliases %j",
    async (name) => {
      const { store } = await setup();
      const bundle = fixtureBundle();
      bundle.projects[0]!.files.push({ path: name, contentBase64: "" });
      expect(() => store.preview(packet(bundle))).toThrow();
    },
  );
  it("rejects symlink metadata rather than silently dropping it", async () => {
    const { store } = await setup();
    const bundle = fixtureBundle();
    Object.assign(bundle.projects[0]!.files[0]!, { type: "symlink", target: "/escape" });
    expect(() => store.preview(packet(bundle))).toThrow();
  });
  it("rejects invalid base64 and malformed gzip", async () => {
    const { store } = await setup();
    const valid = packet(fixtureBundle());
    expect(() => store.preview({ ...valid, data: `${valid.data}\n` })).toThrow();
    expect(() => store.preview({ ...valid, data: "bm90LWd6aXA=" })).toThrow();
    const bundle = fixtureBundle();
    bundle.projects[0]!.files[0]!.contentBase64 = "%%%%";
    expect(() => store.preview(packet(bundle))).toThrow();
  });
  it("rejects decompression bombs", async () => {
    const { store } = await setup();
    const compressed = gzipSync(Buffer.alloc(64 * 1024 * 1024 + 1, 32)).toString("base64");
    expect(() => store.preview({ encoding: "gzip-base64", data: compressed })).toThrow();
  });
  it("rejects duplicate item ids and unknown selection ids", async () => {
    const { store } = await setup();
    const bundle = fixtureBundle();
    bundle.projects.push(bundle.projects[0]!);
    expect(() => store.preview(packet(bundle))).toThrow();
    await expect(
      store.commit(owner, packet(fixtureBundle()), { ...all, projectIds: ["unknown"] }),
    ).rejects.toThrow();
  });
  it("redacts text files and original metadata on the backend", async () => {
    const { store } = await setup();
    const bundle = fixtureBundle();
    const fake = `sk-${"a".repeat(48)}`;
    bundle.sessions[0]!.messages[0]!.content = `API_KEY=${fake}`;
    bundle.sessions[0]!.messages[0]!.original = { access_token: fake, nested: { note: fake } };
    bundle.projects[0]!.files[0]!.contentBase64 = Buffer.from(`key=${fake}`).toString("base64");
    const receipt = await store.commit(owner, packet(bundle), all);
    const archive = await store.get(owner, receipt.id);
    expect(JSON.stringify(archive)).not.toContain(fake);
    expect(
      Buffer.from(archive.bundle.projects[0]!.files[0]!.contentBase64, "base64").toString(),
    ).not.toContain(fake);
  });
});

describe("archive identity and scope", () => {
  it("redacts known opaque secrets in binary payloads without changing other bytes", async () => {
    const { store } = await setup();
    const bundle = fixtureBundle();
    const opaque = "fixture-opaque-private-value";
    bundle.sessions[0]!.original = { access_token: opaque };
    bundle.projects[0]!.files[0]!.path = "image.bin";
    bundle.projects[0]!.files[0]!.contentBase64 = Buffer.concat([
      Buffer.from([255, 0]),
      Buffer.from(opaque),
      Buffer.from([254]),
    ]).toString("base64");
    const receipt = await store.commit(owner, packet(bundle), all);
    const archive = await store.get(owner, receipt.id);
    const bytes = Buffer.from(archive.bundle.projects[0]!.files[0]!.contentBase64, "base64");
    expect(bytes.includes(Buffer.from(opaque))).toBe(false);
    expect(bytes[0]).toBe(255);
    expect(bytes.at(-1)).toBe(254);
  });
  it("redacts opaque known credential values everywhere, including project file text", async () => {
    const { store } = await setup();
    const bundle = fixtureBundle();
    const opaque = "fixture-opaque-private-value";
    bundle.sessions[0]!.original = { arguments: JSON.stringify({ access_token: opaque }) };
    bundle.sessions[0]!.messages[0]!.content = `Previously used ${opaque}`;
    bundle.projects[0]!.files[0]!.contentBase64 = Buffer.from(`value ${opaque}`).toString("base64");
    const receipt = await store.commit(owner, packet(bundle), all);
    const archive = await store.get(owner, receipt.id);
    expect(JSON.stringify(archive).includes(opaque)).toBe(false);
    expect(
      Buffer.from(archive.bundle.projects[0]!.files[0]!.contentBase64, "base64").includes(
        Buffer.from(opaque),
      ),
    ).toBe(false);
    expect(receipt.warnings).toContain("KNOWN_SECRETS_REDACTED");
  });
  it("deduplicates timestamps and file ordering but not content changes", async () => {
    const { store } = await setup();
    const bundle = fixtureBundle();
    const first = await store.commit(owner, packet(bundle), all);
    bundle.exportedAt = "2026-02-01T00:00:00.000Z";
    bundle.skills[0]!.files.reverse();
    expect(await store.commit(owner, packet(bundle), all)).toEqual(first);
    bundle.sessions[0]!.messages[0]!.content = "changed";
    expect((await store.commit(owner, packet(bundle), all)).id).not.toBe(first.id);
  });
  it("does not leak across user or space and ignores unknown host paths", async () => {
    const { store } = await setup();
    const receipt = await store.commit(owner, packet(fixtureBundle()), all);
    for (const other of [
      { ...owner, userId: "other" },
      { ...owner, spaceId: "other" },
    ]) {
      expect(await store.list(other)).toEqual([]);
      await expect(store.get(other, receipt.id)).rejects.toThrow();
      await expect(store.export(other, receipt.id)).rejects.toThrow();
    }
    await expect(store.get(owner, "../escape")).rejects.toThrow();
  });
});
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "portable-import-test-"));
  roots.push(root);
  return { root, store: new PortableImportStore(root) };
}
describe("sensitive data explicit consent", () => {
  function sensitiveInput() {
    const bundle = fixtureBundle();
    const fake = "fixture-private-login-value";
    bundle.includeSensitiveData = true;
    bundle.sessions[0]!.messages[0]!.content = `Previously used ${fake}`;
    bundle.projects[0]!.files.push({
      path: ".env",
      contentBase64: Buffer.from(`ACCESS_TOKEN=${fake}`).toString("base64"),
    });
    bundle.sensitiveSources = [
      {
        id: "credentials-1",
        source: "codex",
        name: "Codex credentials",
        files: [
          {
            path: "auth.json",
            contentBase64: Buffer.from(
              JSON.stringify({ access_token: "other-fixture-credential" }),
            ).toString("base64"),
          },
        ],
      },
    ];
    return {
      bundle,
      fake,
      input: { ...packet(bundle), includeSensitiveData: true },
      selection: { ...all, includeSensitiveData: true, sensitiveSourceIds: ["credentials-1"] },
    };
  }
  it("supports credential-only selection without activating a runtime", async () => {
    const { root } = await setup();
    const store = new PortableImportStore(root, new EncryptedSecretStore("fixture-encryption-key"));
    const { input, fake } = sensitiveInput();
    const receipt = await store.commit(owner, input, {
      projectIds: [],
      sessionIds: [],
      skillIds: [],
      includeSensitiveData: true,
      sensitiveSourceIds: ["credentials-1"],
    });
    expect(receipt.projectCount).toBe(0);
    expect(receipt.sessionCount).toBe(0);
    expect(receipt.skillCount).toBe(0);
    expect(receipt.sensitiveFileCount).toBe(1);
    const downloaded = await store.export(owner, receipt.id, true);
    const raw = JSON.parse(gunzipSync(Buffer.from(downloaded.packet.data, "base64")).toString());
    expect(raw.projects).toEqual([]);
    expect(raw.sessions).toEqual([]);
    expect(raw.skills).toEqual([]);
    expect(raw.sensitiveSources).toHaveLength(1);
    expect(JSON.stringify(await store.get(owner, receipt.id)).includes(fake)).toBe(false);
    expect(await store.files(owner, receipt.id)).toEqual([]);
  });
  it("requires matching packet, embedded and selection opt-in plus encryption", async () => {
    const { root, store } = await setup();
    const { bundle, input, selection } = sensitiveInput();
    const encrypted = new PortableImportStore(
      root,
      new EncryptedSecretStore("fixture-encryption-key"),
    );
    await expect(encrypted.commit(owner, input, all)).rejects.toThrow();
    await expect(
      encrypted.commit(owner, { ...input, includeSensitiveData: false }, selection),
    ).rejects.toThrow();
    bundle.includeSensitiveData = false;
    await expect(
      encrypted.commit(owner, { ...packet(bundle), includeSensitiveData: true }, selection),
    ).rejects.toThrow();
    await expect(store.commit(owner, input, selection)).rejects.toThrow();
    expect(await store.list(owner)).toEqual([]);
  });
  it("encrypts actual originals while ordinary reads and workspace files remain safe", async () => {
    const { root } = await setup();
    const crypto = new EncryptedSecretStore("fixture-encryption-key");
    const store = new PortableImportStore(root, crypto);
    const { input, selection, fake } = sensitiveInput();
    const preview = store.preview(input);
    expect(preview.includeSensitiveData).toBe(true);
    expect(preview.sensitiveSources?.[0]?.fileCount).toBe(1);
    expect(JSON.stringify(preview).includes(fake)).toBe(false);
    const receipt = await store.commit(owner, input, selection);
    expect(receipt.includeSensitiveData).toBe(true);
    expect(receipt.sensitiveFileCount).toBe(2);
    const safe = await store.get(owner, receipt.id);
    expect(JSON.stringify(safe).includes(fake)).toBe(false);
    expect(safe.bundle.projects[0]!.files.some((file) => file.path === ".env")).toBe(false);
    expect(safe.bundle.sensitiveSources?.some((item) => item.files.length > 0) ?? false).toBe(
      false,
    );
    const names = await readdir(root, { recursive: true });
    for (const name of names) {
      const bytes = await readFile(path.join(root, name)).catch(() => null);
      if (bytes) {
        expect(bytes.includes(Buffer.from(fake))).toBe(false);
        expect(
          bytes.includes(Buffer.from(Buffer.from(`ACCESS_TOKEN=${fake}`).toString("base64"))),
        ).toBe(false);
      }
    }
    const encryptedPath = names.find((name) => name.endsWith("sensitive.enc.json"))!;
    const encrypted = JSON.parse(await readFile(path.join(root, encryptedPath), "utf8"));
    const plaintext = crypto.load(encrypted.ciphertext, encrypted.id);
    expect(plaintext.includes(fake)).toBe(true);
    const ordinary = await store.export(owner, receipt.id);
    expect(gunzipSync(Buffer.from(ordinary.packet.data, "base64")).toString().includes(fake)).toBe(
      false,
    );
    const explicit = await store.export(owner, receipt.id, true);
    expect(gunzipSync(Buffer.from(explicit.packet.data, "base64")).toString().includes(fake)).toBe(
      true,
    );
    expect(explicit.packet.includeSensitiveData).toBe(true);
    await expect(store.export({ ...owner, userId: "other" }, receipt.id, true)).rejects.toThrow();
    const again = await store.commit(
      owner,
      {
        ...input,
        data: packet({ ...sensitiveInput().bundle, exportedAt: "2026-02-01T00:00:00.000Z" }).data,
      },
      selection,
    );
    expect(again.id).toBe(receipt.id);
  });
});
describe("portable immutable archive", () => {
  it("never follows a preexisting archive-root junction", async () => {
    const { root, store } = await setup();
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await symlink(outside, path.join(root, "portable-imports"), "junction");
    await expect(store.commit(owner, packet(fixtureBundle()), all)).rejects.toThrow(
      "Unsafe archive storage path",
    );
    await expect(store.list(owner)).rejects.toThrow("Unsafe archive storage path");
  });
  it("detects archived file tampering and does not repair or overwrite the archive", async () => {
    const { store } = await setup();
    const input = packet(fixtureBundle());
    const receipt = await store.commit(owner, input, all);
    const files = await store.files(owner, receipt.id);
    await writeFile(files[0]!.archivePath, "tampered");
    await expect(store.get(owner, receipt.id)).rejects.toThrow("integrity");
    await expect(store.commit(owner, input, all)).rejects.toThrow("integrity");
    expect(await readFile(files[0]!.archivePath, "utf8")).toBe("tampered");
  });
  it("handles concurrent commits without replacing the winner", async () => {
    const { store } = await setup();
    const input = packet(fixtureBundle());
    const receipts = await Promise.all(
      Array.from({ length: 4 }, () => store.commit(owner, input, all)),
    );
    expect(receipts.every((item) => JSON.stringify(item) === JSON.stringify(receipts[0]))).toBe(
      true,
    );
    expect(await store.list(owner)).toHaveLength(1);
  });
  it("exports independent bytes after the fixture source directory is deleted", async () => {
    const { root, store } = await setup();
    const source = path.join(root, "fixture-source");
    await mkdir(source);
    await writeFile(path.join(source, "main.ts"), "source content");
    const bundle = fixtureBundle();
    bundle.projects[0]!.sourcePath = source;
    bundle.projects[0]!.files[0]!.contentBase64 = (
      await readFile(path.join(source, "main.ts"))
    ).toString("base64");
    const receipt = await store.commit(owner, packet(bundle), all);
    await rm(source, { recursive: true });
    const exported = await store.export(owner, receipt.id);
    expect(store.preview(exported.packet).projects[0]!.fileCount).toBe(1);
    const archive = await store.get(owner, receipt.id);
    expect(
      Buffer.from(archive.bundle.projects[0]!.files[0]!.contentBase64, "base64").toString(),
    ).toBe("source content");
  });
  it("persists independent selected content and reads it after a store restart", async () => {
    const { root, store } = await setup();
    const input = fixtureBundle();
    const receipt = await store.commit(owner, packet(input), all);
    const restarted = new PortableImportStore(root);
    expect(await restarted.get(owner, receipt.id)).toEqual({ receipt, bundle: input });
    expect(await restarted.list(owner)).toEqual([receipt]);
    const exported = await restarted.export(owner, receipt.id);
    expect(store.preview(exported.packet).projects[0]?.fileCount).toBe(1);
    const files = await restarted.files(owner, receipt.id);
    expect(files.find((file) => file.path.endsWith("src/main.ts"))?.bytes.toString()).toBe(
      "export const answer = 42;",
    );
    expect(await readFile(files[0]!.archivePath)).toEqual(files[0]!.bytes);
  });
});
