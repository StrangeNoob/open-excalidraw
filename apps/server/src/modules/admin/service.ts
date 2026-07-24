import {
  adminSettingsUpdateSchema,
  adminUserQuotaUpdateSchema,
  uuidSchema,
  type AdminOverview,
  type AdminSettings,
  type AdminUser,
  type AdminUserList,
} from "@open-excalidraw/contracts";

import { AdminDomainError } from "./errors.js";
import type { AdminRepository } from "./types.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

interface TargetAction {
  actorUserId: string;
  targetUserId: string;
  requestId: string;
}

export class AdminService {
  public constructor(
    private readonly repository: AdminRepository,
    // The STORAGE_QUOTA_PER_USER_BYTES env default, surfaced read-only in
    // settings responses; null = unlimited.
    private readonly envFallbackBytes: number | null = null,
  ) {}

  public getOverview(): Promise<AdminOverview> {
    return this.repository.overview();
  }

  public async getSettings(): Promise<AdminSettings> {
    const { storageQuotaPerUserBytes } = await this.repository.getSettings();
    return {
      storageQuotaPerUserBytes,
      envFallbackBytes: this.envFallbackBytes,
    };
  }

  public async updateSettings(input: {
    actorUserId: string;
    requestId: string;
    body: unknown;
  }): Promise<AdminSettings> {
    const { storageQuotaPerUserBytes } = adminSettingsUpdateSchema.parse(
      input.body,
    );
    const updated = await this.repository.updateSettings({
      actorUserId: input.actorUserId,
      requestId: input.requestId,
      storageQuotaPerUserBytes,
    });
    return {
      storageQuotaPerUserBytes: updated.storageQuotaPerUserBytes,
      envFallbackBytes: this.envFallbackBytes,
    };
  }

  public async setUserQuota(input: {
    actorUserId: string;
    targetUserId: string;
    requestId: string;
    body: unknown;
  }): Promise<AdminUser> {
    const { storageQuotaBytes } = adminUserQuotaUpdateSchema.parse(input.body);
    // Reject a malformed path id before it reaches a uuid-typed WHERE clause.
    uuidSchema.parse(input.targetUserId);
    return this.repository.setUserQuota({
      actorUserId: input.actorUserId,
      targetUserId: input.targetUserId,
      requestId: input.requestId,
      storageQuotaBytes,
    });
  }

  public listUsers(query: {
    search?: string;
    limit?: string;
  }): Promise<AdminUserList> {
    const search = query.search?.trim();
    return this.repository.listUsers({
      limit: clampLimit(query.limit),
      ...(search ? { search } : {}),
    });
  }

  public async disableUser(input: TargetAction): Promise<void> {
    await this.assertTargetable(input);
    await this.repository.disableUser(input);
  }

  public async enableUser(input: TargetAction): Promise<void> {
    await this.assertExists(input.targetUserId);
    await this.repository.enableUser(input);
  }

  public async resetTwoFactor(input: TargetAction): Promise<void> {
    // A recovery escape hatch, not a lockout, so it needs no self-target guard.
    await this.assertExists(input.targetUserId);
    await this.repository.resetTwoFactor(input);
  }

  public async deleteUser(input: TargetAction): Promise<void> {
    await this.assertTargetable(input);
    // Disable first: revokes the target's sessions so it cannot create new
    // drawings between the purge and the RESTRICT-guarded user-row delete.
    await this.repository.disableUser(input);
    const purge = () =>
      this.repository.purgeOwnedDrawings({
        ownerUserId: input.targetUserId,
        requestId: input.requestId,
      });
    // Purge before the row delete: the drawings.owner_user_id FK stays
    // RESTRICT, so the user row cannot be removed while it still owns drawings.
    await purge();
    try {
      await this.repository.deleteUser(input);
    } catch (error) {
      // An in-flight request whose identity resolved before session revocation
      // can create a drawing after the purge snapshot, tripping the RESTRICT
      // FK; re-purge and retry the delete once.
      if (!isForeignKeyViolation(error)) throw error;
      await purge();
      await this.repository.deleteUser(input);
    }
  }

  private async assertTargetable(input: TargetAction): Promise<void> {
    if (input.actorUserId === input.targetUserId) {
      throw new AdminDomainError(
        "CANNOT_TARGET_SELF",
        409,
        "You cannot disable or delete your own account",
      );
    }
    await this.assertExists(input.targetUserId);
  }

  private async assertExists(targetUserId: string): Promise<void> {
    uuidSchema.parse(targetUserId);
    if (!(await this.repository.userExists(targetUserId))) {
      throw new AdminDomainError("USER_NOT_FOUND", 404, "User not found");
    }
  }
}

function clampLimit(raw: string | undefined): number {
  const trimmed = raw?.trim() ?? "";
  // Only a whole number counts; parseInt would accept "50abc" or "1.9".
  if (!/^\d+$/.test(trimmed)) return DEFAULT_LIMIT;
  const value = Number.parseInt(trimmed, 10);
  if (value < 1) return DEFAULT_LIMIT;
  return Math.min(value, MAX_LIMIT);
}

// Postgres foreign_key_violation; the drawings.owner_user_id RESTRICT FK.
function isForeignKeyViolation(error: unknown): boolean {
  return (error as { code?: string })?.code === "23503";
}
