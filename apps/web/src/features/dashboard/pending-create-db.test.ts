import {
  PendingCreateDb,
  deletePendingCreateDatabase,
} from "./pending-create-db";

const databases = new Set<string>();
const repositories = new Set<PendingCreateDb>();

const openDb = () => {
  const name = `pending-${crypto.randomUUID()}`;
  databases.add(name);
  const db = new PendingCreateDb(name);
  repositories.add(db);
  return db;
};

afterEach(async () => {
  await Promise.all([...repositories].map((db) => db.close()));
  await Promise.all(
    [...databases].map((name) => deletePendingCreateDatabase(name)),
  );
  repositories.clear();
  databases.clear();
});

describe("PendingCreateDb", () => {
  it("round-trips a record and survives a restart", async () => {
    const name = `pending-${crypto.randomUUID()}`;
    databases.add(name);
    const first = new PendingCreateDb(name);
    repositories.add(first);
    await first.put("user-a", "drawing-1", "Sprint board");
    await first.close();

    const restarted = new PendingCreateDb(name);
    repositories.add(restarted);
    await expect(restarted.get("user-a", "drawing-1")).resolves.toMatchObject({
      drawingId: "drawing-1",
      title: "Sprint board",
      userId: "user-a",
    });
  });

  it("lists only the given user's records, oldest first, and removes them", async () => {
    const db = openDb();
    await db.put("user-a", "drawing-1", "First");
    await db.put("user-a", "drawing-2", "Second");
    await db.put("user-b", "drawing-3", "Other account");

    const forA = await db.listByUser("user-a");
    expect(forA.map((record) => record.drawingId)).toEqual([
      "drawing-1",
      "drawing-2",
    ]);
    expect(await db.listByUser("user-b")).toHaveLength(1);

    await db.remove("user-a", "drawing-1");
    expect(await db.listByUser("user-a")).toHaveLength(1);
    expect(await db.get("user-a", "drawing-1")).toBeUndefined();
    // Removing one account's record never touches another's.
    expect(await db.listByUser("user-b")).toHaveLength(1);
  });
});
