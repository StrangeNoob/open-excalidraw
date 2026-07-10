import { readFile } from "node:fs/promises";

import { migrationChecksum } from "../../src/migrate";

const INITIAL_MIGRATION_CHECKSUM =
  "b1c3ff7d0c6fa4d0ef2c8847096537e80012fb9cb9bb969cf2fb78e1c630e2fc";

describe("initial migration snapshot", () => {
  it("is immutable after the Wave 1 schema freeze", async () => {
    const migration = await readFile(
      new URL("../../migrations/0001_initial.sql", import.meta.url),
    );

    expect(migrationChecksum(migration)).toBe(INITIAL_MIGRATION_CHECKSUM);
  });

  it("contains all auth and product tables", async () => {
    const migration = await readFile(
      new URL("../../migrations/0001_initial.sql", import.meta.url),
      "utf8",
    );

    for (const table of [
      '"user"',
      '"session"',
      "account",
      "verification",
      "drawings",
      "drawing_members",
      "drawing_invitations",
      "drawing_assets",
      "drawing_revisions",
      "drawing_mutations",
      "audit_events",
    ]) {
      expect(migration).toContain(`CREATE TABLE ${table}`);
    }
  });
});
