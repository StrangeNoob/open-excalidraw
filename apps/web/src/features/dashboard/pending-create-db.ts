import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from "idb";

const DEFAULT_DATABASE_NAME = "open-excalidraw-pending-creates";

export interface PendingCreateRecord {
  createdAt: string;
  drawingId: string;
  title: string;
  userId: string;
}

interface PendingCreateSchema extends DBSchema {
  creates: {
    indexes: { "by-user": string };
    key: [string, string];
    value: PendingCreateRecord;
  };
}

/**
 * Drawings created while offline, keyed [userId, drawingId], awaiting a
 * server create on reconnect. Mirrors CloudOutboxDb: per-user index, restart
 * survives, accounts never cross.
 */
export class PendingCreateDb {
  readonly #databaseName: string;
  #databasePromise: Promise<IDBPDatabase<PendingCreateSchema>> | null = null;

  constructor(databaseName = DEFAULT_DATABASE_NAME) {
    this.#databaseName = databaseName;
  }

  async put(userId: string, drawingId: string, title: string): Promise<void> {
    await (
      await this.#database()
    ).put("creates", {
      createdAt: new Date().toISOString(),
      drawingId,
      title,
      userId,
    });
  }

  async get(
    userId: string,
    drawingId: string,
  ): Promise<PendingCreateRecord | undefined> {
    return (await this.#database()).get("creates", [userId, drawingId]);
  }

  async listByUser(userId: string): Promise<PendingCreateRecord[]> {
    const records = await (
      await this.#database()
    ).getAllFromIndex("creates", "by-user", userId);
    // Stable oldest-first order so replay matches creation order.
    return records.sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    );
  }

  async remove(userId: string, drawingId: string): Promise<void> {
    await (await this.#database()).delete("creates", [userId, drawingId]);
  }

  async close(): Promise<void> {
    if (this.#databasePromise) {
      (await this.#databasePromise).close();
      this.#databasePromise = null;
    }
  }

  #database() {
    this.#databasePromise ??= openDB<PendingCreateSchema>(
      this.#databaseName,
      1,
      {
        upgrade(database) {
          const creates = database.createObjectStore("creates", {
            keyPath: ["userId", "drawingId"],
          });
          creates.createIndex("by-user", "userId");
        },
      },
    );
    return this.#databasePromise;
  }
}

export const deletePendingCreateDatabase = (
  databaseName = DEFAULT_DATABASE_NAME,
) => deleteDB(databaseName);
