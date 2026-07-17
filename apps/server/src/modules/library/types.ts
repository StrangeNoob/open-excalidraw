import type { LibraryItem, LibraryResponse } from "@open-excalidraw/contracts";

export interface StoredLibrary {
  items: LibraryItem[];
  updatedAt: Date;
}

export interface LibraryRepository {
  get(userId: string): Promise<StoredLibrary>;
  put(userId: string, items: LibraryItem[]): Promise<StoredLibrary>;
}

export const toLibraryResponse = (library: StoredLibrary): LibraryResponse => ({
  items: library.items,
  updatedAt: library.updatedAt.toISOString(),
});
