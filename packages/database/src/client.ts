import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";

import { auditEvents } from "./schema/audit.js";
import {
  account,
  session,
  twoFactor,
  user,
  verification,
} from "./schema/auth.js";
import { chatMessages } from "./schema/chat.js";
import { drawingAssets } from "./schema/assets.js";
import {
  drawingMutations,
  drawingRevisions,
  drawings,
} from "./schema/drawings.js";
import { userLibraries } from "./schema/libraries.js";
import { drawingInvitations, drawingMembers } from "./schema/sharing.js";

export const schema = {
  account,
  auditEvents,
  chatMessages,
  drawingAssets,
  drawingInvitations,
  drawingMembers,
  drawingMutations,
  drawingRevisions,
  drawings,
  session,
  twoFactor,
  user,
  userLibraries,
  verification,
};

export type Database = ReturnType<typeof createDatabase>["db"];

export function createDatabase(config: string | PoolConfig) {
  const pool =
    typeof config === "string"
      ? new Pool({ connectionString: config })
      : new Pool(config);
  const db = drizzle(pool, { schema });

  return {
    db,
    pool,
    async close() {
      await pool.end();
    },
  };
}
