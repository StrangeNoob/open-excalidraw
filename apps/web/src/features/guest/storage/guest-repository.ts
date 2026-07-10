import type {
  BinaryFileData,
  BinaryFiles,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";
import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from "idb";

import type {
  CompleteGuestMigrationInput,
  GuestAssetRecord,
  GuestMigrationRecord,
  GuestSceneRecord,
  SaveGuestSceneInput,
  SaveGuestSnapshotInput,
} from "../model";

const DATABASE_VERSION = 1;
const DEFAULT_DATABASE_NAME = "open-excalidraw-guest";

interface GuestDatabaseSchema extends DBSchema {
  assets: {
    indexes: { "by-drawing": string };
    key: [string, string];
    value: GuestAssetRecord;
  };
  migrations: {
    key: string;
    value: GuestMigrationRecord;
  };
  scenes: {
    key: string;
    value: GuestSceneRecord;
  };
}

export interface GuestRepositoryOptions {
  databaseName?: string;
  now?: () => Date;
}

export class GuestRepository {
  readonly #databaseName: string;
  readonly #now: () => Date;
  #databasePromise: Promise<IDBPDatabase<GuestDatabaseSchema>> | null = null;

  constructor({
    databaseName = DEFAULT_DATABASE_NAME,
    now = () => new Date(),
  }: GuestRepositoryOptions = {}) {
    this.#databaseName = databaseName;
    this.#now = now;
  }

  async loadScene(drawingId: string): Promise<GuestSceneRecord | undefined> {
    return (await this.#database()).get("scenes", drawingId);
  }

  async saveScene(input: SaveGuestSceneInput): Promise<GuestSceneRecord> {
    const database = await this.#database();
    const transaction = database.transaction("scenes", "readwrite");
    const current = await transaction.store.get(input.drawingId);
    const next = createSceneRecord(
      {
        ...input,
        assetIds: input.assetIds ?? current?.assetIds,
      },
      (current?.revision ?? 0) + 1,
      this.#now(),
    );

    await transaction.store.put(next);
    await transaction.done;

    return next;
  }

  async saveSnapshot(input: SaveGuestSnapshotInput): Promise<GuestSceneRecord> {
    const database = await this.#database();
    const transaction = database.transaction(["scenes", "assets"], "readwrite");
    const scenes = transaction.objectStore("scenes");
    const assets = transaction.objectStore("assets");
    const current = await scenes.get(input.drawingId);
    const assetIds = Object.keys(input.files);

    for (const file of Object.values(input.files)) {
      await assets.put({ ...file, drawingId: input.drawingId });
    }

    const currentAssetIds = new Set(assetIds);
    const storedAssetKeys = await assets
      .index("by-drawing")
      .getAllKeys(input.drawingId);
    for (const key of storedAssetKeys) {
      if (!currentAssetIds.has(key[1])) {
        await assets.delete(key);
      }
    }

    const next = createSceneRecord(
      { ...input, assetIds },
      (current?.revision ?? 0) + 1,
      this.#now(),
    );

    await scenes.put(next);
    await transaction.done;

    return next;
  }

  async putAsset(drawingId: string, file: BinaryFileData): Promise<void> {
    await (await this.#database()).put("assets", { ...file, drawingId });
  }

  async getAsset(
    drawingId: string,
    fileId: string,
  ): Promise<BinaryFileData | undefined> {
    const record = await (
      await this.#database()
    ).get("assets", [drawingId, fileId]);

    if (!record) {
      return undefined;
    }

    return toBinaryFileData(record);
  }

  async getAssets(
    drawingId: string,
    fileIds?: readonly string[],
  ): Promise<BinaryFiles> {
    const database = await this.#database();
    const records = fileIds
      ? await Promise.all(
          fileIds.map((fileId) => database.get("assets", [drawingId, fileId])),
        )
      : await database.getAllFromIndex("assets", "by-drawing", drawingId);

    return Object.fromEntries(
      records.flatMap((record) => {
        if (!record) {
          return [];
        }

        const file = toBinaryFileData(record);
        return [[file.id, file]];
      }),
    );
  }

  async loadInitialData(
    drawingId: string,
  ): Promise<ExcalidrawInitialDataState | null> {
    const record = await this.loadScene(drawingId);

    if (!record) {
      return null;
    }

    return {
      ...record.scene,
      files: await this.getAssets(drawingId, record.assetIds),
    };
  }

  async getMigrationMarker(
    drawingId: string,
  ): Promise<GuestMigrationRecord | undefined> {
    return (await this.#database()).get("migrations", drawingId);
  }

  async getMigrationMarkers(): Promise<GuestMigrationRecord[]> {
    return (await this.#database()).getAll("migrations");
  }

  async markMigrationComplete(
    input: CompleteGuestMigrationInput,
  ): Promise<GuestMigrationRecord> {
    if (
      !Number.isSafeInteger(input.migratedLocalRevision) ||
      input.migratedLocalRevision < 1
    ) {
      throw new RangeError(
        "Migrated local revision must be a positive safe integer",
      );
    }

    const database = await this.#database();
    const transaction = database.transaction(
      ["scenes", "migrations"],
      "readwrite",
    );
    const scene = await transaction.objectStore("scenes").get(input.drawingId);

    if (!scene) {
      throw new Error(`Guest drawing ${input.drawingId} does not exist`);
    }

    if (input.migratedLocalRevision > scene.revision) {
      throw new RangeError(
        "Migrated local revision is newer than the guest drawing",
      );
    }

    const migrations = transaction.objectStore("migrations");
    const current = await migrations.get(input.drawingId);

    if (
      current &&
      current.targetCloudDrawingId !== input.targetCloudDrawingId
    ) {
      throw new Error(
        "Guest drawing is already linked to another cloud drawing",
      );
    }

    if (
      current &&
      current.migratedLocalRevision >= input.migratedLocalRevision
    ) {
      await transaction.done;
      return current;
    }

    const marker: GuestMigrationRecord = {
      completedAt: this.#now().toISOString(),
      ...input,
    };
    await migrations.put(marker);
    await transaction.done;

    return marker;
  }

  async clearMigrationMarker(drawingId: string): Promise<void> {
    await (await this.#database()).delete("migrations", drawingId);
  }

  async close(): Promise<void> {
    if (!this.#databasePromise) {
      return;
    }

    (await this.#databasePromise).close();
    this.#databasePromise = null;
  }

  #database(): Promise<IDBPDatabase<GuestDatabaseSchema>> {
    this.#databasePromise ??= openDB<GuestDatabaseSchema>(
      this.#databaseName,
      DATABASE_VERSION,
      {
        upgrade(database) {
          database.createObjectStore("scenes", { keyPath: "drawingId" });

          const assets = database.createObjectStore("assets", {
            keyPath: ["drawingId", "id"],
          });
          assets.createIndex("by-drawing", "drawingId");

          database.createObjectStore("migrations", {
            keyPath: "drawingId",
          });
        },
      },
    );

    return this.#databasePromise;
  }
}

export const deleteGuestDatabase = (databaseName = DEFAULT_DATABASE_NAME) =>
  deleteDB(databaseName);

const createSceneRecord = (
  input: SaveGuestSceneInput,
  revision: number,
  now: Date,
): GuestSceneRecord => ({
  assetIds: [...(input.assetIds ?? [])],
  drawingId: input.drawingId,
  revision,
  scene: input.scene,
  title: input.title,
  updatedAt: now.toISOString(),
});

const toBinaryFileData = (record: GuestAssetRecord): BinaryFileData => ({
  created: record.created,
  dataURL: record.dataURL,
  id: record.id,
  mimeType: record.mimeType,
  ...(record.lastRetrieved === undefined
    ? {}
    : { lastRetrieved: record.lastRetrieved }),
  ...(record.version === undefined ? {} : { version: record.version }),
});
