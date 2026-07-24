import { sql } from "drizzle-orm";
import {
  customType,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { drawings } from "./drawings.js";

// tsvector has no first-class drizzle column type; it is written by migration
// 0015 as a STORED generated column and only read here.
const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

export const drawingSearchTexts = pgTable(
  "drawing_search_texts",
  {
    drawingId: uuid("drawing_id")
      .primaryKey()
      .references(() => drawings.id, { onDelete: "cascade" }),
    extractedText: text("extracted_text").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    // Postgres maintains this from extracted_text; the expression is declared
    // for parity with the migration, not to emit DDL (migrations are the DDL).
    searchTsv: tsvector("search_tsv").generatedAlwaysAs(
      sql`to_tsvector('simple', left(extracted_text, 300000))`,
    ),
  },
  (table) => [
    index("drawing_search_texts_search_tsv_idx").using("gin", table.searchTsv),
  ],
);

export type DrawingSearchText = typeof drawingSearchTexts.$inferSelect;
