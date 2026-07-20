import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
 * Writes every live drawing to a portable `.excalidraw` file, inlining its
 * live image assets as base64 data URLs so each file opens standalone in any
 * Excalidraw client. This is a user-level portability export, not a backup:
 * it carries no users, permissions, revision history, or share links.
 *
 * Usage: node export-drawings.mjs --out <directory> [--dry-run]
 * Reads DATABASE_URL and the same storage environment the server uses; the
 * driver comes from STORAGE_DRIVER (default "local").
 */

export interface ExportableDrawing {
  id: string;
  title: string;
  scene: Record<string, unknown> | null;
}

export interface ExportableAsset {
  fileId: string;
  storageKey: string;
  mimeType: string;
  createdAt: Date;
}

export interface ExportSummary {
  exported: number;
  assetsInlined: number;
  missingAssets: number;
  failed: number;
}

export interface ExportDrawingsOptions {
  drawings: Iterable<ExportableDrawing>;
  loadAssets: (drawingId: string) => Promise<ExportableAsset[]>;
  storage: ObjectStorage;
  outputDirectory: string;
  writeFile: (filePath: string, contents: string) => Promise<void>;
  dryRun?: boolean;
  log?: (line: string) => void;
}

export async function exportDrawings(
  options: ExportDrawingsOptions,
): Promise<ExportSummary> {
  const log = options.log ?? (() => undefined);
  const summary: ExportSummary = {
    exported: 0,
    assetsInlined: 0,
    missingAssets: 0,
    failed: 0,
  };

  for (const drawing of options.drawings) {
    try {
      const assets = await options.loadAssets(drawing.id);
      const fileName = buildFileName(drawing.title, drawing.id);

      if (options.dryRun) {
        summary.exported += 1;
        log(`would export ${fileName} (${assets.length} asset(s))`);
        continue;
      }

      if (!drawing.scene) {
        throw new Error("drawing has no scene data");
      }

      const files: Record<string, ExportedFile> = {};
      for (const asset of assets) {
        try {
          const bytes = await readAllBytes(
            await options.storage.get(asset.storageKey),
          );
          files[asset.fileId] = {
            id: asset.fileId,
            mimeType: asset.mimeType,
            dataURL: `data:${asset.mimeType};base64,${bytes.toString("base64")}`,
            created: asset.createdAt.getTime(),
          };
          summary.assetsInlined += 1;
        } catch (error) {
          if (error instanceof StorageNotFoundError) {
            summary.missingAssets += 1;
            log(`missing asset ${asset.storageKey} for drawing ${drawing.id}`);
          } else {
            throw error;
          }
        }
      }

      const document = { ...drawing.scene, files };
      await options.writeFile(
        join(options.outputDirectory, fileName),
        `${JSON.stringify(document, null, 2)}\n`,
      );
      summary.exported += 1;
      log(`exported ${fileName} (${Object.keys(files).length} asset(s))`);
    } catch (error) {
      summary.failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      log(`failed drawing ${drawing.id}: ${message}`);
    }
  }

  return summary;
}

interface ExportedFile {
  id: string;
  mimeType: string;
  dataURL: string;
  created: number;
}

function buildFileName(title: string, id: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return `${slug || "untitled"}-${id}.excalidraw`;
}

async function readAllBytes(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function loadDrawings(pool: Pool): Promise<ExportableDrawing[]> {
  const result = await pool.query<{
    id: string;
    title: string;
    scene: Record<string, unknown> | null;
  }>(
    `SELECT id, title, scene FROM drawings
     WHERE deleted_at IS NULL
     ORDER BY created_at`,
  );
  return result.rows;
}

async function loadLiveAssets(
  pool: Pool,
  drawingId: string,
): Promise<ExportableAsset[]> {
  const result = await pool.query<{
    file_id: string;
    storage_key: string;
    mime_type: string;
    created_at: Date;
  }>(
    `SELECT file_id, storage_key, mime_type, created_at
     FROM drawing_assets
     WHERE drawing_id = $1
       AND deleted_at IS NULL
       AND storage_deleted_at IS NULL`,
    [drawingId],
  );
  return result.rows.map((row) => ({
    fileId: row.file_id,
    storageKey: row.storage_key,
    mimeType: row.mime_type,
    createdAt: row.created_at,
  }));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const argument = (flag: string) => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  const outputDirectory = argument("--out");
  const dryRun = argv.includes("--dry-run");
  if (!outputDirectory) {
    throw new Error("--out <directory> is required");
  }

  const storage = createStorageFromEnvironment(
    process.env.STORAGE_DRIVER?.trim() || "local",
  );
  const pool = new Pool({
    connectionString: requiredEnvironment("DATABASE_URL"),
  });

  try {
    if (!dryRun) {
      await mkdir(outputDirectory, { recursive: true });
    }
    const drawings = await loadDrawings(pool);
    process.stdout.write(
      `${dryRun ? "[dry-run] " : ""}exporting ${drawings.length} drawing(s) to ${outputDirectory}\n`,
    );
    const summary = await exportDrawings({
      drawings,
      loadAssets: (drawingId) => loadLiveAssets(pool, drawingId),
      storage,
      outputDirectory,
      writeFile: (filePath, contents) => writeFile(filePath, contents),
      dryRun,
      log: (line) => process.stdout.write(`${line}\n`),
    });
    process.stdout.write(
      `done: exported=${summary.exported} inlined=${summary.assetsInlined} ` +
        `missing=${summary.missingAssets} failed=${summary.failed}\n`,
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
    process.stderr.write(`Drawing export failed: ${message}\n`);
    process.exitCode = 1;
  });
}
