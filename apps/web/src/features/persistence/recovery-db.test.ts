import type { DrawingSummary } from "@open-excalidraw/contracts";
import { openDB } from "idb";

import {
  CloudRecoveryRepository,
  deleteCloudRecoveryDatabase,
} from "./recovery-db";

const request = {
  assetIds: [],
  scene: {
    appState: {},
    elements: [],
    source: "test",
    type: "excalidraw" as const,
    version: 2,
  },
};

const summary: DrawingSummary = {
  contentRevision: "3",
  createdAt: "2026-07-11T00:00:00.000Z",
  id: "00000000-0000-4000-8000-000000000001",
  isTemplate: false,
  metadataRevision: "1",
  ownerName: "Ada",
  ownerUserId: "10000000-0000-4000-8000-000000000001",
  role: "owner",
  tags: [],
  thumbnailUpdatedAt: null,
  title: "Architecture",
  updatedAt: "2026-07-11T00:00:00.000Z",
};

describe("CloudRecoveryRepository", () => {
  it("never returns another account's drawing recovery", async () => {
    const databaseName = `recovery-${crypto.randomUUID()}`;
    const repository = new CloudRecoveryRepository(databaseName);
    await repository.put("user-a", "drawing", "3", request);
    await repository.put("user-b", "drawing", "7", request);

    await expect(repository.get("user-a", "drawing")).resolves.toMatchObject({
      revision: "3",
      userId: "user-a",
    });
    await expect(repository.get("user-b", "drawing")).resolves.toMatchObject({
      revision: "7",
      userId: "user-b",
    });
    await expect(repository.get("user-c", "drawing")).resolves.toBeUndefined();

    await repository.close();
    await deleteCloudRecoveryDatabase(databaseName);
  });

  it("preserves existing v1 snapshots after the v2 upgrade", async () => {
    const databaseName = `recovery-${crypto.randomUUID()}`;
    // Seed a database at the original v1 schema (snapshots store, no metadata).
    const legacy = await openDB(databaseName, 1, {
      upgrade(database) {
        database.createObjectStore("snapshots", {
          keyPath: ["userId", "drawingId"],
        });
      },
    });
    await legacy.put("snapshots", {
      assetIds: [],
      drawingId: "drawing",
      files: {},
      revision: "5",
      scene: request.scene,
      updatedAt: "2026-07-11T00:00:00.000Z",
      userId: "user-a",
    });
    legacy.close();

    // Opening through the repository migrates v1 -> v2.
    const repository = new CloudRecoveryRepository(databaseName);
    await expect(repository.get("user-a", "drawing")).resolves.toMatchObject({
      revision: "5",
      userId: "user-a",
    });

    await repository.close();
    await deleteCloudRecoveryDatabase(databaseName);
  });

  it("keeps cached metadata across later scene writes", async () => {
    const databaseName = `recovery-${crypto.randomUUID()}`;
    const repository = new CloudRecoveryRepository(databaseName);
    await repository.putMetadata("user-a", "drawing", summary);
    // A frequent autosave scene write must not wipe the cached metadata.
    await repository.put("user-a", "drawing", "9", request);

    await expect(repository.get("user-a", "drawing")).resolves.toMatchObject({
      metadata: summary,
      revision: "9",
    });

    await repository.close();
    await deleteCloudRecoveryDatabase(databaseName);
  });
});
