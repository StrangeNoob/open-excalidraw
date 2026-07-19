import type { ExcalidrawElementDTO } from "@open-excalidraw/contracts";

import {
  deleteOverrideSnapshotDatabase,
  OverrideSnapshotDb,
  type OverrideSnapshotScene,
} from "./override-snapshot-db";

const element = (version: number): ExcalidrawElementDTO => ({
  id: "element",
  index: "a0",
  isDeleted: false,
  type: "rectangle",
  version,
  versionNonce: version,
});

const scene = (version: number): OverrideSnapshotScene => ({
  appState: { viewBackgroundColor: "#ffffff" },
  elements: [element(version)],
  files: {},
});

describe("OverrideSnapshotDb", () => {
  it("keeps one slot per account and overwrites on the next merge", async () => {
    const databaseName = `override-${crypto.randomUUID()}`;
    const store = new OverrideSnapshotDb(databaseName);
    await store.put("user-a", "drawing", scene(5), 1_000, 1);
    await store.put("user-b", "drawing", scene(9), 2_000, 3);
    // A later merge for the same scope replaces the single slot.
    await store.put("user-a", "drawing", scene(7), 3_000, 2);

    await expect(store.get("user-a", "drawing")).resolves.toMatchObject({
      at: 3_000,
      count: 2,
      elements: [element(7)],
      userId: "user-a",
    });
    await expect(store.get("user-b", "drawing")).resolves.toMatchObject({
      count: 3,
      elements: [element(9)],
    });
    await expect(store.get("user-c", "drawing")).resolves.toBeUndefined();

    await store.close();
    await deleteOverrideSnapshotDatabase(databaseName);
  });
});
