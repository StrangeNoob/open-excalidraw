import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { user } from "./auth.js";
import { drawings } from "./drawings.js";

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    drawingId: uuid("drawing_id")
      .notNull()
      .references(() => drawings.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("chat_messages_drawing_created_idx").on(
      table.drawingId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
    check(
      "chat_messages_body_length",
      sql`char_length(${table.body}) between 1 and 4000`,
    ),
  ],
);

export type ChatMessageRow = typeof chatMessages.$inferSelect;
