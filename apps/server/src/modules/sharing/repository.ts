import type { Pool, PoolClient, QueryResultRow } from "pg";

import { insertAuditEvent } from "../audit.js";
import type {
  CreateShareResult,
  InvitationRecord,
  MemberRecord,
  SharingRepository,
} from "./types.js";

interface InvitationRow extends QueryResultRow {
  id: string;
  drawing_id: string;
  drawing_title: string;
  invitee_email: string;
  role: "editor" | "viewer";
  expires_at: Date;
  accepted_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
  delivery_status: "sent" | "manual" | "failed";
  inviter_name: string;
  invited_by_user_id: string;
}

interface MemberRow extends QueryResultRow {
  user_id: string;
  email: string;
  name: string;
  image: string | null;
  role: "owner" | "editor" | "viewer";
  created_at: Date;
}

export class PostgresSharingRepository implements SharingRepository {
  public constructor(private readonly pool: Pool) {}

  public async list(drawingId: string, actorUserId: string) {
    return transaction(this.pool, async (client) => {
      const access = await lockDrawingAccess(
        client,
        drawingId,
        actorUserId,
        "share",
      );
      if (access === "not-found") return { status: "not-found" as const };
      if (access === "member") return { status: "forbidden" as const };
      const members = await client.query<MemberRow>(
        `SELECT d.owner_user_id AS user_id, u.email, u.name, u.image,
                'owner'::text AS role, d.created_at
         FROM drawings d JOIN "user" u ON u.id = d.owner_user_id WHERE d.id = $1
         UNION ALL
         SELECT m.user_id, u.email, u.name, u.image, m.role, m.created_at
         FROM drawing_members m JOIN "user" u ON u.id = m.user_id
         WHERE m.drawing_id = $1 ORDER BY created_at`,
        [drawingId],
      );
      const invitations = await client.query<InvitationRow>(
        `${INVITATION_SELECT} WHERE i.drawing_id = $1 ORDER BY i.created_at DESC`,
        [drawingId],
      );
      return {
        status: "ok" as const,
        members: members.rows.map(mapMember),
        invitations: invitations.rows.map(mapInvitation),
      };
    });
  }

  public async createShare(input: {
    drawingId: string;
    actorUserId: string;
    email: string;
    role: "editor" | "viewer";
    tokenHash: Buffer;
    expiresAt: Date;
    auditRequestId?: string;
  }): Promise<CreateShareResult> {
    return transaction(this.pool, async (client) => {
      const access = await lockDrawingAccess(
        client,
        input.drawingId,
        input.actorUserId,
        "update",
      );
      if (access === "not-found") return { status: "not-found" };
      if (access === "member") {
        await auditRejected(client, input, "invite");
        return { status: "forbidden" };
      }

      const found = await client.query<{
        id: string;
        email: string;
        name: string;
        image: string | null;
        created_at: Date;
      }>(
        `SELECT id, email, name, image, created_at FROM "user" WHERE email = $1 LIMIT 1`,
        [input.email],
      );
      const existingUser = found.rows[0];
      if (existingUser) {
        await client.query(
          `UPDATE drawing_invitations SET revoked_at = now()
           WHERE drawing_id = $1 AND invitee_email = $2
             AND accepted_at IS NULL AND revoked_at IS NULL`,
          [input.drawingId, input.email],
        );
        if (existingUser.id === input.actorUserId) {
          if (input.auditRequestId) {
            await insertAuditEvent(client, {
              actorUserId: input.actorUserId,
              drawingId: input.drawingId,
              eventType: "sharing.member_upserted",
              requestId: input.auditRequestId,
              metadata: { targetUserId: existingUser.id, role: "owner" },
            });
          }
          return {
            status: "membership",
            member: {
              userId: existingUser.id,
              email: existingUser.email,
              name: existingUser.name,
              image: existingUser.image,
              role: "owner",
              createdAt: existingUser.created_at,
            },
          };
        }
        const inserted = await client.query<MemberRow>(
          `INSERT INTO drawing_members (drawing_id, user_id, role, created_by_user_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (drawing_id, user_id) DO UPDATE SET role = EXCLUDED.role
           RETURNING user_id, $5::text AS email, $6::text AS name,
                     $7::text AS image, role, created_at`,
          [
            input.drawingId,
            existingUser.id,
            input.role,
            input.actorUserId,
            existingUser.email,
            existingUser.name,
            existingUser.image,
          ],
        );
        const member = inserted.rows[0];
        if (!member) throw new Error("Membership upsert returned no row");
        if (input.auditRequestId) {
          await insertAuditEvent(client, {
            actorUserId: input.actorUserId,
            drawingId: input.drawingId,
            eventType: "sharing.member_upserted",
            requestId: input.auditRequestId,
            metadata: { targetUserId: existingUser.id, role: input.role },
          });
        }
        return { status: "membership", member: mapMember(member) };
      }

      await client.query(
        `UPDATE drawing_invitations SET revoked_at = now()
         WHERE drawing_id = $1 AND invitee_email = $2
           AND accepted_at IS NULL AND revoked_at IS NULL`,
        [input.drawingId, input.email],
      );
      const inserted = await client.query<InvitationRow>(
        `WITH created AS (
           INSERT INTO drawing_invitations
             (drawing_id, invitee_email, role, token_hash, invited_by_user_id,
              expires_at, delivery_status)
           VALUES ($1, $2, $3, $4, $5, $6, 'manual') RETURNING *
         )
         SELECT i.id, i.drawing_id, d.title AS drawing_title,
                i.invitee_email, i.role, i.expires_at, i.accepted_at,
                i.revoked_at, i.created_at, i.delivery_status,
                u.name AS inviter_name, i.invited_by_user_id
         FROM created i JOIN drawings d ON d.id = i.drawing_id
         JOIN "user" u ON u.id = i.invited_by_user_id`,
        [
          input.drawingId,
          input.email,
          input.role,
          input.tokenHash,
          input.actorUserId,
          input.expiresAt,
        ],
      );
      const invitation = inserted.rows[0];
      if (!invitation) throw new Error("Invitation insert returned no row");
      if (input.auditRequestId) {
        await insertAuditEvent(client, {
          actorUserId: input.actorUserId,
          drawingId: input.drawingId,
          eventType: "sharing.invitation_created",
          requestId: input.auditRequestId,
          metadata: { invitationId: invitation.id, role: input.role },
        });
      }
      return { status: "invitation", invitation: mapInvitation(invitation) };
    });
  }

  public async updateInvitationDelivery(
    invitationId: string,
    status: "sent" | "manual" | "failed",
  ) {
    await this.pool.query(
      `UPDATE drawing_invitations SET delivery_status = $2 WHERE id = $1`,
      [invitationId, status],
    );
  }

  public async updateMember(input: {
    drawingId: string;
    actorUserId: string;
    memberUserId: string;
    role: "editor" | "viewer";
    auditRequestId?: string;
  }) {
    return transaction(this.pool, async (client) => {
      const access = await lockDrawingAccess(
        client,
        input.drawingId,
        input.actorUserId,
        "update",
      );
      if (access === "not-found") return "not-found";
      if (access === "member") {
        await auditRejected(client, input, "update-member");
        return "forbidden";
      }
      const result = await client.query(
        `UPDATE drawing_members SET role = $3
         WHERE drawing_id = $1 AND user_id = $2`,
        [input.drawingId, input.memberUserId, input.role],
      );
      if (result.rowCount !== 1) return "not-found";
      if (input.auditRequestId) {
        await insertAuditEvent(client, {
          actorUserId: input.actorUserId,
          drawingId: input.drawingId,
          eventType: "sharing.member_role_changed",
          requestId: input.auditRequestId,
          metadata: { targetUserId: input.memberUserId, role: input.role },
        });
      }
      return "updated";
    });
  }

  public async removeMember(input: {
    drawingId: string;
    actorUserId: string;
    memberUserId: string;
    auditRequestId?: string;
  }) {
    return transaction(this.pool, async (client) => {
      const access = await lockDrawingAccess(
        client,
        input.drawingId,
        input.actorUserId,
        "update",
      );
      if (access === "not-found") return "not-found";
      if (access === "member") {
        await auditRejected(client, input, "remove-member");
        return "forbidden";
      }
      const result = await client.query(
        `DELETE FROM drawing_members WHERE drawing_id = $1 AND user_id = $2`,
        [input.drawingId, input.memberUserId],
      );
      if (result.rowCount !== 1) return "not-found";
      if (input.auditRequestId) {
        await insertAuditEvent(client, {
          actorUserId: input.actorUserId,
          drawingId: input.drawingId,
          eventType: "sharing.member_removed",
          requestId: input.auditRequestId,
          metadata: { targetUserId: input.memberUserId },
        });
      }
      return "removed";
    });
  }

  public async revokeInvitation(input: {
    drawingId: string;
    actorUserId: string;
    invitationId: string;
    auditRequestId?: string;
  }) {
    return transaction(this.pool, async (client) => {
      const access = await lockDrawingAccess(
        client,
        input.drawingId,
        input.actorUserId,
        "update",
      );
      if (access === "not-found") return "not-found";
      if (access === "member") {
        await auditRejected(client, input, "revoke-invitation");
        return "forbidden";
      }
      const result = await client.query(
        `UPDATE drawing_invitations SET revoked_at = now()
         WHERE id = $2 AND drawing_id = $1
           AND accepted_at IS NULL AND revoked_at IS NULL`,
        [input.drawingId, input.invitationId],
      );
      if (result.rowCount !== 1) return "not-found";
      if (input.auditRequestId) {
        await insertAuditEvent(client, {
          actorUserId: input.actorUserId,
          drawingId: input.drawingId,
          eventType: "sharing.invitation_revoked",
          requestId: input.auditRequestId,
          metadata: { invitationId: input.invitationId },
        });
      }
      return "revoked";
    });
  }

  public async inspect(tokenHash: Buffer) {
    const result = await this.pool.query<InvitationRow>(
      `${INVITATION_SELECT} WHERE i.token_hash = $1 LIMIT 1`,
      [tokenHash],
    );
    return result.rows[0] ? mapInvitation(result.rows[0]) : null;
  }

  public async accept(input: {
    tokenHash: Buffer;
    userId: string;
    email: string;
    emailVerified: boolean;
    requireVerifiedEmail: boolean;
    auditRequestId?: string;
  }) {
    const located = await this.pool.query<{ drawing_id: string }>(
      `SELECT drawing_id FROM drawing_invitations WHERE token_hash = $1`,
      [input.tokenHash],
    );
    const drawingId = located.rows[0]?.drawing_id;
    if (!drawingId) return { status: "not-found" as const };
    return transaction(this.pool, async (client) => {
      const drawing = await lockActiveDrawing(client, drawingId, "update");
      if (!drawing) return { status: "not-found" as const };
      const result = await client.query<InvitationRow>(
        `${INVITATION_SELECT} WHERE i.token_hash = $1 FOR UPDATE OF i`,
        [input.tokenHash],
      );
      const invitation = result.rows[0];
      if (!invitation) return { status: "not-found" as const };
      if (invitation.accepted_at) return { status: "used" as const };
      if (invitation.revoked_at) return { status: "revoked" as const };
      if (invitation.expires_at.getTime() <= Date.now())
        return { status: "expired" as const };
      if (
        invitation.invitee_email.toLowerCase() !== input.email.toLowerCase()
      ) {
        if (input.auditRequestId) {
          await insertAuditEvent(client, {
            actorUserId: input.userId,
            drawingId: invitation.drawing_id,
            eventType: "sharing.invitation_accept_rejected",
            requestId: input.auditRequestId,
            metadata: { reason: "email-mismatch" },
          });
        }
        return { status: "email-mismatch" as const };
      }
      if (input.requireVerifiedEmail && !input.emailVerified) {
        if (input.auditRequestId) {
          await insertAuditEvent(client, {
            actorUserId: input.userId,
            drawingId: invitation.drawing_id,
            eventType: "sharing.invitation_accept_rejected",
            requestId: input.auditRequestId,
            metadata: { reason: "verification-required" },
          });
        }
        return { status: "verification-required" as const };
      }
      if (drawing.owner_user_id !== input.userId) {
        await client.query(
          `INSERT INTO drawing_members (drawing_id, user_id, role, created_by_user_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (drawing_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
          [
            invitation.drawing_id,
            input.userId,
            invitation.role,
            invitation.invited_by_user_id,
          ],
        );
      }
      await client.query(
        `UPDATE drawing_invitations SET accepted_at = now(), accepted_by_user_id = $2
         WHERE id = $1`,
        [invitation.id, input.userId],
      );
      const member = await client.query<MemberRow>(
        `SELECT u.id AS user_id, u.email, u.name, u.image,
                CASE WHEN d.owner_user_id = u.id THEN 'owner' ELSE m.role END AS role,
                COALESCE(m.created_at, d.created_at) AS created_at
         FROM "user" u JOIN drawings d ON d.id = $1
         LEFT JOIN drawing_members m ON m.drawing_id = d.id AND m.user_id = u.id
         WHERE u.id = $2`,
        [invitation.drawing_id, input.userId],
      );
      const accepted = member.rows[0];
      if (!accepted)
        throw new Error("Accepted invitation member could not be loaded");
      if (input.auditRequestId) {
        await insertAuditEvent(client, {
          actorUserId: input.userId,
          drawingId: invitation.drawing_id,
          eventType: "sharing.invitation_accepted",
          requestId: input.auditRequestId,
          metadata: { invitationId: invitation.id, role: invitation.role },
        });
      }
      return { status: "accepted" as const, member: mapMember(accepted) };
    });
  }
}

async function auditRejected(
  client: PoolClient,
  input: {
    actorUserId: string;
    drawingId: string;
    auditRequestId?: string;
  },
  action: string,
) {
  if (!input.auditRequestId) return;
  await insertAuditEvent(client, {
    actorUserId: input.actorUserId,
    drawingId: input.drawingId,
    eventType: "sharing.write_rejected",
    requestId: input.auditRequestId,
    metadata: { action, reason: "owner-required" },
  });
}

const INVITATION_SELECT = `
  SELECT i.id, i.drawing_id, d.title AS drawing_title,
         i.invitee_email, i.role, i.expires_at, i.accepted_at,
         i.revoked_at, i.created_at, i.delivery_status,
         u.name AS inviter_name, i.invited_by_user_id
  FROM drawing_invitations i
  JOIN drawings d ON d.id = i.drawing_id
  JOIN "user" u ON u.id = i.invited_by_user_id`;

async function lockActiveDrawing(
  client: PoolClient,
  drawingId: string,
  mode: "share" | "update",
) {
  const lockClause = mode === "update" ? "FOR UPDATE" : "FOR SHARE";
  const result = await client.query<{ owner_user_id: string }>(
    `SELECT owner_user_id FROM drawings
     WHERE id = $1 AND deleted_at IS NULL ${lockClause}`,
    [drawingId],
  );
  return result.rows[0] ?? null;
}

async function lockDrawingAccess(
  client: PoolClient,
  drawingId: string,
  actorUserId: string,
  mode: "share" | "update",
) {
  const drawing = await lockActiveDrawing(client, drawingId, mode);
  if (!drawing) return "not-found" as const;
  if (drawing.owner_user_id === actorUserId) return "owner" as const;
  const member = await client.query(
    `SELECT 1 FROM drawing_members WHERE drawing_id = $1 AND user_id = $2`,
    [drawingId, actorUserId],
  );
  return member.rows[0] ? ("member" as const) : ("not-found" as const);
}

function mapMember(row: MemberRow): MemberRecord {
  return {
    userId: row.user_id,
    email: row.email,
    name: row.name,
    image: row.image,
    role: row.role,
    createdAt: row.created_at,
  };
}

function mapInvitation(row: InvitationRow): InvitationRecord {
  return {
    id: row.id,
    drawingId: row.drawing_id,
    drawingTitle: row.drawing_title,
    email: row.invitee_email,
    role: row.role,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    deliveryStatus: row.delivery_status,
    inviterName: row.inviter_name,
  };
}

async function transaction<T>(
  pool: Pool,
  action: (client: PoolClient) => Promise<T>,
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await action(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
