import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";

import { auditEvents } from "./schema/audit";
import { account, session, user, verification } from "./schema/auth";
import { drawingAssets } from "./schema/assets";
import {
  drawingMutations,
  drawingRevisions,
  drawings,
} from "./schema/drawings";
import { drawingInvitations, drawingMembers } from "./schema/sharing";

export const schema = {
  account,
  auditEvents,
  drawingAssets,
  drawingInvitations,
  drawingMembers,
  drawingMutations,
  drawingRevisions,
  drawings,
  session,
  user,
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
