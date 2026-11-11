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
});
