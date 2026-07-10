import type { Role } from "@open-excalidraw/contracts";

export type DrawingCapability =
  | "read"
  | "rename"
  | "write-content"
  | "upload-asset"
  | "share"
  | "delete"
  | "transfer-ownership"
  | "leave";

const capabilitiesByRole = {
  owner: [
    "read",
    "rename",
    "write-content",
    "upload-asset",
    "share",
    "delete",
    "transfer-ownership",
  ],
  editor: ["read", "rename", "write-content", "upload-asset", "leave"],
  viewer: ["read", "leave"],
} as const satisfies Record<Role, readonly DrawingCapability[]>;

export function can(role: Role, capability: DrawingCapability): boolean {
  return (capabilitiesByRole[role] as readonly DrawingCapability[]).includes(
    capability,
  );
}

export function capabilitiesForRole(
  role: Role,
): ReadonlySet<DrawingCapability> {
  return new Set(capabilitiesByRole[role]);
}
