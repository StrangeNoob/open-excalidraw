import type { LibraryItem } from "@open-excalidraw/contracts";
import type { Pool, QueryResultRow } from "pg";

import type { LibraryRepository, StoredLibrary } from "./types.js";

interface LibraryRow extends QueryResultRow {
  items: LibraryItem[];
  updated_at: Date;
}

export class PostgresLibraryRepository implements LibraryRepository {
  public constructor(private readonly pool: Pool) {}

  public async get(userId: string): Promise<StoredLibrary> {
    const result = await this.pool.query<LibraryRow>(
      `SELECT items, updated_at FROM user_libraries WHERE user_id = $1`,
      [userId],
    );
    const row = result.rows[0];
    // No row yet: an empty library stamped now, since the contract response
    // always carries a datetime.
    return row
      ? { items: row.items, updatedAt: row.updated_at }
      : { items: [], updatedAt: new Date() };
  }

  public async put(
    userId: string,
    items: LibraryItem[],
  ): Promise<StoredLibrary> {
    const result = await this.pool.query<{ updated_at: Date }>(
      `INSERT INTO user_libraries (user_id, items, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (user_id)
       DO UPDATE SET items = EXCLUDED.items, updated_at = now()
       RETURNING updated_at`,
      [userId, JSON.stringify(items)],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Library upsert returned no row");
    return { items, updatedAt: row.updated_at };
  }
}
