import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDb } from "./client.js";
import {
  isEmbeddedDatabaseUrl,
  resolveEmbeddedDataDir,
  startEmbeddedPostgres,
} from "./embedded-postgres.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("embedded postgres (PGlite)", () => {
  it("recognizes embedded database URL shorthands and resolves data directories", () => {
    expect(isEmbeddedDatabaseUrl("pglite")).toBe(true);
    expect(isEmbeddedDatabaseUrl("pglite://memory")).toBe(true);
    expect(isEmbeddedDatabaseUrl("pglite://./data/pg")).toBe(true);
    expect(isEmbeddedDatabaseUrl("postgresql://localhost:5432/acompany")).toBe(false);
    expect(resolveEmbeddedDataDir("pglite://memory", "/tmp/acompany")).toBe("memory://");
    expect(resolveEmbeddedDataDir("pglite", "/tmp/acompany")).toBe(
      path.join("/tmp/acompany", "pglite"),
    );
  });

  it("applies all Prisma migrations idempotently and serves Prisma queries over loopback", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acompany-pglite-test-"));
    tempDirs.push(dir);

    const first = await startEmbeddedPostgres({ dataDir: dir });
    expect(first.appliedMigrations).toBeGreaterThan(50);

    const db1 = createDb(first.databaseUrl);
    await db1.prisma.user.create({
      data: {
        id: "user_embedded_1",
        email: "embedded@example.com",
        name: "Embedded User",
        emailVerified: true,
      },
    });
    await db1.pool.end();
    await first.stop();

    // Reopening the same directory preserves data and applies 0 duplicate migrations.
    const second = await startEmbeddedPostgres({ dataDir: dir });
    expect(second.appliedMigrations).toBe(0);

    const db2 = createDb(second.databaseUrl);
    const found = await db2.prisma.user.findUnique({ where: { id: "user_embedded_1" } });
    expect(found?.email).toBe("embedded@example.com");
    await db2.pool.end();
    await second.stop();
  }, 60_000);
});
