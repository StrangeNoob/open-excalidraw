import type { Role } from "@open-excalidraw/contracts";

export const isMembershipRevoked = (code: string | undefined) =>
  code === "SOCKET_MEMBERSHIP_REVOKED";

export const effectiveWorkspaceRole = (
  workspaceRole: Role,
  collaborationRole: Role | null,
  collaborationErrorCode: string | undefined,
): Role | null =>
  isMembershipRevoked(collaborationErrorCode)
    ? null
    : (collaborationRole ?? workspaceRole);
