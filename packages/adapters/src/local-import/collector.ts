import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gzipSync } from "node:zlib";
import type {
  ImportFile,
  ImportPacket,
  ImportProject,
  ImportSelection,
  ImportSensitiveSource,
  ImportSession,
  ImportSkill,
  LocalImportScan,
  LocalImportSource,
  PortableImportBundle,
} from "@acompany/contracts";
import {
  ImportSelectionSchema,
  LocalImportScanSchema,
  PORTABLE_IMPORT_MAX_FILE_BYTES,
  PORTABLE_IMPORT_MAX_PACKET_CHARS,
  PORTABLE_IMPORT_MAX_UNPACKED_BYTES,
  PortableImportBundleSchema,
} from "@acompany/contracts";
import { isExcludedImportPath, redactImportText, sanitizeImportValue } from "./security.js";

type Row = Record<string, unknown>;
type SessionEntry = {
  summary: LocalImportScan["sessions"][number];
  sourceRoot: string;
  sourceFile: string;
  nativeId: string;
  metadata: Row;
};
type ProjectEntry = { summary: LocalImportScan["projects"][number]; directory: string };
type SkillEntry = { summary: LocalImportScan["skills"][number]; directory: string };
type SensitiveEntry = {
  summary: NonNullable<LocalImportScan["sensitiveSources"]>[number];
  directory: string;
  files: string[];
};
type Index = {
  sensitiveSources: Map<string, SensitiveEntry>;
  projects: Map<string, ProjectEntry>;
  sessions: Map<string, SessionEntry>;
  skills: Map<string, SkillEntry>;
  warnings: Set<string>;
};
const MAX_SCAN_ENTRIES = 10_000;
const MAX_SESSIONS = 1000;
const MAX_SESSION_FILE_BYTES = 32 * 1024 * 1024;
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sourceId = (source: LocalImportSource, kind: string, key: string) =>
  `${source}-${createHash("sha256").update(`${kind}\0${key}`).digest("hex")}`;
const row = (value: unknown): Row =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
const string = (value: unknown): string => (typeof value === "string" ? value : "");
const safeTitle = (value: unknown, fallback: string, max = 500) =>
  redactImportText(string(value).trim() || fallback).slice(0, max);

function isInside(root: string, file: string) {
  const relative = path.relative(root, file);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}
async function directory(candidate: string): Promise<string | undefined> {
  try {
    const info = await lstat(candidate);
    if (!info.isDirectory() || info.isSymbolicLink()) return undefined;
    return await realpath(candidate);
  } catch {
    return undefined;
  }
}
async function safeSourceFile(file: string, root: string) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1)
    throw new Error("Source is not a regular independent file.");
  const resolved = await realpath(file);
  if (!isInside(root, resolved)) throw new Error("Source is outside the approved directory.");
  return { info, resolved };
}
async function readSource(
  file: string,
  root: string,
  maxBytes: number,
  prefix = false,
): Promise<Buffer> {
  const { info, resolved } = await safeSourceFile(file, root);
  if (!prefix && info.size > maxBytes)
    throw new Error("Selected import data exceeds the size limit. Select fewer items.");
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (opened.ino !== info.ino || opened.dev !== info.dev || (await realpath(file)) !== resolved)
      throw new Error("Source changed during reading.");
    const size = Math.min(info.size, maxBytes);
    const result = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await handle.read(result, offset, size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      (await realpath(file)) !== resolved
    )
      throw new Error("Source changed during reading.");
    return result.subarray(0, offset);
  } finally {
    await handle.close();
  }
}
async function entries(directoryPath: string) {
  return (await readdir(directoryPath, { withFileTypes: true })).sort((a, b) =>
    order(a.name, b.name),
  );
}
function iso(value: unknown): string | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const date = new Date(typeof value === "number" ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
function sqliteColumns(db: DatabaseSync, table: "sessions" | "messages") {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map((item) => string(item.name)),
  );
}
async function readDatabase<T>(
  file: string,
  root: string,
  action: (database: DatabaseSync) => T,
): Promise<T> {
  await safeSourceFile(file, root);
  const db = new DatabaseSync(file, { readOnly: true, allowExtension: false });
  try {
    db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 2000; BEGIN;");
    return action(db);
  } finally {
    db.close();
  }
}
function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value
      .map((part) => {
        const item = row(part);
        return typeof item.text === "string" ? item.text : JSON.stringify(part);
      })
      .join("\n");
  return value == null ? "" : JSON.stringify(value);
}

export function createLocalImportCollector(
  options: { homeDir?: string; env?: NodeJS.ProcessEnv } = {},
) {
  const home = path.resolve(options.homeDir ?? homedir());
  const env = options.env ?? process.env;
  let current: Index | undefined;

  async function registerProject(index: Index, source: LocalImportSource, candidate: unknown) {
    if (typeof candidate !== "string" || !path.isAbsolute(candidate)) return undefined;
    const resolved = await directory(candidate);
    if (!resolved || resolved === path.parse(resolved).root || resolved === home) {
      index.warnings.add("SOURCE_UNAVAILABLE");
      return undefined;
    }
    // A session started in a credentials/profile/system directory is not a project.
    if (
      resolved
        .split(path.sep)
        .some((part) =>
          /^(?:\.hermes|\.codex|\.ssh|\.aws|windows|program files(?: \(x86\))?)$/i.test(part),
        ) ||
      [path.join(home, "AppData"), env.APPDATA, env.LOCALAPPDATA].some(
        (reserved) => reserved && path.resolve(reserved) === resolved,
      )
    ) {
      index.warnings.add("SOURCE_UNAVAILABLE");
      return undefined;
    }
    if (index.projects.size >= 100) {
      index.warnings.add("SCAN_LIMIT_REACHED");
      return undefined;
    }
    const id = sourceId(source, "project", resolved);
    index.projects.set(id, {
      directory: resolved,
      summary: {
        id,
        source,
        name: safeTitle(path.basename(resolved), "Project", 200),
        sourcePath: redactImportText(resolved),
        fileCount: null,
      },
    });
    return id;
  }

  async function scanSkills(index: Index, source: LocalImportSource, skillRoot: string) {
    const found = await directory(skillRoot);
    if (!found) return;
    const root: string = found;
    let visited = 0;
    async function walk(dir: string, depth: number): Promise<void> {
      if (depth > 5 || ++visited > MAX_SCAN_ENTRIES || index.skills.size >= 1000) {
        index.warnings.add("SCAN_LIMIT_REACHED");
        return;
      }
      for (const item of await entries(dir)) {
        if (item.isSymbolicLink()) {
          index.warnings.add("SYMLINKS_EXCLUDED");
          continue;
        }
        if (!item.isFile() || item.name !== "SKILL.md") continue;
        try {
          const content = (
            await readSource(path.join(dir, item.name), root, PORTABLE_IMPORT_MAX_FILE_BYTES)
          ).toString("utf8");
          const id = sourceId(source, "skill", dir);
          const declaredName = /^name:\s*["']?([^\r\n"']+)/m.exec(content)?.[1];
          const description = /^description:\s*["']?([^\r\n"']+)/m.exec(content)?.[1];
          index.skills.set(id, {
            directory: dir,
            summary: {
              id,
              source,
              name: safeTitle(declaredName, path.basename(dir), 200),
              description: safeTitle(description, "", 4000),
              fileCount: null,
            },
          });
        } catch {
          index.warnings.add("SOURCE_UNAVAILABLE");
        }
        return;
      }
      for (const item of await entries(dir)) {
        if (item.isDirectory() && !item.isSymbolicLink() && !isExcludedImportPath(item.name))
          await walk(path.join(dir, item.name), depth + 1);
      }
    }
    await walk(root, 0);
  }

  async function scanHermes(index: Index, root: string) {
    const file = path.join(root, "state.db");
    try {
      const sessions = await readDatabase(file, root, (db) => {
        const columns = sqliteColumns(db, "sessions");
        if (!columns.has("id")) throw new Error("Unsupported source format.");
        const selected = [
          "id",
          "title",
          "source",
          "cwd",
          "git_repo_root",
          "git_branch",
          "model",
          "parent_session_id",
          "started_at",
          "ended_at",
          "message_count",
          "profile_name",
          "archived",
          "hidden",
          "pinned",
        ].filter((column) => columns.has(column));
        return db
          .prepare(
            `SELECT ${selected.join(", ")} FROM sessions ORDER BY ${columns.has("started_at") ? "started_at DESC, " : ""}id LIMIT 1001`,
          )
          .all() as Row[];
      });
      for (const metadata of sessions) {
        if (index.sessions.size >= MAX_SESSIONS) {
          index.warnings.add("SCAN_LIMIT_REACHED");
          break;
        }
        const nativeId = string(metadata.id);
        if (!nativeId) continue;
        const id = sourceId("hermes", "session", `${root}\0${nativeId}`);
        const projectId = await registerProject(
          index,
          "hermes",
          metadata.git_repo_root || metadata.cwd,
        );
        const count = Number(metadata.message_count);
        const summary: LocalImportScan["sessions"][number] = {
          id,
          source: "hermes",
          title: safeTitle(metadata.title, `Session ${nativeId.slice(0, 32)}`),
          ...(projectId ? { projectId } : {}),
          ...(iso(metadata.started_at) ? { createdAt: iso(metadata.started_at) } : {}),
          messageCount:
            metadata.message_count != null && Number.isSafeInteger(count) && count >= 0
              ? count
              : null,
        };
        index.sessions.set(id, { summary, sourceRoot: root, sourceFile: file, nativeId, metadata });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        index.warnings.add("UNSUPPORTED_SOURCE_FORMAT");
    }
    await scanSkills(index, "hermes", path.join(root, "skills"));
  }

  async function scanCodex(index: Index, root: string) {
    const titles = new Map<string, string>();
    try {
      const contents = (
        await readSource(path.join(root, "session_index.jsonl"), root, 2 * 1024 * 1024)
      ).toString("utf8");
      for (const line of contents.split("\n")) {
        if (!line.trim()) continue;
        const record = row(JSON.parse(line));
        if (string(record.id))
          titles.set(string(record.id), string(record.thread_name) || string(record.title));
      }
    } catch {
      /* Optional metadata index is absent on older Codex versions. */
    }
    let visited = 0;
    async function walk(dir: string, depth: number): Promise<void> {
      if (depth > 6 || ++visited > MAX_SCAN_ENTRIES || index.sessions.size >= MAX_SESSIONS) {
        index.warnings.add("SCAN_LIMIT_REACHED");
        return;
      }
      for (const item of await entries(dir)) {
        if (item.isSymbolicLink()) {
          index.warnings.add("SYMLINKS_EXCLUDED");
          continue;
        }
        const file = path.join(dir, item.name);
        if (item.isDirectory()) {
          await walk(file, depth + 1);
          continue;
        }
        if (!item.isFile() || !item.name.endsWith(".jsonl")) continue;
        if (index.sessions.size >= MAX_SESSIONS) {
          index.warnings.add("SCAN_LIMIT_REACHED");
          break;
        }
        try {
          const prefix = (await readSource(file, root, 256 * 1024, true))
            .toString("utf8")
            .replace(/^\uFEFF/, "");
          const firstLine = prefix.split("\n")[0] ?? "";
          const metaLine = row(JSON.parse(firstLine));
          const metadata = row(metaLine.payload);
          if (metaLine.type !== "session_meta" || !string(metadata.id)) {
            index.warnings.add("UNSUPPORTED_SOURCE_FORMAT");
            continue;
          }
          const nativeId = string(metadata.id);
          const id = sourceId("codex", "session", `${root}\0${nativeId}`);
          const projectId = await registerProject(index, "codex", metadata.cwd);
          const summary: LocalImportScan["sessions"][number] = {
            id,
            source: "codex",
            title: safeTitle(titles.get(nativeId), `Session ${nativeId.slice(0, 32)}`),
            ...(projectId ? { projectId } : {}),
            ...(iso(metaLine.timestamp || metadata.timestamp)
              ? { createdAt: iso(metaLine.timestamp || metadata.timestamp) }
              : {}),
            messageCount: null,
          };
          index.sessions.set(id, {
            summary,
            sourceRoot: root,
            sourceFile: file,
            nativeId,
            metadata,
          });
        } catch {
          index.warnings.add("UNSUPPORTED_SOURCE_FORMAT");
        }
      }
    }
    for (const name of ["sessions", "archived_sessions"]) {
      const dir = await directory(path.join(root, name));
      if (dir) await walk(dir, 0);
    }
    await scanSkills(index, "codex", path.join(root, "skills"));
  }

  async function scanSensitiveSources(index: Index, source: LocalImportSource, root: string) {
    const names =
      source === "hermes"
        ? [".env", "auth.json", "config.yaml", "credentials.json"]
        : ["auth.json", "config.toml"];
    const files: string[] = [];
    for (const name of names) {
      try {
        const { info } = await safeSourceFile(path.join(root, name), root);
        if (info.size > PORTABLE_IMPORT_MAX_FILE_BYTES) {
          index.warnings.add("FILES_OVER_LIMIT");
          continue;
        }
        files.push(name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          index.warnings.add("SOURCE_UNAVAILABLE");
      }
    }
    if (!files.length) return;
    const id = sourceId(source, "sensitive-source", root);
    const profile = path.basename(root);
    const label = source === "hermes" ? "Hermes" : "Codex";
    index.sensitiveSources.set(id, {
      summary: {
        id,
        source,
        name: [".hermes", "hermes", ".codex", "codex"].includes(profile.toLowerCase())
          ? label
          : `${label} — ${safeTitle(profile, "Profile", 150)}`,
        fileCount: files.length,
      },
      directory: root,
      files: files.sort(order),
    });
  }

  async function scan(): Promise<LocalImportScan> {
    const index: Index = {
      sensitiveSources: new Map(),
      projects: new Map(),
      sessions: new Map(),
      skills: new Map(),
      warnings: new Set(),
    };
    const hermesCandidates = new Set([
      ...(env.HERMES_HOME ? [path.resolve(env.HERMES_HOME)] : []),
      path.join(home, ".hermes"),
      ...(process.platform === "win32" ? [path.join(home, "AppData", "Local", "hermes")] : []),
    ]);
    const hermesRoots = new Set<string>();
    for (const candidate of hermesCandidates) {
      const root = await directory(candidate);
      if (!root) continue;
      hermesRoots.add(root);
      const profiles = await directory(path.join(root, "profiles"));
      if (!profiles) continue;
      for (const item of (await entries(profiles)).slice(0, 100)) {
        if (!item.isDirectory() || item.isSymbolicLink()) continue;
        const profile = await directory(path.join(profiles, item.name));
        if (profile) hermesRoots.add(profile);
      }
    }
    for (const root of hermesRoots) {
      await scanHermes(index, root);
      await scanSensitiveSources(index, "hermes", root);
    }
    const codexRoot = await directory(path.resolve(env.CODEX_HOME || path.join(home, ".codex")));
    if (codexRoot) {
      await scanCodex(index, codexRoot);
      await scanSensitiveSources(index, "codex", codexRoot);
    }
    const result = LocalImportScanSchema.parse({
      sources: [
        { source: "hermes", label: "Hermes", available: hermesRoots.size > 0 },
        { source: "codex", label: "Codex", available: Boolean(codexRoot) },
      ],
      projects: [...index.projects.values()].map((entry) => entry.summary),
      sessions: [...index.sessions.values()].map((entry) => entry.summary),
      skills: [...index.skills.values()].map((entry) => entry.summary),
      sensitiveSources: [...index.sensitiveSources.values()].map((entry) => entry.summary),
      warnings: [...index.warnings].sort(order),
    });
    current = index;
    return result;
  }

  async function collectTree(
    root: string,
    warnings: Set<string>,
    addBytes: (count: number) => void,
    includeSensitiveData = false,
  ): Promise<ImportFile[]> {
    const files: ImportFile[] = [];
    const canonicalRoot = await directory(root);
    if (!canonicalRoot || canonicalRoot !== root)
      throw new Error("Selected source changed. Scan again.");
    let visited = 0;
    const paths = new Set<string>();
    async function walk(dir: string, relative: string, depth: number): Promise<void> {
      if (depth > 40 || ++visited > MAX_SCAN_ENTRIES)
        throw new Error("Selected directory exceeds the import limit.");
      for (const item of await entries(dir)) {
        const name = relative ? `${relative}/${item.name}` : item.name;
        if (isExcludedImportPath(name, includeSensitiveData)) {
          warnings.add("PROJECT_FILES_EXCLUDED");
          continue;
        }
        if (item.isSymbolicLink()) {
          warnings.add("SYMLINKS_EXCLUDED");
          continue;
        }
        const file = path.join(dir, item.name);
        if (item.isDirectory()) {
          await walk(file, name, depth + 1);
          continue;
        }
        if (!item.isFile()) {
          warnings.add("PROJECT_FILES_EXCLUDED");
          continue;
        }
        if (files.length >= 10_000)
          throw new Error("Selected directory exceeds the import file limit.");
        const canonicalName = name.normalize("NFC").toLowerCase();
        if (paths.has(canonicalName))
          throw new Error("Selected directory contains conflicting portable paths.");
        paths.add(canonicalName);
        const info = await lstat(file);
        if (info.size > PORTABLE_IMPORT_MAX_FILE_BYTES) {
          warnings.add("FILES_OVER_LIMIT");
          continue;
        }
        let content = await readSource(file, root, PORTABLE_IMPORT_MAX_FILE_BYTES);
        if (!includeSensitiveData && !content.includes(0)) {
          try {
            const original = new TextDecoder("utf-8", { fatal: true }).decode(content);
            const cleaned = redactImportText(original);
            if (cleaned !== original) {
              content = Buffer.from(cleaned);
              warnings.add("KNOWN_SECRETS_REDACTED");
            }
          } catch {
            /* Binary assets are archived as bytes, never evaluated. */
          }
        }
        const contentBase64 = content.toString("base64");
        addBytes(Buffer.byteLength(contentBase64) + Buffer.byteLength(name));
        files.push({ path: name, contentBase64 });
      }
    }
    await walk(root, "", 0);
    return files.sort((a, b) => order(a.path, b.path));
  }

  async function collectHermes(
    entry: SessionEntry,
    includeSensitiveData = false,
  ): Promise<ImportSession> {
    const data = await readDatabase(entry.sourceFile, entry.sourceRoot, (db) => {
      const columns = sqliteColumns(db, "messages");
      if (!columns.has("session_id") || !columns.has("role") || !columns.has("content"))
        throw new Error("Unsupported Hermes message format.");
      const selected = [
        "id",
        "session_id",
        "role",
        "content",
        "tool_call_id",
        "tool_calls",
        "tool_name",
        "timestamp",
        "finish_reason",
        "reasoning",
        "reasoning_content",
        "reasoning_details",
        "codex_reasoning_items",
        "codex_message_items",
        "active",
        "compacted",
        "api_content",
        "display_kind",
        "display_metadata",
        "display_identity",
        "display_order",
      ].filter((column) => columns.has(column));
      return db
        .prepare(
          `SELECT ${selected.join(", ")} FROM messages WHERE session_id = ? ORDER BY ${columns.has("id") ? "id" : "rowid"} LIMIT 20001`,
        )
        .all(entry.nativeId) as Row[];
    });
    if (data.length > 20_000) throw new Error("Selected session exceeds the import message limit.");
    return {
      id: entry.summary.id,
      source: "hermes",
      title: entry.summary.title,
      ...(entry.summary.projectId ? { projectId: entry.summary.projectId } : {}),
      ...(entry.summary.createdAt ? { createdAt: entry.summary.createdAt } : {}),
      original: includeSensitiveData ? entry.metadata : sanitizeImportValue(entry.metadata),
      messages: data.map((message, index) => ({
        id: String(message.id ?? index),
        role: string(message.role) || "metadata",
        content: includeSensitiveData
          ? textContent(message.content)
          : redactImportText(textContent(message.content)),
        ...(iso(message.timestamp) ? { timestamp: iso(message.timestamp) } : {}),
        original: includeSensitiveData ? message : sanitizeImportValue(message),
      })),
    };
  }
  async function collectCodex(
    entry: SessionEntry,
    includeSensitiveData = false,
  ): Promise<ImportSession> {
    const contents = (await readSource(entry.sourceFile, entry.sourceRoot, MAX_SESSION_FILE_BYTES))
      .toString("utf8")
      .replace(/^\uFEFF/, "");
    const records = contents
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => row(JSON.parse(line)));
    if (records.length > 20_000)
      throw new Error("Selected session exceeds the import record limit.");
    const canonicalRoles = new Set(
      records
        .filter(
          (record) => record.type === "response_item" && row(record.payload).type === "message",
        )
        .map((record) => string(row(record.payload).role)),
    );
    if (row(records[0]?.payload).id !== entry.nativeId)
      throw new Error("Selected session changed. Scan again.");
    return {
      id: entry.summary.id,
      source: "codex",
      title: entry.summary.title,
      ...(entry.summary.projectId ? { projectId: entry.summary.projectId } : {}),
      ...(entry.summary.createdAt ? { createdAt: entry.summary.createdAt } : {}),
      original: includeSensitiveData ? entry.metadata : sanitizeImportValue(entry.metadata),
      messages: records.map((record, index) => {
        const payload = row(record.payload);
        let role = "metadata";
        let content = "";
        if (record.type === "response_item") {
          if (payload.type === "message") {
            role = string(payload.role) || "metadata";
            content = textContent(payload.content);
          } else if (payload.type === "function_call" || payload.type === "custom_tool_call") {
            role = "tool_call";
            content = JSON.stringify(payload);
          } else if (
            payload.type === "function_call_output" ||
            payload.type === "custom_tool_call_output"
          ) {
            role = "tool";
            content = textContent(payload.output);
          }
        } else if (
          record.type === "event_msg" &&
          (payload.type === "user_message" || payload.type === "agent_message")
        ) {
          const candidate = payload.type === "user_message" ? "user" : "assistant";
          if (!canonicalRoles.has(candidate)) {
            role = candidate;
            content = string(payload.message);
          }
        }
        return {
          id: String(index),
          role,
          content: includeSensitiveData ? content : redactImportText(content),
          ...(iso(record.timestamp) ? { timestamp: iso(record.timestamp) } : {}),
          original: includeSensitiveData ? record : sanitizeImportValue(record),
        };
      }),
    };
  }

  async function bundle(rawSelection: ImportSelection): Promise<ImportPacket> {
    const selection = ImportSelectionSchema.parse(rawSelection);
    const includeSensitiveData = selection.includeSensitiveData === true;
    if (!includeSensitiveData && (selection.sensitiveSourceIds?.length ?? 0) > 0)
      throw new Error("Explicit sensitive-data consent is required.");
    const index = current;
    if (!index) throw new Error("Approve a source scan before selecting data.");
    const selected = <T>(ids: string[], map: Map<string, T>): T[] => {
      if (ids.length !== new Set(ids).size) throw new Error("Duplicate import selection.");
      return ids.map((id) => {
        const value = map.get(id);
        if (!value) throw new Error("Unknown import selection. Scan again.");
        return value;
      });
    };
    const projectEntries = selected(selection.projectIds, index.projects);
    const sessionEntries = selected(selection.sessionIds, index.sessions);
    const skillEntries = selected(selection.skillIds, index.skills);
    const sensitiveEntries = selected(selection.sensitiveSourceIds ?? [], index.sensitiveSources);
    if (
      !projectEntries.length &&
      !sessionEntries.length &&
      !skillEntries.length &&
      !sensitiveEntries.length
    )
      throw new Error("Choose at least one item to import.");
    const warnings = new Set(index.warnings);
    warnings.add("RUNTIME_NOT_IMPORTED");
    let bytes = 0;
    function addBytes(count: number) {
      bytes += count;
      if (bytes > PORTABLE_IMPORT_MAX_UNPACKED_BYTES)
        throw new Error("Selected import exceeds the size limit. Select fewer items.");
    }
    const projects: ImportProject[] = [];
    for (const entry of projectEntries) {
      const { fileCount: _count, ...summary } = entry.summary;
      projects.push({
        ...summary,
        files: await collectTree(entry.directory, warnings, addBytes, includeSensitiveData),
      });
      warnings.add("GIT_HISTORY_EXCLUDED");
    }
    const sessions: ImportSession[] = [];
    for (const entry of sessionEntries) {
      const session =
        entry.summary.source === "hermes"
          ? await collectHermes(entry, includeSensitiveData)
          : await collectCodex(entry, includeSensitiveData);
      if (session.projectId && !selection.projectIds.includes(session.projectId)) {
        delete session.projectId;
        warnings.add("PROJECT_NOT_SELECTED");
      }
      if (
        JSON.stringify(session.original).includes("[REDACTED]") ||
        session.messages.some((message) => JSON.stringify(message).includes("[REDACTED]"))
      )
        warnings.add("KNOWN_SECRETS_REDACTED");
      addBytes(Buffer.byteLength(JSON.stringify(session)));
      sessions.push(session);
    }
    if (sessionEntries.length) warnings.add("ATTACHMENTS_NOT_IMPORTED");
    const skills: ImportSkill[] = [];
    for (const entry of skillEntries) {
      const { fileCount: _count, ...summary } = entry.summary;
      skills.push({
        ...summary,
        files: await collectTree(entry.directory, warnings, addBytes, includeSensitiveData),
      });
    }
    if (skillEntries.length) warnings.add("SKILLS_ARCHIVED_INACTIVE");
    const sensitiveSources: ImportSensitiveSource[] = [];
    for (const entry of sensitiveEntries) {
      const files: ImportFile[] = [];
      for (const relative of entry.files) {
        const bytes = await readSource(
          path.join(entry.directory, relative),
          entry.directory,
          PORTABLE_IMPORT_MAX_FILE_BYTES,
        );
        const contentBase64 = bytes.toString("base64");
        addBytes(Buffer.byteLength(contentBase64) + Buffer.byteLength(relative));
        files.push({ path: relative, contentBase64 });
      }
      const { fileCount: _count, ...summary } = entry.summary;
      sensitiveSources.push({ ...summary, files });
    }
    if (includeSensitiveData) warnings.add("SENSITIVE_DATA_INCLUDED_INACTIVE");
    const result: PortableImportBundle = PortableImportBundleSchema.parse({
      version: 1,
      exportedAt: new Date().toISOString(),
      projects,
      sessions,
      skills,
      ...(includeSensitiveData ? { includeSensitiveData: true, sensitiveSources } : {}),
      warnings: [...warnings].sort(order),
    });
    const encoded = Buffer.from(JSON.stringify(result));
    if (encoded.byteLength > PORTABLE_IMPORT_MAX_UNPACKED_BYTES)
      throw new Error("Selected import exceeds the size limit. Select fewer items.");
    const data = gzipSync(encoded).toString("base64");
    if (data.length > PORTABLE_IMPORT_MAX_PACKET_CHARS)
      throw new Error("Selected import exceeds the transfer size limit. Select fewer items.");
    return {
      encoding: "gzip-base64",
      data,
      ...(includeSensitiveData ? { includeSensitiveData: true } : {}),
    };
  }

  return { scan, bundle };
}
