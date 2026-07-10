import type { BinaryFiles } from "@excalidraw/excalidraw/types";
import type {
  ClientRealtimeEvent,
  ExcalidrawElementDTO,
} from "@open-excalidraw/contracts";
import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from "idb";

const DEFAULT_DATABASE_NAME = "open-excalidraw-cloud-outbox";

export interface CloudOutboxRecord {
  baseRevision: string;
  createdAt: string;
  drawingId: string;
  elements: ExcalidrawElementDTO[];
  /** Local blobs required by this mutation, retained until the server acks it. */
  files?: BinaryFiles;
  generation: number;
  mutationId: string;
  sharedSceneState?: Extract<
    ClientRealtimeEvent,
    { type: "scene.mutate" }
  >["sharedSceneState"];
  userId: string;
}

interface CloudOutboxSchema extends DBSchema {
  mutations: {
    indexes: { "by-scope": [string, string] };
    key: [string, string, string];
    value: CloudOutboxRecord;
  };
}

export class CloudOutboxDb {
  readonly #databaseName: string;
  #databasePromise: Promise<IDBPDatabase<CloudOutboxSchema>> | null = null;

  constructor(databaseName = DEFAULT_DATABASE_NAME) {
    this.#databaseName = databaseName;
  }

  async put(record: CloudOutboxRecord): Promise<void> {
    await (await this.#database()).put("mutations", record);
  }

  async list(userId: string, drawingId: string): Promise<CloudOutboxRecord[]> {
    const records = await (
      await this.#database()
    ).getAllFromIndex("mutations", "by-scope", [userId, drawingId]);
    return records.sort(
      (left, right) =>
        left.generation - right.generation ||
        left.mutationId.localeCompare(right.mutationId),
    );
  }

  async remove(
    userId: string,
    drawingId: string,
    mutationId: string,
  ): Promise<void> {
    await (
      await this.#database()
    ).delete("mutations", [userId, drawingId, mutationId]);
  }

  async clearScope(userId: string, drawingId: string): Promise<void> {
    const database = await this.#database();
    const transaction = database.transaction("mutations", "readwrite");
    const keys = await transaction.store
      .index("by-scope")
      .getAllKeys([userId, drawingId]);
    await Promise.all(keys.map((key) => transaction.store.delete(key)));
    await transaction.done;
  }

  async close(): Promise<void> {
    if (this.#databasePromise) {
      (await this.#databasePromise).close();
      this.#databasePromise = null;
    }
  }

  #database() {
    this.#databasePromise ??= openDB<CloudOutboxSchema>(this.#databaseName, 1, {
      upgrade(database) {
        const mutations = database.createObjectStore("mutations", {
          keyPath: ["userId", "drawingId", "mutationId"],
        });
        mutations.createIndex("by-scope", ["userId", "drawingId"]);
      },
    });
    return this.#databasePromise;
  }
}

export const deleteCloudOutboxDatabase = (
  databaseName = DEFAULT_DATABASE_NAME,
) => deleteDB(databaseName);
