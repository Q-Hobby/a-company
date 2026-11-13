import { gzipSync } from "node:zlib";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it, vi } from "vitest";
import {
  catalogBuiltinModels,
  modelCatalogGeneration,
  newModels,
  readCatalogFiles,
  refreshModelCatalog,
} from "./pi-catalog-updates.js";

function tarEntry(name: string, body: string): Buffer {
  const content = Buffer.from(body, "utf8");
  const header = Buffer.alloc(512);
  header.write(name, 0, "utf8");
  header.write("0000644\0", 100);
  header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124);
  header.write("0", 156);
  const padded = Buffer.alloc(Math.ceil(content.length / 512) * 512);
  content.copy(padded);
  return Buffer.concat([header, padded]);
}

function tarball(files: Record<string, unknown>): Buffer {
  const entries = Object.entries(files).map(([name, value]) =>
    tarEntry(`package/dist/providers/data/${name}.json`, JSON.stringify(value)),
  );
  return gzipSync(
    Buffer.concat([tarEntry("package/README.md", "x"), ...entries, Buffer.alloc(1024)]),
  );
}

const existing = builtinModels().getModels("anthropic")[0]!;
const fresh = { ...existing, id: "claude-test-next", name: "Claude Test Next" };
const unservable = { ...existing, id: "claude-other-api", api: "some-future-api" };

describe("model catalog updates", () => {
  it("reads provider catalogs out of the package tarball", () => {
    const files = readCatalogFiles(tarball({ anthropic: { a: {} }, openai: { b: {} } }));
    expect(Object.keys(files).sort()).toEqual(["anthropic", "openai"]);
  });

  it("keeps only unknown models the installed provider can call", () => {
    const found = newModels({
      anthropic: { [existing.api]: { a: existing, b: fresh, c: unservable } },
      "unknown-provider": { x: { y: { ...fresh, provider: "unknown-provider" } } },
    });
    expect(found).toEqual({ anthropic: [fresh] });
  });

  it("adds fetched models to every catalog consumer", async () => {
    const before = modelCatalogGeneration();
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/latest")) {
        return Response.json({ version: "9.9.9", dist: { tarball: "https://example.test/x.tgz" } });
      }
      return new Response(new Uint8Array(tarball({ anthropic: { [existing.api]: { b: fresh } } })));
    }) as unknown as typeof fetch;

    await expect(refreshModelCatalog(fetchImpl)).resolves.toBe(1);
    expect(modelCatalogGeneration()).toBe(before + 1);
    expect(catalogBuiltinModels().getModel("anthropic", "claude-test-next")?.name).toBe(
      "Claude Test Next",
    );
  });

  it("keeps the current catalog when the registry is unreachable", async () => {
    const before = modelCatalogGeneration();
    const failing = vi.fn(
      async () => new Response("down", { status: 503 }),
    ) as unknown as typeof fetch;
    await expect(refreshModelCatalog(failing)).rejects.toThrow("503");
    expect(modelCatalogGeneration()).toBe(before);
  });
});
