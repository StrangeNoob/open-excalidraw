import type {
  DrawingMember,
  Invitation,
  MemberRole,
  Role,
} from "@open-excalidraw/contracts";

export interface MemberRecord {
  userId: string;
  email: string;
  name: string;
  image: string | null;
  role: Role;
  createdAt: Date;
}

export interface InvitationRecord {
  id: string;
  drawingId: string;
  drawingTitle: string;
  email: string;
  role: MemberRole;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  deliveryStatus: "sent" | "manual" | "failed";
  inviterName: string;
}

export type CreateShareResult =
  | { status: "membership"; member: MemberRecord }
  | { status: "invitation"; invitation: InvitationRecord }
  | { status: "not-found" }
  | { status: "forbidden" };

export interface ShareLinkRecord {
  linkId: string;
  token: string;
  createdAt: Date;
}

export interface SharedDrawingRecord {
  linkId: string;
  drawingId: string;
  title: string;
  scene: unknown;
  revision: string;
}

export interface SharingRepository {
  list(
    drawingId: string,
    actorUserId: string,
  ): Promise<
    | { status: "ok"; members: MemberRecord[]; invitations: InvitationRecord[] }
    | { status: "not-found" | "forbidden" }
  >;
  createShare(input: {
    drawingId: string;
    actorUserId: string;
    email: string;
    role: MemberRole;
    tokenHash: Buffer;
    expiresAt: Date;
    /**
     * When true, an existing account may only be granted membership directly
     * if it has verified the invited address; otherwise the emailed-token flow
     * is used so the real mailbox owner must accept. Required rather than
     * optional so a caller cannot silently opt out of the check.
     */
    requireVerifiedEmail: boolean;
    auditRequestId?: string;
  }): Promise<CreateShareResult>;
  updateInvitationDelivery(
    invitationId: string,
    status: "sent" | "manual" | "failed",
  ): Promise<void>;
  updateMember(input: {
    drawingId: string;
    actorUserId: string;
    memberUserId: string;
    role: MemberRole;
    auditRequestId?: string;
  }): Promise<"updated" | "not-found" | "forbidden">;
  removeMember(input: {
    drawingId: string;
    actorUserId: string;
    memberUserId: string;
    auditRequestId?: string;
  }): Promise<"removed" | "not-found" | "forbidden">;
  revokeInvitation(input: {
    drawingId: string;
    actorUserId: string;
    invitationId: string;
    auditRequestId?: string;
  }): Promise<"revoked" | "not-found" | "forbidden">;
  createShareLink(input: {
    drawingId: string;
    actorUserId: string;
    token: string;
    auditRequestId?: string;
  }): Promise<
    | {
        status: "created";
        link: ShareLinkRecord;
        replacedLinkId: string | null;
      }
    | { status: "not-found" }
    | { status: "forbidden" }
  >;
  getShareLink(
    drawingId: string,
    actorUserId: string,
  ): Promise<
    | { status: "ok"; link: ShareLinkRecord | null }
    | { status: "not-found" | "forbidden" }
  >;
  revokeShareLink(input: {
    drawingId: string;
    actorUserId: string;
    auditRequestId?: string;
  }): Promise<
    | { status: "revoked"; linkId: string }
    | { status: "no-link" }
    | { status: "not-found" }
    | { status: "forbidden" }
  >;
  resolveShareToken(token: string): Promise<SharedDrawingRecord | null>;
  inspect(tokenHash: Buffer): Promise<InvitationRecord | null>;
  accept(input: {
    tokenHash: Buffer;
    userId: string;
    email: string;
    emailVerified: boolean;
    requireVerifiedEmail: boolean;
    auditRequestId?: string;
  }): Promise<
    | { status: "accepted"; member: MemberRecord }
    | {
        status:
          | "not-found"
          | "expired"
          | "used"
          | "revoked"
          | "email-mismatch"
          | "verification-required";
      }
  >;
}

export function toMember(record: MemberRecord): DrawingMember {
  return {
    userId: record.userId,
    email: record.email,
    name: record.name,
    image: validUrlOrNull(record.image),
    role: record.role,
    createdAt: record.createdAt.toISOString(),
  };
}

export function toInvitation(record: InvitationRecord): Invitation {
  return {
    id: record.id,
    drawingId: record.drawingId,
    email: record.email,
    role: record.role,
    status: invitationStatus(record),
    expiresAt: record.expiresAt.toISOString(),
    createdAt: record.createdAt.toISOString(),
  };
}

function invitationStatus(record: InvitationRecord): Invitation["status"] {
  if (record.acceptedAt) return "accepted";
  if (record.revokedAt) return "revoked";
  if (record.expiresAt.getTime() <= Date.now()) return "expired";
  return "pending";
}

function validUrlOrNull(value: string | null) {
  if (!value) return null;
  try {
    return new URL(value).toString();
  } catch {
    return null;
  }
}
