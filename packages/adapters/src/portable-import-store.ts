import { isUtf8 } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { ImportPacket, ImportSelection, PortableImportBundle } from "@acompany/contracts";
import {
  ImportArchiveSchema,
  ImportFileSchema,
  ImportPacketSchema,
  ImportSelectionSchema,
  ImportSensitiveSourceSchema,
  PORTABLE_IMPORT_MAX_FILE_BYTES,
  PORTABLE_IMPORT_MAX_UNPACKED_BYTES,
  PortableImportBundleSchema,
} from "@acompany/contracts";
import {
  isExcludedImportPath,
  redactImportText,
  sanitizeImportValue,
} from "./local-import/security.js";

import type { EncryptedSecretStore } from "./secrets.js";

type Owner = { userId: string; spaceId: string };
type Archive = ReturnType<typeof ImportArchiveSchema.parse>;
const invalid = () => new Error("Invalid portable import packet");
function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
function compare(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => compare(a, b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function contentId(bundle: PortableImportBundle) {
  const { exportedAt: _exportedAt, ...content } = bundle;
  return digest(canonical(content));
}
function base64(value: string): Buffer {
  if (
    value.length % 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  )
    throw invalid();
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw invalid();
  return bytes;
}
function decode(packet: ImportPacket, rawOnly = false): PortableImportBundle {
  try {
    const parsed = ImportPacketSchema.parse(packet);
    const output = gunzipSync(base64(parsed.data), {
      maxOutputLength: PORTABLE_IMPORT_MAX_UNPACKED_BYTES,
    });
    if (!isUtf8(output)) throw invalid();
    // Reject link/mode metadata before stripping unknown properties.
    const raw = PortableImportBundleSchema.extend({
      projects: PortableImportBundleSchema.shape.projects.element
        .extend({ files: ImportFileSchema.strict().array().max(10000) })
        .array()
        .max(100),
      skills: PortableImportBundleSchema.shape.skills.element
        .extend({ files: ImportFileSchema.strict().array().max(1000) })
        .array()
        .max(1000),
      sensitiveSources: ImportSensitiveSourceSchema.extend({
        files: ImportFileSchema.strict().array().max(1000),
      })
        .array()
        .max(100)
        .optional(),
    }).parse(JSON.parse(output.toString("utf8")));
    const sensitive = parsed.includeSensitiveData === true;
    if (
      sensitive !== (raw.includeSensitiveData === true) ||
      (!sensitive && (raw.sensitiveSources?.length ?? 0) > 0)
    )
      throw invalid();
    for (const collection of [raw.projects, raw.sessions, raw.skills, raw.sensitiveSources ?? []]) {
      if (new Set(collection.map((item) => item.id)).size !== collection.length) throw invalid();
    }
    const known = new Set<string>();
    function collect(value: unknown, depth = 0) {
      if (depth > 40) throw invalid();
      if (typeof value === "string" && /^\s*[[{]/.test(value)) {
        try {
          collect(JSON.parse(value), depth + 1);
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
        }
        return;
      }
      if (typeof value === "string") {
        for (const match of value.matchAll(
          /(?:^|\n)\s*(?:export\s+)?([A-Za-z0-9_.-]+)\s*=\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s#\r\n]+))/g,
        )) {
          const key = match[1]!;
          const secret = match[2] ?? match[3] ?? match[4];
          if (
            secret &&
            secret !== "[REDACTED]" &&
            (sanitizeImportValue({ [key]: "fixture-probe" }) as Record<string, unknown>)[key] ===
              "[REDACTED]"
          )
            known.add(secret);
        }
      }
      if (!value || typeof value !== "object") return;
      for (const [key, nested] of Object.entries(value)) {
        if (
          typeof nested === "string" &&
          nested &&
          nested !== "[REDACTED]" &&
          (sanitizeImportValue({ [key]: "fixture-probe" }) as Record<string, unknown>)[key] ===
            "[REDACTED]"
        )
          known.add(nested);
        else if (key !== "contentBase64") collect(nested, depth + 1);
      }
    }
    collect(raw);
    for (const item of [...raw.projects, ...raw.skills, ...(raw.sensitiveSources ?? [])]) {
      for (const file of item.files) {
        const bytes = base64(file.contentBase64);
        if (isUtf8(bytes)) collect(bytes.toString("utf8"));
      }
    }
    const values = [...known].sort((a, b) => b.length - a.length);
    const redactKnown = (text: string) =>
      values.reduce((result, secret) => result.split(secret).join("[REDACTED]"), text);
    function cleanKnown(value: unknown): unknown {
      if (typeof value === "string") return redactKnown(value);
      if (Array.isArray(value)) return value.map(cleanKnown);
      if (value && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value).map(([key, nested]) => [key, cleanKnown(nested)]),
        );
      return value;
    }
    let total = 0;
    let redacted = false;
    for (const item of [...raw.projects, ...raw.skills, ...(raw.sensitiveSources ?? [])]) {
      const files = new Set<string>();
      const dirs = new Map<string, string>();
      for (const file of item.files) {
        if (
          /[<>"|?*\x7f~]/.test(file.path) ||
          file.path !== file.path.normalize("NFC") ||
          file.path.split("/").some((part) => Buffer.byteLength(part) > 240) ||
          isExcludedImportPath(file.path, sensitive)
        )
          throw invalid();
        const key = file.path.toLowerCase();
        const parts = file.path.split("/");
        if (files.has(key) || dirs.has(key)) throw invalid();
        for (let i = 1; i < parts.length; i++) {
          const parent = parts.slice(0, i).join("/");
          const folded = parent.toLowerCase();
          if (files.has(folded) || (dirs.has(folded) && dirs.get(folded) !== parent))
            throw invalid();
          dirs.set(folded, parent);
        }
        files.add(key);
        const bytes = base64(file.contentBase64);
        total += bytes.length;
        if (
          bytes.length > PORTABLE_IMPORT_MAX_FILE_BYTES ||
          total > PORTABLE_IMPORT_MAX_UNPACKED_BYTES
        )
          throw invalid();
        if (rawOnly) continue;
        if (isUtf8(bytes)) {
          const text = bytes.toString("utf8");
          const cleaned = redactImportText(redactKnown(text));
          if (cleaned !== text) redacted = true;
          file.contentBase64 = Buffer.from(cleaned).toString("base64");
        } else {
          const original = bytes.toString("latin1");
          const cleaned = values.reduce(
            (result, secret) =>
              result.split(Buffer.from(secret, "utf8").toString("latin1")).join("[REDACTED]"),
            original,
          );
          if (cleaned !== original) redacted = true;
          file.contentBase64 = Buffer.from(cleaned, "latin1").toString("base64");
        }
      }
      item.files.sort((a, b) => compare(a.path, b.path));
    }
    if (rawOnly) {
      for (const items of [raw.projects, raw.sessions, raw.skills, raw.sensitiveSources ?? []])
        items.sort((a, b) => compare(a.id, b.id));
      raw.warnings = [...new Set(raw.warnings)].sort(compare);
      return raw;
    }
    for (const item of [...raw.projects, ...raw.skills])
      item.files = item.files.filter((file) => !isExcludedImportPath(file.path));
    // Generic sanitization applies only to text/metadata, never base64.
    const metadata = {
      ...raw,
      projects: raw.projects.map(({ files: _files, ...item }) => item),
      skills: raw.skills.map(({ files: _files, ...item }) => item),
      ...(raw.sensitiveSources
        ? {
            sensitiveSources: raw.sensitiveSources.map(({ files: _files, ...item }) => ({
              ...item,
              files: [],
            })),
          }
        : {}),
    };
    const clean = sanitizeImportValue(cleanKnown(metadata)) as typeof metadata;
    if (canonical(clean) !== canonical(metadata)) redacted = true;
    const bundle = PortableImportBundleSchema.parse({
      ...clean,
      projects: clean.projects.map((item, i) => ({ ...item, files: raw.projects[i]!.files })),
      skills: clean.skills.map((item, i) => ({ ...item, files: raw.skills[i]!.files })),
    });
    for (const items of [bundle.projects, bundle.sessions, bundle.skills])
      items.sort((a, b) => compare(a.id, b.id));
    if (redacted) bundle.warnings.push("KNOWN_SECRETS_REDACTED");
    bundle.warnings = [...new Set(bundle.warnings)].sort(compare);
    return bundle;
  } catch {
    throw invalid();
  }
}
function entries(bundle: PortableImportBundle) {
  return [
    ...bundle.projects.map((item) => ({ ...item, kind: "projects" })),
    ...bundle.skills.map((item) => ({ ...item, kind: "skills" })),
  ].flatMap((item) =>
    item.files.map((file) => ({
      path: `${item.kind}/${digest(item.id)}/${file.path}`,
      bytes: Buffer.from(file.contentBase64, "base64"),
    })),
  );
}
export class PortableImportStore {
  constructor(
    private readonly dataDir: string,
    private readonly secrets?: Pick<EncryptedSecretStore, "put" | "load">,
  ) {}
  private directory(owner: Owner) {
    return path.join(
      this.dataDir,
      "portable-imports",
      digest(JSON.stringify([owner.spaceId, owner.userId])),
    );
  }
  private target(owner: Owner, id: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid import id");
    return path.join(this.directory(owner), id);
  }
  private async securePath(target: string, create = false) {
    if (create) await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const root = await realpath(this.dataDir);
    const relative = path.relative(path.resolve(this.dataDir), path.resolve(target));
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw invalid();
    let current = root;
    for (const part of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      if (create)
        await mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        });
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory())
        throw new Error("Unsafe archive storage path");
    }
  }
  private async read(
    target: string,
    maxBytes = PORTABLE_IMPORT_MAX_UNPACKED_BYTES,
  ): Promise<Buffer> {
    await this.securePath(path.dirname(target));
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1 || info.size > maxBytes)
      throw new Error("Unsafe archive file");
    const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }
  private async write(target: string, bytes: string | Buffer) {
    await this.securePath(path.dirname(target), true);
    const handle = await open(target, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  preview(packet: ImportPacket) {
    const bundle = decode(packet);
    const raw = bundle.includeSensitiveData ? decode(packet, true) : bundle;
    return {
      projects: bundle.projects.map(({ files, ...item }) => ({ ...item, fileCount: files.length })),
      sessions: bundle.sessions.map(({ messages, original: _original, ...item }) => ({
        ...item,
        messageCount: messages.length,
      })),
      skills: bundle.skills.map(({ files, ...item }) => ({ ...item, fileCount: files.length })),
      warnings: bundle.warnings,
      ...(bundle.includeSensitiveData
        ? {
            includeSensitiveData: true,
            sensitiveSources:
              bundle.sensitiveSources?.map(({ files: _files, ...item }) => ({
                ...item,
                fileCount:
                  raw.sensitiveSources?.find((source) => source.id === item.id)?.files.length ?? 0,
              })) ?? [],
          }
        : {}),
    };
  }
  async commit(owner: Owner, packet: ImportPacket, selection: ImportSelection) {
    const input = decode(packet);
    const selected = ImportSelectionSchema.parse(selection);
    const sensitive = input.includeSensitiveData === true;
    if (
      sensitive !== (selected.includeSensitiveData === true) ||
      (!sensitive && (selected.sensitiveSourceIds?.length ?? 0) > 0)
    )
      throw new Error("Sensitive import requires matching explicit consent");
    if (sensitive && !this.secrets) throw new Error("Sensitive import requires encrypted storage");
    for (const [ids, items] of [
      [selected.projectIds, input.projects],
      [selected.sessionIds, input.sessions],
      [selected.skillIds, input.skills],
      [selected.sensitiveSourceIds ?? [], input.sensitiveSources ?? []],
    ] as const) {
      if (
        new Set(ids).size !== ids.length ||
        ids.some((id) => !items.some((item) => item.id === id))
      )
        throw new Error("Invalid import selection");
    }
    const bundle = {
      ...input,
      projects: input.projects.filter((item) => selected.projectIds.includes(item.id)),
      sessions: input.sessions.filter((item) => selected.sessionIds.includes(item.id)),
      skills: input.skills.filter((item) => selected.skillIds.includes(item.id)),
      ...(input.sensitiveSources
        ? {
            sensitiveSources: input.sensitiveSources.filter((item) =>
              selected.sensitiveSourceIds?.includes(item.id),
            ),
          }
        : {}),
    };
    if (
      bundle.sessions.some(
        (session) => session.projectId && !selected.projectIds.includes(session.projectId),
      )
    )
      bundle.warnings = [...new Set([...bundle.warnings, "PROJECT_NOT_SELECTED"])].sort(compare);
    const rawInput = sensitive ? decode(packet, true) : null;
    const rawBundle = rawInput
      ? {
          ...rawInput,
          projects: rawInput.projects.filter((item) => selected.projectIds.includes(item.id)),
          sessions: rawInput.sessions.filter((item) => selected.sessionIds.includes(item.id)),
          skills: rawInput.skills.filter((item) => selected.skillIds.includes(item.id)),
          sensitiveSources: (rawInput.sensitiveSources ?? []).filter((item) =>
            selected.sensitiveSourceIds?.includes(item.id),
          ),
        }
      : null;
    const sensitiveDigest = rawBundle ? contentId(rawBundle) : undefined;
    const id = sensitiveDigest
      ? digest(`${contentId(bundle)}:${sensitiveDigest}`)
      : contentId(bundle);
    const target = this.target(owner, id);
    await this.securePath(this.directory(owner), true);
    const existing = await this.get(owner, id).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (existing) {
      if (sensitive) await this.export(owner, id, true);
      return existing.receipt;
    }
    const receipt = {
      id,
      importedAt: new Date().toISOString(),
      projectCount: bundle.projects.length,
      sessionCount: bundle.sessions.length,
      skillCount: bundle.skills.length,
      warnings: bundle.warnings,
      ...(sensitive
        ? {
            includeSensitiveData: true,
            sensitiveFileCount:
              (rawBundle?.sensitiveSources.reduce((count, item) => count + item.files.length, 0) ??
                0) +
              [...(rawBundle?.projects ?? []), ...(rawBundle?.skills ?? [])].reduce(
                (count, item) =>
                  count + item.files.filter((file) => isExcludedImportPath(file.path)).length,
                0,
              ),
          }
        : {}),
    };
    const staging = path.join(this.directory(owner), `.staging-${randomUUID()}`);
    await this.securePath(staging, true);
    try {
      for (const file of entries(bundle)) {
        const destination = path.join(staging, "files", file.path);
        await this.write(destination, file.bytes);
      }
      if (rawBundle && this.secrets) {
        const recordId = `portable-import:${digest(JSON.stringify([owner.spaceId, owner.userId]))}:${id}`;
        const plaintext = JSON.stringify(rawBundle);
        const context = {
          operationId: recordId,
          traceId: recordId,
          spaceId: owner.spaceId,
          userId: owner.userId,
          botId: "portable-import-archive",
          signal: new AbortController().signal,
        };
        const encrypted = await this.secrets.put(plaintext, context, recordId);
        if (
          encrypted.id !== recordId ||
          this.secrets.load(encrypted.ciphertext, recordId) !== plaintext
        )
          throw new Error("Sensitive archive encryption verification failed");
        await this.write(path.join(staging, "sensitive.enc.json"), JSON.stringify(encrypted));
      }
      await this.write(
        path.join(staging, "archive.json"),
        JSON.stringify({ receipt, bundle, ...(sensitiveDigest ? { sensitiveDigest } : {}) }),
      );
      try {
        await rename(staging, target);
      } catch (error) {
        if (!(await this.get(owner, id).catch(() => null))) throw error;
      }
      const stored = await this.get(owner, id);
      if (sensitive) await this.export(owner, id, true);
      return stored.receipt;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  async get(owner: Owner, id: string): Promise<Archive> {
    const internal = JSON.parse(
      (await this.read(path.join(this.target(owner, id), "archive.json"))).toString("utf8"),
    );
    const archive = ImportArchiveSchema.parse(internal);
    const expected = internal.sensitiveDigest
      ? digest(`${contentId(archive.bundle)}:${internal.sensitiveDigest}`)
      : contentId(archive.bundle);
    if (archive.receipt.id !== id || expected !== id)
      throw new Error("Archive integrity check failed");
    for (const file of entries(archive.bundle)) {
      const actual = await this.read(path.join(this.target(owner, id), "files", file.path));
      if (!actual.equals(file.bytes)) throw new Error("Archive integrity check failed");
    }
    return archive;
  }
  async list(owner: Owner) {
    await this.securePath(this.directory(owner)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    const names = await readdir(this.directory(owner)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    return Promise.all(
      names
        .filter((name) => /^[a-f0-9]{64}$/.test(name))
        .sort()
        .map(async (id) => (await this.get(owner, id)).receipt),
    );
  }
  async export(
    owner: Owner,
    id: string,
    includeSensitiveData = false,
  ): Promise<{ packet: ImportPacket }> {
    const archive = await this.get(owner, id);
    let bundle = archive.bundle;
    if (includeSensitiveData && archive.receipt.includeSensitiveData) {
      if (!this.secrets)
        throw new Error("Sensitive export requires the configured encryption store");
      const internal = JSON.parse(
        (await this.read(path.join(this.target(owner, id), "archive.json"))).toString("utf8"),
      );
      const encrypted = JSON.parse(
        (
          await this.read(
            path.join(this.target(owner, id), "sensitive.enc.json"),
            PORTABLE_IMPORT_MAX_UNPACKED_BYTES * 2,
          )
        ).toString("utf8"),
      );
      const recordId = `portable-import:${digest(JSON.stringify([owner.spaceId, owner.userId]))}:${id}`;
      if (encrypted.id !== recordId) throw new Error("Sensitive archive integrity check failed");
      bundle = PortableImportBundleSchema.parse(
        JSON.parse(this.secrets.load(encrypted.ciphertext, recordId)),
      );
      if (contentId(bundle) !== internal.sensitiveDigest)
        throw new Error("Sensitive archive integrity check failed");
    } else if (bundle.includeSensitiveData) {
      bundle = {
        ...bundle,
        includeSensitiveData: false,
        sensitiveSources: [],
        warnings: bundle.warnings.filter(
          (warning) => warning !== "SENSITIVE_DATA_INCLUDED_INACTIVE",
        ),
      };
    }
    return {
      packet: ImportPacketSchema.parse({
        encoding: "gzip-base64",
        data: gzipSync(JSON.stringify(bundle)).toString("base64"),
        ...(bundle.includeSensitiveData ? { includeSensitiveData: true } : {}),
      }),
    };
  }
  async files(owner: Owner, id: string) {
    const archive = await this.get(owner, id);
    return entries(archive.bundle).map((file) => ({
      ...file,
      archivePath: path.join(this.target(owner, id), "files", file.path),
    }));
  }
}
