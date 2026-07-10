import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Pool, type PoolClient } from "pg";

const MIGRATION_FILENAME = /^\d{4}_[a-z0-9_]+\.sql$/;
const DEFAULT_MIGRATIONS_DIRECTORY = fileURLToPath(
  new URL("../migrations/", import.meta.url),
);

export const MIGRATION_TABLE = "open_excalidraw_migrations";

export class MigrationChecksumError extends Error {
  constructor(
    readonly migration: string,
    readonly expectedChecksum: string,
    readonly actualChecksum: string,
  ) {
    super(
      `Migration ${migration} has checksum ${actualChecksum}, but the database recorded ${expectedChecksum}`,
    );
    this.name = "MigrationChecksumError";
  }
}

export type AppliedMigration = {
  name: string;
  checksum: string;
};

export type MigrationResult = {
  applied: AppliedMigration[];
  alreadyApplied: AppliedMigration[];
};

export type RunMigrationsOptions = {
  pool: Pool;
  migrationsDirectory?: string;
};

export function migrationChecksum(contents: string | Buffer) {
  return createHash("sha256").update(contents).digest("hex");
}

async function ensureMigrationTable(client: PoolClient) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
      name TEXT PRIMARY KEY,
      checksum CHAR(64) NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

export async function runMigrations({
  pool,
  migrationsDirectory = DEFAULT_MIGRATIONS_DIRECTORY,
}: RunMigrationsOptions): Promise<MigrationResult> {
  const entries = await readdir(migrationsDirectory, { withFileTypes: true });
  const migrationNames = entries
    .filter((entry) => entry.isFile() && MIGRATION_FILENAME.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  if (migrationNames.length === 0) {
    throw new Error(`No migrations found in ${migrationsDirectory}`);
  }

  const client = await pool.connect();
  const result: MigrationResult = { applied: [], alreadyApplied: [] };

  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('open-excalidraw-migrations'))",
    );
    await ensureMigrationTable(client);

    for (const name of migrationNames) {
      const contents = await readFile(resolve(migrationsDirectory, name));
      const checksum = migrationChecksum(contents);
      const existing = await client.query<{ checksum: string }>(
        `SELECT checksum FROM ${MIGRATION_TABLE} WHERE name = $1`,
        [name],
      );

      if (existing.rowCount !== 0) {
        const recordedChecksum = existing.rows[0]?.checksum.trim();
        if (recordedChecksum !== checksum) {
          throw new MigrationChecksumError(
            name,
            recordedChecksum ?? "",
            checksum,
          );
        }

        result.alreadyApplied.push({ name, checksum });
        continue;
      }

      await client.query(contents.toString("utf8"));
      await client.query(
        `INSERT INTO ${MIGRATION_TABLE} (name, checksum) VALUES ($1, $2)`,
        [name, checksum],
      );
      result.applied.push({ name, checksum });
    }

    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function isMainModule() {
  const entry = process.argv[1];
  return (
    entry !== undefined &&
    pathToFileURL(resolve(entry)).href === import.meta.url
  );
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const result = await runMigrations({ pool });
    process.stdout.write(
      `Applied ${result.applied.length} migration(s); ${result.alreadyApplied.length} already current.\n`,
    );
  } finally {
    await pool.end();
  }
}

if (isMainModule()) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    process.stderr.write(`Migration failed: ${message}\n`);
    process.exitCode = 1;
  });
}
