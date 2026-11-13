import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { getLogger } from "@acompany/logging";
import type {
  Api,
  CreateModelsOptions,
  Model,
  MutableModels,
  Provider,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

/**
 * Pi ships its model catalog inside the npm package, so new models (a new GPT, Claude or
 * Gemini) would otherwise wait for a dependency bump and a rebuild. This reads the catalog
 * from the newest published package and adds the models this install does not know yet.
 * Only models whose wire API the installed provider already speaks are added, so an extra
 * entry can always be called. Network failures keep the last saved catalog.
 */

const CATALOG_PACKAGE = "@earendil-works/pi-ai";
const CLAUDE_CODE_PACKAGE = "@anthropic-ai/claude-code";
const DEFAULT_CLAUDE_CODE_VERSION = "2.1.322";
const REGISTRY = "https://registry.npmjs.org";
const REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 60_000;
const DATA_PREFIX = "package/dist/providers/data/";

type ExtraModels = Record<string, Model<Api>[]>;
type SavedCatalog = {
  version: string;
  checkedAt: string;
  claudeCodeVersion?: string;
  models: ExtraModels;
};

let extras: ExtraModels = {};
let claudeCodeCliVersion = DEFAULT_CLAUDE_CODE_VERSION;
let generation = 0;
let overlayFile: string | undefined;

/** Latest known Claude Code CLI version for Anthropic OAuth requests. */
export function currentClaudeCodeVersion(): string {
  return claudeCodeCliVersion;
}

/** Bumps whenever newly discovered models are applied; catalog caches rebuild on change. */
export function modelCatalogGeneration(): number {
  return generation;
}

/** `builtinModels()` plus models published after this build. */
export function catalogBuiltinModels(options?: CreateModelsOptions): MutableModels {
  const models = builtinModels(options);
  for (const [providerId, added] of Object.entries(extras)) {
    const provider = models.getProvider(providerId);
    if (provider && added.length > 0) models.setProvider(withExtraModels(provider, added));
  }
  return models;
}

function withExtraModels(provider: Provider, added: readonly Model<Api>[]): Provider {
  return {
    ...provider,
    getModels: () => {
      const current = provider.getModels();
      const known = new Set(current.map((model) => model.id));
      // Built-in catalogs are ordered by id; keep new models in place instead of at the end.
      return [...current, ...added.filter((model) => !known.has(model.id))].sort((a, b) =>
        a.id.localeCompare(b.id),
      );
    },
  };
}

/**
 * Load the saved catalog from `dataDir`, then refresh it from the registry now and every
 * 12 hours. Set ACOMPANY_MODEL_CATALOG_UPDATES=off to stay on the bundled catalog.
 */
export function startModelCatalogUpdates(dataDir: string): { stop: () => void } {
  if (process.env.ACOMPANY_MODEL_CATALOG_UPDATES?.trim().toLowerCase() === "off") {
    return { stop: () => undefined };
  }
  overlayFile = path.join(path.resolve(dataDir), "model-catalog", "latest.json");
  applySaved(readSaved(overlayFile));
  const run = () => void refreshModelCatalog().catch(() => undefined);
  run();
  const timer = setInterval(run, REFRESH_INTERVAL_MS);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}

export async function refreshModelCatalog(fetchImpl: typeof fetch = fetch): Promise<number> {
  try {
    const [meta, claudeMeta] = await Promise.all([
      fetchJson(fetchImpl, `${REGISTRY}/${CATALOG_PACKAGE}/latest`) as Promise<{
        version?: string;
        dist?: { tarball?: string };
      }>,
      fetchJson(fetchImpl, `${REGISTRY}/${CLAUDE_CODE_PACKAGE}/latest`).catch(
        () => undefined,
      ) as Promise<{ version?: string } | undefined>,
    ]);
    if (claudeMeta?.version && typeof claudeMeta.version === "string") {
      claudeCodeCliVersion = claudeMeta.version;
    }
    if (!meta.version || !meta.dist?.tarball) throw new Error("registry response has no tarball");
    const tarball = await fetchBuffer(fetchImpl, meta.dist.tarball);
    const found = newModels(readCatalogFiles(tarball));
    const count = Object.values(found).reduce((total, list) => total + list.length, 0);
    if (overlayFile) {
      writeSaved(overlayFile, {
        version: meta.version,
        checkedAt: new Date().toISOString(),
        claudeCodeVersion: claudeCodeCliVersion,
        models: found,
      });
    }
    if (JSON.stringify(found) !== JSON.stringify(extras)) {
      extras = found;
      generation += 1;
      getLogger().info("model catalog updated", {
        "catalog.version": meta.version,
        "catalog.added_models": count,
      });
    }
    return count;
  } catch (error) {
    getLogger().warn("model catalog update failed", {
      "error.message": error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/** Models in the published catalog that this install lacks and can serve. */
export function newModels(published: Record<string, unknown>): ExtraModels {
  const installed = builtinModels();
  const out: ExtraModels = {};
  for (const [providerId, groups] of Object.entries(published)) {
    const provider = installed.getProvider(providerId);
    if (!provider || !groups || typeof groups !== "object") continue;
    const current = provider.getModels();
    const knownIds = new Set(current.map((model) => model.id));
    const servedApis = new Set<string>(current.map((model) => model.api));
    const added: Model<Api>[] = [];
    for (const group of Object.values(groups as Record<string, unknown>)) {
      if (!group || typeof group !== "object") continue;
      for (const candidate of Object.values(group as Record<string, unknown>)) {
        if (!isModel(candidate) || candidate.provider !== providerId) continue;
        if (knownIds.has(candidate.id) || !servedApis.has(candidate.api)) continue;
        knownIds.add(candidate.id);
        added.push(candidate);
      }
    }
    if (added.length > 0) out[providerId] = added;
  }
  return out;
}

function isModel(value: unknown): value is Model<Api> {
  if (!value || typeof value !== "object") return false;
  const model = value as Partial<Model<Api>>;
  return (
    typeof model.id === "string" &&
    typeof model.name === "string" &&
    typeof model.api === "string" &&
    typeof model.provider === "string" &&
    typeof model.baseUrl === "string" &&
    Array.isArray(model.input) &&
    typeof model.contextWindow === "number" &&
    typeof model.maxTokens === "number" &&
    typeof model.cost === "object"
  );
}

/** `{ providerId: catalogJson }` from the package's `dist/providers/data/*.json`. */
export function readCatalogFiles(tgz: Buffer): Record<string, unknown> {
  const tar = gunzipSync(tgz);
  const files: Record<string, unknown> = {};
  let offset = 0;
  let longName: string | undefined;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = Number.parseInt(field(header, 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(header[156] ?? 0);
    const prefix = field(header, 345, 155);
    const name =
      longName ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
    longName = undefined;
    const body = tar.subarray(offset + 512, offset + 512 + size);
    if (type === "L") longName = body.toString("utf8").replace(/\0.*$/s, "");
    else if (type === "x") longName = paxPath(body.toString("utf8"));
    else if ((type === "0" || type === "\0") && name.startsWith(DATA_PREFIX)) {
      const file = name.slice(DATA_PREFIX.length);
      if (file.endsWith(".json") && !file.includes("/")) {
        files[file.slice(0, -".json".length)] = JSON.parse(body.toString("utf8"));
      }
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

function field(header: Buffer, start: number, length: number): string {
  return header
    .subarray(start, start + length)
    .toString("utf8")
    .replace(/\0.*$/s, "");
}

function paxPath(records: string): string | undefined {
  return /\d+ path=([^\n]*)\n/.exec(records)?.[1];
}

async function fetchJson(fetchImpl: typeof fetch, url: string): Promise<unknown> {
  return JSON.parse((await fetchBuffer(fetchImpl, url)).toString("utf8"));
}

async function fetchBuffer(fetchImpl: typeof fetch, url: string): Promise<Buffer> {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function readSaved(file: string): SavedCatalog | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as SavedCatalog;
  } catch {
    return undefined;
  }
}

function applySaved(saved: SavedCatalog | undefined) {
  if (saved?.claudeCodeVersion && typeof saved.claudeCodeVersion === "string") {
    claudeCodeCliVersion = saved.claudeCodeVersion;
  }
  if (!saved?.models || typeof saved.models !== "object") return;
  // Re-check against the installed catalog: after an upgrade some saved models are built in.
  extras = newModels(
    Object.fromEntries(
      Object.entries(saved.models).map(([provider, list]) => [
        provider,
        { saved: Object.fromEntries(list.map((model) => [model.id, model])) },
      ]),
    ),
  );
  generation += 1;
}

function writeSaved(file: string, saved: SavedCatalog) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(saved)}\n`);
  renameSync(temp, file);
}
