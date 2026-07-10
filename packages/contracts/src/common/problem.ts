import { z } from "zod";

import { CONTRACT_LIMITS } from "../limits.js";

export const problemDetailsSchema = z
  .object({
    code: z.string().min(1).max(128),
    status: z.number().int().min(400).max(599),
    title: z.string().min(1).max(256),
    detail: z.string().max(CONTRACT_LIMITS.problemDetailCharacters).optional(),
    requestId: z.string().min(1).max(128),
    errors: z.record(z.string(), z.array(z.string())).optional(),
  })
  .strict();

export type ProblemDetails = z.infer<typeof problemDetailsSchema>;
