import { Pool } from "pg";

import { runMigrations } from "./migrate.js";

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

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  process.stderr.write(`Migration failed: ${message}\n`);
  process.exitCode = 1;
});
