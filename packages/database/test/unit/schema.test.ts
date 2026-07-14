import { getTableConfig } from "drizzle-orm/pg-core";

import { account, session, user, verification } from "../../src/schema/auth";
import { chatMessages } from "../../src/schema/chat";
import { drawingAssets } from "../../src/schema/assets";
import { auditEvents } from "../../src/schema/audit";
import {
  drawingMutations,
  drawingRevisions,
  drawings,
} from "../../src/schema/drawings";
import { drawingInvitations, drawingMembers } from "../../src/schema/sharing";

describe("database schema", () => {
  it("defines every Better Auth and product table", () => {
    const names = [
      user,
      session,
      account,
      verification,
      drawings,
      drawingMembers,
      drawingInvitations,
      drawingAssets,
      drawingRevisions,
      drawingMutations,
      auditEvents,
      chatMessages,
    ].map((table) => getTableConfig(table).name);

    expect(names).toEqual([
      "user",
      "session",
      "account",
      "verification",
      "drawings",
      "drawing_members",
      "drawing_invitations",
      "drawing_assets",
      "drawing_revisions",
      "drawing_mutations",
      "audit_events",
      "chat_messages",
    ]);
  });

  it("keeps chat bodies database constrained and history reads indexed", () => {
    const config = getTableConfig(chatMessages);

    expect(config.checks.map((check) => check.name)).toContain(
      "chat_messages_body_length",
    );
    expect(config.indexes.map((index) => index.config.name)).toContain(
      "chat_messages_drawing_created_idx",
    );
  });

  it("keeps membership roles database constrained", () => {
    const config = getTableConfig(drawingMembers);

    expect(config.checks.map((check) => check.name)).toContain(
      "drawing_members_role_valid",
    );
    expect(config.primaryKeys[0]?.columns.map((column) => column.name)).toEqual(
      ["drawing_id", "user_id"],
    );
  });

  it("defines the pending invitation and mutation idempotency keys", () => {
    const invitationIndexes = getTableConfig(drawingInvitations).indexes.map(
      (index) => index.config.name,
    );
    const mutationConfig = getTableConfig(drawingMutations);

    expect(invitationIndexes).toContain(
      "drawing_invitations_active_email_unique",
    );
    expect(invitationIndexes).toContain(
      "drawing_invitations_token_hash_unique",
    );
    expect(
      mutationConfig.primaryKeys[0]?.columns.map((column) => column.name),
    ).toEqual(["drawing_id", "mutation_id"]);
  });

  it("indexes active drawing and asset reads separately from cleanup reads", () => {
    expect(
      getTableConfig(drawings).indexes.map((index) => index.config.name),
    ).toEqual(
      expect.arrayContaining([
        "drawings_active_updated_at_idx",
        "drawings_deleted_at_idx",
      ]),
    );
    expect(
      getTableConfig(drawingAssets).indexes.map((index) => index.config.name),
    ).toEqual(
      expect.arrayContaining([
        "drawing_assets_active_drawing_idx",
        "drawing_assets_unreferenced_cleanup_idx",
      ]),
    );
  });
});
