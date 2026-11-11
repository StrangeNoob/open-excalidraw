import type { BinaryFiles } from "@excalidraw/excalidraw/types";
import type { SaveContentRequest } from "@open-excalidraw/contracts";
import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from "idb";

const DEFAULT_DATABASE_NAME = "open-excalidraw-cloud-recovery";

export interface CloudRecoveryRecord {
  assetIds: string[];
  drawingId: string;
  files: BinaryFiles;
  revision: string;
  scene: SaveContentRequest["scene"];
  updatedAt: string;
  userId: string;
}

interface RecoverySchema extends DBSchema {
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

  async get(userId: string, drawingId: string) {
    return (await this.#database()).get("snapshots", [userId, drawingId]);
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
    this.#databasePromise ??= openDB<RecoverySchema>(this.#databaseName, 1, {
      upgrade(database) {
        database.createObjectStore("snapshots", {
          keyPath: ["userId", "drawingId"],
        });
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
