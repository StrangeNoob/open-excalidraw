import type { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

import { Pool } from "pg";

import {
  StorageNotFoundError,
  type ObjectStorage,
} from "@open-excalidraw/storage";

import {
  createStorageFromEnvironment,
  requiredEnvironment,
} from "../storage-config.js";

/**
 * Copies every live asset between storage drivers (local volume <-> S3),
 * enumerating from the database so only referenced assets move. Copies are
 * verified against each row's recorded sha256 and identical retries are
 * skipped by the driver contract, so the command is safe to re-run after a
 * partial migration.
 *
 * Usage: node migrate-assets.mjs --from local --to s3 [--dry-run]
 * Both sides read the same environment variables the server uses
 * (STORAGE_LOCAL_PATH for local, S3_* for s3).
 */

export interface MigratableAsset {
  storageKey: string;
  sha256: string;
  byteSize: number;
}

export interface MigrationSummary {
  copied: number;
  skippedIdentical: number;
  missingSource: number;
  failed: number;
}

export interface MigrateAssetsOptions {
  assets: Iterable<MigratableAsset>;
  source: ObjectStorage;
  destination: ObjectStorage;
  dryRun?: boolean;
  log?: (line: string) => void;
}

export async function migrateAssets(
  options: MigrateAssetsOptions,
): Promise<MigrationSummary> {
  const log = options.log ?? (() => undefined);
  const summary: MigrationSummary = {
    copied: 0,
    skippedIdentical: 0,
    missingSource: 0,
    failed: 0,
  };

  for (const asset of options.assets) {
    let body: Readable | undefined;
    try {
      if (options.dryRun) {
        await options.source.stat(asset.storageKey);
        if (await identicalAtDestination(options.destination, asset)) {
          summary.skippedIdentical += 1;
          log(`would skip ${asset.storageKey} (already at destination)`);
        } else {
          summary.copied += 1;
          log(`would copy ${asset.storageKey} (${asset.byteSize} bytes)`);
        }
        continue;
      }

      body = await options.source.get(asset.storageKey);
      const result = await options.destination.put(asset.storageKey, body, {
        expectedSha256: asset.sha256,
      });
      if (result.created) {
        summary.copied += 1;
        log(`copied ${asset.storageKey} (${result.size} bytes)`);
      } else {
        summary.skippedIdentical += 1;
        log(`skipped ${asset.storageKey} (already at destination)`);
      }
    } catch (error) {
      // A put that fails before draining the source stream would otherwise
      // leak its file descriptor or socket for the rest of the run.
      body?.destroy();
      if (error instanceof StorageNotFoundError) {
        summary.missingSource += 1;
        log(`missing ${asset.storageKey} (not found at source)`);
      } else {
        summary.failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        log(`failed ${asset.storageKey}: ${message}`);
      }
    }
  }

  return summary;
}

async function identicalAtDestination(
  destination: ObjectStorage,
  asset: MigratableAsset,
): Promise<boolean> {
  try {
    const existing = await destination.stat(asset.storageKey);
    return existing.sha256 === asset.sha256;
  } catch (error) {
    if (error instanceof StorageNotFoundError) {
      return false;
    }
    throw error;
  }
}

interface AssetRow {
  storage_key: string;
  sha256_hex: string;
  byte_size: number;
}

async function loadLiveAssets(pool: Pool): Promise<MigratableAsset[]> {
  const result = await pool.query<AssetRow>(
    `SELECT storage_key, encode(sha256, 'hex') AS sha256_hex, byte_size
     FROM drawing_assets
     WHERE deleted_at IS NULL AND storage_deleted_at IS NULL
     ORDER BY created_at`,
  );
  return result.rows.map((row) => ({
    storageKey: row.storage_key,
    sha256: row.sha256_hex,
    byteSize: row.byte_size,
  }));
}

function parseDriver(flag: string, value: string | undefined): string {
  if (value !== "local" && value !== "s3") {
    throw new Error(`${flag} must be "local" or "s3"`);
  }
  return value;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const argument = (flag: string) => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  const from = parseDriver("--from", argument("--from"));
  const to = parseDriver("--to", argument("--to"));
  const dryRun = argv.includes("--dry-run");
  if (from === to) {
    throw new Error("--from and --to must differ");
  }

  const source = createStorageFromEnvironment(from);
  const destination = createStorageFromEnvironment(to);
  const pool = new Pool({
    connectionString: requiredEnvironment("DATABASE_URL"),
  });

  try {
    const assets = await loadLiveAssets(pool);
    process.stdout.write(
      `${dryRun ? "[dry-run] " : ""}migrating ${assets.length} asset(s): ${from} -> ${to}\n`,
    );
    const summary = await migrateAssets({
      assets,
      source,
      destination,
      dryRun,
      log: (line) => process.stdout.write(`${line}\n`),
    });
    process.stdout.write(
      `done: copied=${summary.copied} skipped=${summary.skippedIdentical} ` +
        `missing=${summary.missingSource} failed=${summary.failed}\n`,
    );
    if (summary.failed > 0) {
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    process.stderr.write(`Asset migration failed: ${message}\n`);
    process.exitCode = 1;
  });
}
