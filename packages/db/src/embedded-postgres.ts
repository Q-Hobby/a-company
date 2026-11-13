import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

export interface EmbeddedPostgresOptions {
  /** Directory on disk for persistent PGlite storage, or `"memory://"` for ephemeral runs. */
  dataDir?: string;
  /** Host to bind the loopback Postgres wire-protocol server on (default: `127.0.0.1`). */
  host?: string;
  /** Port to listen on (`0` chooses an available ephemeral port). */
  port?: number;
  /** Maximum concurrent virtual connections accepted by the socket server. */
  maxConnections?: number;
  /** Directory containing Prisma migration folders (`<timestamp>_<name>/migration.sql`). */
  migrationsDir?: string;
}

export interface EmbeddedPostgresHandle {
  /** Standard `postgresql://...` URL accepted by `pg`, `@prisma/adapter-pg`, and `graphile-worker`. */
  databaseUrl: string;
  /** Underlying PGlite instance. */
  pglite: PGlite;
  /** Underlying loopback TCP wire-protocol server. */
  socketServer: PGLiteSocketServer;
  /** Number of migration SQL files applied during startup (`0` when already up to date). */
  appliedMigrations: number;
  /** Cleanly stops the TCP socket server and flushes/closes PGlite. */
  stop: () => Promise<void>;
}

const DEFAULT_MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../prisma/migrations",
);

const MIGRATIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS "_acompany_embedded_migrations" (
  "name" TEXT PRIMARY KEY,
  "applied_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

export function isEmbeddedDatabaseUrl(databaseUrl: string | undefined): boolean {
  const trimmed = databaseUrl?.trim();
  if (!trimmed) return false;
  return (
    trimmed === "pglite" ||
    trimmed === "embedded" ||
    trimmed.startsWith("pglite://") ||
    trimmed.startsWith("file:")
  );
}

export function resolveEmbeddedDataDir(
  databaseUrl: string | undefined,
  fallbackRoot: string,
): string {
  const trimmed = databaseUrl?.trim() ?? "";
  if (trimmed === "pglite://memory" || trimmed === "memory://") {
    return "memory://";
  }
  if (trimmed.startsWith("pglite://")) {
    const rest = trimmed.slice("pglite://".length).trim();
    if (!rest) return path.join(fallbackRoot, "pglite");
    return path.resolve(rest);
  }
  if (trimmed.startsWith("file:")) {
    const rest = trimmed.slice("file:".length).trim();
    if (!rest) return path.join(fallbackRoot, "pglite");
    return path.resolve(rest);
  }
  return path.join(fallbackRoot, "pglite");
}

export async function applyEmbeddedMigrations(
  pglite: PGlite,
  migrationsDir = DEFAULT_MIGRATIONS_DIR,
): Promise<number> {
  if (!fs.existsSync(migrationsDir)) {
    throw new Error(`Prisma migrations directory not found: ${migrationsDir}`);
  }
  await pglite.exec(MIGRATIONS_TABLE_SQL);
  const existing = await pglite.query<{ name: string }>(
    `SELECT "name" FROM "_acompany_embedded_migrations"`,
  );
  const appliedSet = new Set(existing.rows.map((row) => row.name));

  const folders = fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  let applied = 0;
  for (const folder of folders) {
    if (appliedSet.has(folder)) continue;
    const sqlPath = path.join(migrationsDir, folder, "migration.sql");
    if (!fs.existsSync(sqlPath)) continue;
    const sql = fs.readFileSync(sqlPath, "utf8");
    const nonTransactional = /\bCONCURRENTLY\b/i.test(sql);
    if (!nonTransactional) {
      await pglite.exec("BEGIN");
    }
    try {
      await pglite.exec(sql);
      await pglite.query(`INSERT INTO "_acompany_embedded_migrations" ("name") VALUES ($1)`, [
        folder,
      ]);
      if (!nonTransactional) {
        await pglite.exec("COMMIT");
      }
      applied += 1;
    } catch (error) {
      if (!nonTransactional) {
        await pglite.exec("ROLLBACK").catch(() => undefined);
      }
      throw new Error(
        `Embedded Postgres migration "${folder}" failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return applied;
}

/**
 * Starts an in-process PostgreSQL engine backed by PGlite + a loopback wire-protocol socket,
 * automatically applying Prisma migrations so the full A-Company stack (Prisma, Better Auth,
 * LISTEN/NOTIFY realtime, and Graphile Worker) runs without Docker or an external Postgres server.
 */
export async function startEmbeddedPostgres(
  options: EmbeddedPostgresOptions = {},
): Promise<EmbeddedPostgresHandle> {
  const dataDir = options.dataDir?.trim() || "memory://";
  if (dataDir !== "memory://") {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const pglite = await PGlite.create(dataDir === "memory://" ? undefined : dataDir);
  let socketServer: PGLiteSocketServer | undefined;
  try {
    const appliedMigrations = await applyEmbeddedMigrations(
      pglite,
      options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR,
    );

    socketServer = new PGLiteSocketServer({
      db: pglite,
      host: options.host ?? "127.0.0.1",
      port: options.port ?? 0,
      maxConnections: options.maxConnections ?? 50,
    });
    await socketServer.start();
    const conn = socketServer.getServerConn();
    const databaseUrl = `postgresql://postgres:postgres@${conn}/postgres?sslmode=disable`;

    let stopped = false;
    return {
      databaseUrl,
      pglite,
      socketServer,
      appliedMigrations,
      async stop() {
        if (stopped) return;
        stopped = true;
        await socketServer?.stop().catch(() => undefined);
        await pglite.close().catch(() => undefined);
      },
    };
  } catch (error) {
    await socketServer?.stop().catch(() => undefined);
    await pglite.close().catch(() => undefined);
    throw error;
  }
}
