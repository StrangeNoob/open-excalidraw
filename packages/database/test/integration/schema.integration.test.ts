import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from "testcontainers";
import { Pool } from "pg";

import { migrationChecksum, runMigrations } from "../../src/migrate";
import { drawingIsActive, drawings } from "../../src/schema/drawings";

const POSTGRES_PORT = 5432;
const POSTGRES_USER = "open_excalidraw";
const POSTGRES_PASSWORD = "open_excalidraw";
const POSTGRES_DATABASE = "open_excalidraw_test";

let container: StartedTestContainer | undefined;
let pool: Pool;

async function createUser(email = `${randomUUID()}@example.test`) {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO "user" (name, email) VALUES ($1, $2) RETURNING id`,
    ["Test User", email],
  );
  return result.rows[0]!.id;
}

const emptyScene = {
  type: "excalidraw",
  version: 2,
  source: "https://open-excalidraw.test",
  elements: [],
  appState: {},
};

async function createDrawing(
  ownerUserId: string,
  title: string = randomUUID(),
) {
  const result = await pool.query<{ id: string }>(
    `
      INSERT INTO drawings (
        owner_user_id, title, scene, scene_format_version, scene_bytes
      ) VALUES ($1, $2, $3, 1, $4)
      RETURNING id
    `,
    [ownerUserId, title, emptyScene, JSON.stringify(emptyScene).length],
  );
  return result.rows[0]!.id;
}

beforeAll(async () => {
  const externalDatabaseUrl = process.env.DATABASE_TEST_URL;
  if (externalDatabaseUrl) {
    pool = new Pool({ connectionString: externalDatabaseUrl });
    return;
  }

  container = await new GenericContainer("postgres:17-alpine")
    .withEnvironment({
      POSTGRES_USER,
      POSTGRES_PASSWORD,
      POSTGRES_DB: POSTGRES_DATABASE,
    })
    .withExposedPorts(POSTGRES_PORT)
    .withWaitStrategy(
      Wait.forLogMessage("database system is ready to accept connections", 2),
    )
    .start();

  pool = new Pool({
    host: container.getHost(),
    port: container.getMappedPort(POSTGRES_PORT),
    user: POSTGRES_USER,
    password: POSTGRES_PASSWORD,
    database: POSTGRES_DATABASE,
  });
}, 60_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe("initial PostgreSQL migration", () => {
  it("migrates an empty database and is idempotent", async () => {
    const first = await runMigrations({ pool });
    const second = await runMigrations({ pool });
    const record = await pool.query<{
      name: string;
      checksum: string;
    }>(`SELECT name, checksum FROM open_excalidraw_migrations ORDER BY name`);

    expect(first.applied.map(({ name }) => name)).toEqual([
      "0001_initial.sql",
      "0002_mutation_noop.sql",
      "0003_asset_cleanup_state.sql",
      "0004_chat_messages.sql",
    ]);
    expect(second.alreadyApplied).toEqual(first.applied);
    expect(record.rows).toEqual(first.applied);
  });

  it("rejects a changed migration after its checksum is recorded", async () => {
    const directory = await mkdtemp(join(tmpdir(), "open-excalidraw-db-"));
    const original = await readFile(
      new URL("../../migrations/0001_initial.sql", import.meta.url),
      "utf8",
    );
    const changed = `${original}\n-- mutation that must be detected\n`;
    await writeFile(join(directory, "0001_initial.sql"), changed);

    await expect(
      runMigrations({ pool, migrationsDirectory: directory }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: "MigrationChecksumError",
        migration: "0001_initial.sql",
        actualChecksum: migrationChecksum(changed),
      }),
    );

    await rm(directory, { recursive: true, force: true });
  });
});

describe("database constraints", () => {
  it("installs every declared foreign key and domain uniqueness index", async () => {
    const foreignKeys = await pool.query<{
      local_table: string;
      local_column: string;
      foreign_table: string;
      foreign_column: string;
    }>(`
      SELECT
        tc.table_name AS local_table,
        kcu.column_name AS local_column,
        ccu.table_name AS foreign_table,
        ccu.column_name AS foreign_column
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_catalog = kcu.constraint_catalog
        AND tc.constraint_schema = kcu.constraint_schema
        AND tc.constraint_name = kcu.constraint_name
      JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_catalog = ccu.constraint_catalog
        AND tc.constraint_schema = ccu.constraint_schema
        AND tc.constraint_name = ccu.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = 'public'
      ORDER BY local_table, local_column
    `);
    const installedForeignKeys = foreignKeys.rows.map(
      (row) =>
        `${row.local_table}.${row.local_column}->${row.foreign_table}.${row.foreign_column}`,
    );

    expect(installedForeignKeys).toEqual([
      "account.user_id->user.id",
      "audit_events.actor_user_id->user.id",
      "audit_events.drawing_id->drawings.id",
      "chat_messages.drawing_id->drawings.id",
      "chat_messages.user_id->user.id",
      "drawing_assets.created_by_user_id->user.id",
      "drawing_assets.drawing_id->drawings.id",
      "drawing_invitations.accepted_by_user_id->user.id",
      "drawing_invitations.drawing_id->drawings.id",
      "drawing_invitations.invited_by_user_id->user.id",
      "drawing_members.created_by_user_id->user.id",
      "drawing_members.drawing_id->drawings.id",
      "drawing_members.user_id->user.id",
      "drawing_mutations.drawing_id->drawings.id",
      "drawing_revisions.author_user_id->user.id",
      "drawing_revisions.drawing_id->drawings.id",
      "drawings.owner_user_id->user.id",
      "session.user_id->user.id",
    ]);

    const indexes = await pool.query<{ indexname: string }>(`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
    `);
    const indexNames = indexes.rows.map((row) => row.indexname);
    expect(indexNames).toEqual(
      expect.arrayContaining([
        "user_email_unique",
        "session_token_unique",
        "account_provider_account_unique",
        "drawing_invitations_token_hash_unique",
        "drawing_invitations_active_email_unique",
        "drawing_assets_storage_key_unique",
        "drawing_assets_drawing_file_unique",
        "drawing_revisions_drawing_revision_unique",
      ]),
    );
  });

  it("rejects invalid member and invitation roles", async () => {
    const owner = await createUser();
    const member = await createUser();
    const drawing = await createDrawing(owner);

    await expect(
      pool.query(
        `
          INSERT INTO drawing_members (
            drawing_id, user_id, role, created_by_user_id
          ) VALUES ($1, $2, 'owner', $3)
        `,
        [drawing, member, owner],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    await expect(
      pool.query(
        `
          INSERT INTO drawing_invitations (
            drawing_id, invitee_email, role, token_hash, invited_by_user_id,
            expires_at, delivery_status
          ) VALUES ($1, 'invalid-role@example.test', 'owner', $2, $3, now() + interval '7 days', 'manual')
        `,
        [drawing, randomBytes(32), owner],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("allows only one pending invitation per drawing and case-insensitive email", async () => {
    const owner = await createUser();
    const drawing = await createDrawing(owner);

    await pool.query(
      `
        INSERT INTO drawing_invitations (
          drawing_id, invitee_email, role, token_hash, invited_by_user_id,
          expires_at, delivery_status
        ) VALUES ($1, 'Invitee@Example.test', 'viewer', $2, $3, now() + interval '7 days', 'manual')
      `,
      [drawing, randomBytes(32), owner],
    );

    await expect(
      pool.query(
        `
          INSERT INTO drawing_invitations (
            drawing_id, invitee_email, role, token_hash, invited_by_user_id,
            expires_at, delivery_status
          ) VALUES ($1, 'invitee@example.TEST', 'editor', $2, $3, now() + interval '7 days', 'sent')
        `,
        [drawing, randomBytes(32), owner],
      ),
    ).rejects.toMatchObject({ code: "23505" });

    await pool.query(
      `UPDATE drawing_invitations SET revoked_at = now() WHERE drawing_id = $1`,
      [drawing],
    );
    await expect(
      pool.query(
        `
          INSERT INTO drawing_invitations (
            drawing_id, invitee_email, role, token_hash, invited_by_user_id,
            expires_at, delivery_status
          ) VALUES ($1, 'invitee@example.test', 'editor', $2, $3, now() + interval '7 days', 'sent')
        `,
        [drawing, randomBytes(32), owner],
      ),
    ).resolves.toBeDefined();
  });

  it("anonymizes the accepting user without erasing invitation acceptance", async () => {
    const owner = await createUser();
    const acceptingUser = await createUser();
    const drawing = await createDrawing(owner);
    const invitation = await pool.query<{
      id: string;
      accepted_at: Date;
    }>(
      `
        INSERT INTO drawing_invitations (
          drawing_id, invitee_email, role, token_hash, invited_by_user_id,
          expires_at, accepted_at, accepted_by_user_id, delivery_status
        ) VALUES (
          $1, 'accepted@example.test', 'viewer', $2, $3,
          now() + interval '7 days', now(), $4, 'sent'
        )
        RETURNING id, accepted_at
      `,
      [drawing, randomBytes(32), owner, acceptingUser],
    );

    await pool.query(`DELETE FROM "user" WHERE id = $1`, [acceptingUser]);

    const anonymized = await pool.query<{
      accepted_at: Date;
      accepted_by_user_id: string | null;
    }>(
      `
        SELECT accepted_at, accepted_by_user_id
        FROM drawing_invitations
        WHERE id = $1
      `,
      [invitation.rows[0]!.id],
    );

    expect(anonymized.rows[0]).toEqual({
      accepted_at: invitation.rows[0]!.accepted_at,
      accepted_by_user_id: null,
    });
  });

  it("enforces foreign keys, uniqueness, and asset integrity", async () => {
    const owner = await createUser();
    const member = await createUser();
    const drawing = await createDrawing(owner);

    await expect(
      pool.query(
        `
          INSERT INTO drawing_members (
            drawing_id, user_id, role, created_by_user_id
          ) VALUES ($1, $2, 'viewer', $3)
        `,
        [randomUUID(), member, owner],
      ),
    ).rejects.toMatchObject({ code: "23503" });

    await pool.query(
      `
        INSERT INTO drawing_members (
          drawing_id, user_id, role, created_by_user_id
        ) VALUES ($1, $2, 'viewer', $3)
      `,
      [drawing, member, owner],
    );
    await expect(
      pool.query(
        `
          INSERT INTO drawing_members (
            drawing_id, user_id, role, created_by_user_id
          ) VALUES ($1, $2, 'editor', $3)
        `,
        [drawing, member, owner],
      ),
    ).rejects.toMatchObject({ code: "23505" });

    await expect(
      pool.query(
        `
          INSERT INTO drawing_assets (
            drawing_id, file_id, storage_key, mime_type, byte_size, sha256,
            created_by_user_id
          ) VALUES ($1, 'file-1', 'asset/key', 'image/png', 10, $2, $3)
        `,
        [drawing, randomBytes(31), owner],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("scopes mutation idempotency to a drawing", async () => {
    const owner = await createUser();
    const firstDrawing = await createDrawing(owner);
    const secondDrawing = await createDrawing(owner);
    const mutationId = randomUUID();
    const values = [mutationId, randomBytes(32)];

    const insertMutation = (drawingId: string) =>
      pool.query(
        `
          INSERT INTO drawing_mutations (
            drawing_id, mutation_id, payload_hash, base_revision,
            resulting_revision
          ) VALUES ($1, $2, $3, 0, 1)
        `,
        [drawingId, ...values],
      );

    await insertMutation(firstDrawing);
    await expect(insertMutation(firstDrawing)).rejects.toMatchObject({
      code: "23505",
    });
    await expect(insertMutation(secondDrawing)).resolves.toBeDefined();

    await expect(
      pool.query(
        `
          INSERT INTO drawing_mutations (
            drawing_id, mutation_id, payload_hash, base_revision,
            resulting_revision
          ) VALUES ($1, $2, $3, 1, 1)
        `,
        [firstDrawing, randomUUID(), randomBytes(32)],
      ),
    ).resolves.toBeDefined();
    await expect(
      pool.query(
        `
          INSERT INTO drawing_mutations (
            drawing_id, mutation_id, payload_hash, base_revision,
            resulting_revision
          ) VALUES ($1, $2, $3, 2, 1)
        `,
        [firstDrawing, randomUUID(), randomBytes(32)],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

describe("chat messages", () => {
  it("constrains bodies and cascades with the drawing", async () => {
    const ownerId = await createUser();
    const drawingId = await createDrawing(ownerId);

    await expect(
      pool.query(
        `INSERT INTO chat_messages (drawing_id, user_id, body) VALUES ($1, $2, $3)`,
        [drawingId, ownerId, ""],
      ),
    ).rejects.toMatchObject({ constraint: "chat_messages_body_length" });

    await expect(
      pool.query(
        `INSERT INTO chat_messages (drawing_id, user_id, body) VALUES ($1, $2, $3)`,
        [drawingId, ownerId, "   "],
      ),
    ).rejects.toMatchObject({ constraint: "chat_messages_body_length" });

    await pool.query(
      `INSERT INTO chat_messages (drawing_id, user_id, body) VALUES ($1, $2, $3)`,
      [drawingId, ownerId, "hello"],
    );
    await pool.query(`DELETE FROM drawings WHERE id = $1`, [drawingId]);

    const remaining = await pool.query(
      `SELECT id FROM chat_messages WHERE drawing_id = $1`,
      [drawingId],
    );
    expect(remaining.rowCount).toBe(0);
  });
});

describe("soft deletion", () => {
  it("uses the canonical active-drawing predicate for user-facing reads", async () => {
    const owner = await createUser();
    const activeId = await createDrawing(owner, "active-drawing");
    const deletedId = await createDrawing(owner, "deleted-drawing");
    await pool.query(`UPDATE drawings SET deleted_at = now() WHERE id = $1`, [
      deletedId,
    ]);

    const db = drizzle(pool);
    const rows = await db
      .select({ id: drawings.id })
      .from(drawings)
      .where(drawingIsActive());
    const ids = rows.map((row) => row.id);

    expect(ids).toContain(activeId);
    expect(ids).not.toContain(deletedId);
  });
});
