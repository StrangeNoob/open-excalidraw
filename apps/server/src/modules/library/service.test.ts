import { CONTRACT_LIMITS } from "@open-excalidraw/contracts";
import { z } from "zod";

import { LibraryService } from "./service.js";
import type { LibraryRepository, StoredLibrary } from "./types.js";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const EMPTY_AT = new Date("2026-07-18T00:00:00.000Z");
const SAVED_AT = new Date("2026-07-18T12:00:00.000Z");

function createInMemoryRepository(): LibraryRepository {
  let stored: StoredLibrary | null = null;
  return {
    get: () => Promise.resolve(stored ?? { items: [], updatedAt: EMPTY_AT }),
    put: (_userId, items) => {
      stored = { items, updatedAt: SAVED_AT };
      return Promise.resolve(stored);
    },
  };
}

describe("LibraryService", () => {
  it("returns an empty, timestamped library when nothing is stored", async () => {
    const service = new LibraryService(createInMemoryRepository());

    await expect(service.load(USER_ID)).resolves.toEqual({
      items: [],
      updatedAt: EMPTY_AT.toISOString(),
    });
  });

  it("persists items so a later load returns them", async () => {
    const service = new LibraryService(createInMemoryRepository());
    const items = [{ id: "lib-item-1", status: "published" }];

    const saved = await service.save(USER_ID, { items });
    expect(saved.items).toEqual(items);

    await expect(service.load(USER_ID)).resolves.toEqual({
      items,
      updatedAt: SAVED_AT.toISOString(),
    });
  });

  it("rejects a payload above the per-user item limit", async () => {
    const service = new LibraryService(createInMemoryRepository());
    const items = Array.from(
      { length: CONTRACT_LIMITS.libraryItemsPerUser + 1 },
      (_, index) => ({ id: `lib-item-${index}` }),
    );

    await expect(service.save(USER_ID, { items })).rejects.toBeInstanceOf(
      z.ZodError,
    );
  });
});
