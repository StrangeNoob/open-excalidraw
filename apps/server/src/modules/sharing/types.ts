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
  }): Promise<"updated" | "not-found" | "forbidden">;
  removeMember(input: {
    drawingId: string;
    actorUserId: string;
    memberUserId: string;
  }): Promise<"removed" | "not-found" | "forbidden">;
  revokeInvitation(input: {
    drawingId: string;
    actorUserId: string;
    invitationId: string;
  }): Promise<"revoked" | "not-found" | "forbidden">;
  inspect(tokenHash: Buffer): Promise<InvitationRecord | null>;
  accept(input: {
    tokenHash: Buffer;
    userId: string;
    email: string;
    emailVerified: boolean;
    requireVerifiedEmail: boolean;
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
