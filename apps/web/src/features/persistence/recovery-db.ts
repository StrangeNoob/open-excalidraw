import type { BinaryFiles } from "@excalidraw/excalidraw/types";
import type {
  DrawingSummary,
  SaveContentRequest,
} from "@open-excalidraw/contracts";
import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from "idb";

const DEFAULT_DATABASE_NAME = "open-excalidraw-cloud-recovery";

export interface CloudRecoveryRecord {
  assetIds: string[];
  drawingId: string;
  files: BinaryFiles;
  /**
   * Drawing summary cached on the last successful server load so the page can
   * open offline. Undefined for v1 records and snapshots written before any
   * server load cached it.
   */
  metadata?: DrawingSummary;
  revision: string;
  scene: SaveContentRequest["scene"];
  updatedAt: string;
  userId: string;
}

interface StoredMetadata {
  drawingId: string;
  metadata: DrawingSummary;
  userId: string;
}

interface RecoverySchema extends DBSchema {
  // Separate store so frequent scene writes never touch cached metadata and
  // vice versa — no read-modify-write, no lost-update race between the two.
  metadata: {
    key: [string, string];
    value: StoredMetadata;
  };
  snapshots: {
    key: [string, string];
    value: CloudRecoveryRecord;
  };
}

export class CloudRecoveryRepository {
  readonly #databaseName: string;
  #databasePromise: Promise<IDBPDatabase<RecoverySchema>> | null = null;

  constructor(databaseName = DEFAULT_DATABASE_NAME) {
    this.#databaseName = databaseName;
  }

  async put(
    userId: string,
    drawingId: string,
    revision: string,
    request: SaveContentRequest,
    files: BinaryFiles = {},
  ): Promise<CloudRecoveryRecord> {
    const record: CloudRecoveryRecord = {
      assetIds: [...request.assetIds],
      drawingId,
      files: { ...files },
      revision,
      scene: request.scene,
      updatedAt: new Date().toISOString(),
      userId,
    };
    await (await this.#database()).put("snapshots", record);
    return record;
  }

  async putMetadata(
    userId: string,
    drawingId: string,
    metadata: DrawingSummary,
  ): Promise<void> {
    await (
      await this.#database()
    ).put("metadata", {
      drawingId,
      metadata,
      userId,
    });
  }

  async get(
    userId: string,
    drawingId: string,
  ): Promise<CloudRecoveryRecord | undefined> {
    const database = await this.#database();
    const snapshot = await database.get("snapshots", [userId, drawingId]);
    if (!snapshot) {
      return undefined;
    }
    const stored = await database.get("metadata", [userId, drawingId]);
    return stored ? { ...snapshot, metadata: stored.metadata } : snapshot;
  }

  async remove(userId: string, drawingId: string) {
    await (await this.#database()).delete("snapshots", [userId, drawingId]);
  }

  async close() {
    if (this.#databasePromise) {
      (await this.#databasePromise).close();
      this.#databasePromise = null;
    }
  }

  #database() {
    this.#databasePromise ??= openDB<RecoverySchema>(this.#databaseName, 2, {
      upgrade(database, oldVersion) {
        if (oldVersion < 1) {
          database.createObjectStore("snapshots", {
            keyPath: ["userId", "drawingId"],
          });
        }
        // v1 -> v2: existing snapshots are preserved untouched; they simply
        // lack cached metadata until the next server load writes it.
        if (oldVersion < 2) {
          database.createObjectStore("metadata", {
            keyPath: ["userId", "drawingId"],
          });
        }
      },
    });
    return this.#databasePromise;
  }
}

export const createRecoveryWriter =
  (repository: CloudRecoveryRepository, userId: string, drawingId: string) =>
  async (
    snapshot: { request: SaveContentRequest; files?: unknown },
    revision: string,
  ) => {
    await repository.put(
      userId,
      drawingId,
      revision,
      snapshot.request,
      isBinaryFiles(snapshot.files) ? snapshot.files : {},
    );
  };

export const deleteCloudRecoveryDatabase = (
  databaseName = DEFAULT_DATABASE_NAME,
) => deleteDB(databaseName);

const isBinaryFiles = (value: unknown): value is BinaryFiles =>
  typeof value === "object" && value !== null;
