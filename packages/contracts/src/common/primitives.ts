import { z } from "zod";

import { CONTRACT_LIMITS } from "../limits.js";

export const uuidSchema = z.string().uuid();
export const isoDateTimeSchema = z.string().datetime({ offset: true });
export const revisionSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)$/)
  .meta({
    description: "Monotonically increasing revision, serialized as a string.",
  });
export const roleSchema = z.enum(["owner", "editor", "viewer"]);
export const memberRoleSchema = z.enum(["editor", "viewer"]);
export const fileIdSchema = z
  .string()
  .min(1)
  .max(CONTRACT_LIMITS.fileIdCharacters)
  .regex(/^[A-Za-z0-9_-]+$/);

export type Revision = z.infer<typeof revisionSchema>;
export type Role = z.infer<typeof roleSchema>;
export type MemberRole = z.infer<typeof memberRoleSchema>;
