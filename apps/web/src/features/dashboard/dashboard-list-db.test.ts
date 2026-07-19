import type { DrawingListResponse } from "@open-excalidraw/contracts";

import {
  DashboardListDb,
  deleteDashboardListDatabase,
} from "./dashboard-list-db";

const list = (title: string): DrawingListResponse => ({
  nextCursor: null,
  owned: [
    {
      contentRevision: "1",
      createdAt: "2026-07-10T10:00:00.000Z",
      id: "00000000-0000-4000-8000-000000000001",
      isTemplate: false,
      metadataRevision: "1",
      ownerName: "Ada",
      ownerUserId: "10000000-0000-4000-8000-000000000001",
      role: "owner",
      tags: [],
      thumbnailUpdatedAt: null,
      title,
      updatedAt: "2026-07-10T12:30:00.000Z",
    },
  ],
  shared: [],
});

const databases = new Set<string>();
const repositories = new Set<DashboardListDb>();

afterEach(async () => {
  await Promise.all([...repositories].map((repository) => repository.close()));
  await Promise.all(
    [...databases].map((name) => deleteDashboardListDatabase(name)),
  );
  repositories.clear();
  databases.clear();
});

describe("DashboardListDb", () => {
  it("round-trips a list and never crosses accounts", async () => {
    const databaseName = `dashboard-${crypto.randomUUID()}`;
    databases.add(databaseName);
    const cache = new DashboardListDb(databaseName);
    repositories.add(cache);

    const stored = await cache.put("user-a", list("Ada board"));
    await cache.put("user-b", list("Grace board"));

    expect(stored.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    await expect(cache.get("user-a")).resolves.toMatchObject({
      fetchedAt: stored.fetchedAt,
      list: list("Ada board"),
      userId: "user-a",
    });
    await expect(cache.get("user-b")).resolves.toMatchObject({
      userId: "user-b",
    });
    await expect(cache.get("user-c")).resolves.toBeUndefined();
  });

  it("survives a repository restart and overwrites the same user's entry", async () => {
    const databaseName = `dashboard-${crypto.randomUUID()}`;
    databases.add(databaseName);
    const first = new DashboardListDb(databaseName);
    repositories.add(first);
    await first.put("user-a", list("Old board"));
    await first.put("user-a", list("New board"));
    await first.close();

    const restarted = new DashboardListDb(databaseName);
    repositories.add(restarted);
    await expect(restarted.get("user-a")).resolves.toMatchObject({
      list: list("New board"),
    });
  });
});
