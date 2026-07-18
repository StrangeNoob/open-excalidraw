import type { AdminOverview, AdminUserList } from "@open-excalidraw/contracts";

/**
 * The drawing purge flow, reused verbatim so an admin delete removes storage
 * blobs, rows, and audit records exactly like an owner's "delete forever".
 * Structurally matches `PostgresDrawingRepository.purge`.
 */
export type PurgeDrawing = (input: {
  drawingId: string;
  ownerUserId: string;
  auditRequestId?: string;
}) => Promise<unknown>;

export interface AdminRepository {
  overview(): Promise<AdminOverview>;
  listUsers(input: { search?: string; limit: number }): Promise<AdminUserList>;
  userExists(userId: string): Promise<boolean>;
  disableUser(input: {
    actorUserId: string;
    targetUserId: string;
    requestId: string;
  }): Promise<void>;
  enableUser(input: {
    actorUserId: string;
    targetUserId: string;
    requestId: string;
  }): Promise<void>;
  /** Soft-delete then purge every drawing the target owns (blobs included). */
  purgeOwnedDrawings(input: {
    ownerUserId: string;
    requestId: string;
  }): Promise<void>;
  deleteUser(input: {
    actorUserId: string;
    targetUserId: string;
    requestId: string;
  }): Promise<void>;
}
