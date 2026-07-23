import type {
  AdminOverview,
  AdminUser,
  AdminUserList,
} from "@open-excalidraw/contracts";

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

/** The instance-wide per-user quota stored in app_settings; null = unlimited. */
export interface AdminStorageSettings {
  storageQuotaPerUserBytes: number | null;
}

export interface AdminRepository {
  overview(): Promise<AdminOverview>;
  listUsers(input: { search?: string; limit: number }): Promise<AdminUserList>;
  userExists(userId: string): Promise<boolean>;
  /** The single-row app_settings quota default. */
  getSettings(): Promise<AdminStorageSettings>;
  /** Writes the app_settings quota default and an audit event; returns the new value. */
  updateSettings(input: {
    actorUserId: string;
    requestId: string;
    storageQuotaPerUserBytes: number | null;
  }): Promise<AdminStorageSettings>;
  /**
   * Sets or clears a user's per-user quota override, writes an audit event, and
   * returns the updated admin user row. Throws USER_NOT_FOUND if unknown.
   */
  setUserQuota(input: {
    actorUserId: string;
    targetUserId: string;
    requestId: string;
    storageQuotaBytes: number | null;
  }): Promise<AdminUser>;
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
  /** Clear the target's TOTP enrollment: drop two_factor rows and the flag. */
  resetTwoFactor(input: {
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
