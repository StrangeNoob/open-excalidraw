import type { BinaryFiles } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElementDTO } from "@open-excalidraw/contracts";
import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from "idb";

const DEFAULT_DATABASE_NAME = "open-excalidraw-override-snapshots";

/** The local scene as it stood before a reconnect merge overrode some edits. */
export interface OverrideSnapshotScene {
  appState: Record<string, unknown>;
  elements: ExcalidrawElementDTO[];
  files: BinaryFiles;
}

export interface OverrideSnapshotRecord extends OverrideSnapshotScene {
  /** Merge time (epoch ms), matched against CollaborationState.overriddenElements. */
  at: number;
  count: number;
  drawingId: string;
  userId: string;
}

interface OverrideSnapshotSchema extends DBSchema {
  snapshots: {
    key: [string, string];
    value: OverrideSnapshotRecord;
  };
}

/**
 * Single slot per [userId, drawingId]: the pre-merge scene from the most recent
 * reconnect that overrode local edits, retained so the loss stays recoverable.
 * Overwritten on each merge; never pushed to the server (that would transiently
 * clobber collaborators). Mirrors CloudRecoveryRepository's idb shape.
 */
export class OverrideSnapshotDb {
  readonly #databaseName: string;
  #databasePromise: Promise<IDBPDatabase<OverrideSnapshotSchema>> | null = null;

  constructor(databaseName = DEFAULT_DATABASE_NAME) {
    this.#databaseName = databaseName;
  }

  async put(
    userId: string,
    drawingId: string,
    scene: OverrideSnapshotScene,
    at: number,
    count: number,
  ): Promise<void> {
    await (
      await this.#database()
    ).put("snapshots", {
      appState: scene.appState,
      at,
      count,
      drawingId,
      elements: scene.elements,
      files: scene.files,
      userId,
    });
  }

  async get(
    userId: string,
    drawingId: string,
  ): Promise<OverrideSnapshotRecord | undefined> {
    return (await this.#database()).get("snapshots", [userId, drawingId]);
  }

  async remove(userId: string, drawingId: string): Promise<void> {
    await (await this.#database()).delete("snapshots", [userId, drawingId]);
  }

  async close(): Promise<void> {
    if (this.#databasePromise) {
      (await this.#databasePromise).close();
      this.#databasePromise = null;
    }
  }

  #database() {
    this.#databasePromise ??= openDB<OverrideSnapshotSchema>(
      this.#databaseName,
      1,
      {
        upgrade(database) {
          database.createObjectStore("snapshots", {
            keyPath: ["userId", "drawingId"],
          });
        },
      },
    );
    return this.#databasePromise;
  }
}

export const deleteOverrideSnapshotDatabase = (
  databaseName = DEFAULT_DATABASE_NAME,
) => deleteDB(databaseName);
