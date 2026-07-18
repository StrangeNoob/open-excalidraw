import {
  uuidSchema,
  type AdminOverview,
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
  public constructor(private readonly repository: AdminRepository) {}

  public getOverview(): Promise<AdminOverview> {
    return this.repository.overview();
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

  public async deleteUser(input: TargetAction): Promise<void> {
    await this.assertTargetable(input);
    // Disable first: revokes the target's sessions so it cannot create new
    // drawings between the purge and the RESTRICT-guarded user-row delete.
    await this.repository.disableUser(input);
    // Purge before the row delete: the drawings.owner_user_id FK stays
    // RESTRICT, so the user row cannot be removed while it still owns drawings.
    await this.repository.purgeOwnedDrawings({
      ownerUserId: input.targetUserId,
      requestId: input.requestId,
    });
    await this.repository.deleteUser(input);
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
  const value = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(value) || value < 1) return DEFAULT_LIMIT;
  return Math.min(value, MAX_LIMIT);
}
