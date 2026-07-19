import type { DrawingListResponse } from "@open-excalidraw/contracts";
import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from "idb";

const DEFAULT_DATABASE_NAME = "open-excalidraw-dashboard-list";

export interface DashboardListRecord {
  /** ISO timestamp of the successful fetch this list came from. */
  fetchedAt: string;
  list: DrawingListResponse;
  userId: string;
}

interface DashboardListSchema extends DBSchema {
  lists: {
    key: string;
    value: DashboardListRecord;
  };
}

export class DashboardListDb {
  readonly #databaseName: string;
  #databasePromise: Promise<IDBPDatabase<DashboardListSchema>> | null = null;

  constructor(databaseName = DEFAULT_DATABASE_NAME) {
    this.#databaseName = databaseName;
  }

  async put(
    userId: string,
    list: DrawingListResponse,
  ): Promise<DashboardListRecord> {
    const record: DashboardListRecord = {
      fetchedAt: new Date().toISOString(),
      list,
      userId,
    };
    await (await this.#database()).put("lists", record);
    return record;
  }

  async get(userId: string): Promise<DashboardListRecord | undefined> {
    return (await this.#database()).get("lists", userId);
  }

  async close(): Promise<void> {
    if (this.#databasePromise) {
      (await this.#databasePromise).close();
      this.#databasePromise = null;
    }
  }

  #database() {
    this.#databasePromise ??= openDB<DashboardListSchema>(
      this.#databaseName,
      1,
      {
        upgrade(database) {
          database.createObjectStore("lists", { keyPath: "userId" });
        },
      },
    );
    return this.#databasePromise;
  }
}

export const deleteDashboardListDatabase = (
  databaseName = DEFAULT_DATABASE_NAME,
) => deleteDB(databaseName);
