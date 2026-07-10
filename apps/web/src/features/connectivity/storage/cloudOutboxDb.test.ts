import {
  CloudOutboxDb,
  deleteCloudOutboxDatabase,
  type CloudOutboxRecord,
} from "./cloudOutboxDb";

const databases = new Set<string>();
const repositories = new Set<CloudOutboxDb>();

const record = (
  userId: string,
  drawingId: string,
  mutationId: string,
  generation: number,
): CloudOutboxRecord => ({
  baseRevision: "1",
  createdAt: "2026-07-11T00:00:00.000Z",
  drawingId,
  elements: [
    {
      id: "element",
      isDeleted: false,
      type: "rectangle",
      version: generation,
      versionNonce: generation,
    },
  ],
  generation,
  mutationId,
  userId,
});

afterEach(async () => {
  await Promise.all([...repositories].map((repository) => repository.close()));
  await Promise.all(
    [...databases].map((name) => deleteCloudOutboxDatabase(name)),
  );
  repositories.clear();
  databases.clear();
});

describe("CloudOutboxDb", () => {
  it("survives repository restart and never crosses accounts or drawings", async () => {
    const databaseName = `outbox-${crypto.randomUUID()}`;
    databases.add(databaseName);
    const first = new CloudOutboxDb(databaseName);
    repositories.add(first);
    await first.put(record("user-a", "drawing-a", "mutation-a", 1));
    await first.put(record("user-b", "drawing-a", "mutation-b", 2));
    await first.put(record("user-a", "drawing-b", "mutation-c", 3));
    await first.close();

    const restarted = new CloudOutboxDb(databaseName);
    repositories.add(restarted);
    await expect(restarted.list("user-a", "drawing-a")).resolves.toEqual([
      record("user-a", "drawing-a", "mutation-a", 1),
    ]);
    await expect(restarted.list("user-b", "drawing-a")).resolves.toEqual([
      record("user-b", "drawing-a", "mutation-b", 2),
    ]);
    await expect(restarted.list("user-a", "drawing-b")).resolves.toEqual([
      record("user-a", "drawing-b", "mutation-c", 3),
    ]);
  });
});
