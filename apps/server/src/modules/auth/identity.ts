import { fromNodeHeaders } from "better-auth/node";
import type { IncomingHttpHeaders } from "node:http";

import type { OpenExcalidrawAuth } from "./config.js";

export interface RequestIdentity {
  userId: string;
  email: string;
  name: string;
  image: string | null;
  emailVerified: boolean;
  createdAt: Date;
  sessionId: string;
  sessionExpiresAt: Date;
}

export interface IdentityService {
  resolve(
    headers: IncomingHttpHeaders | Headers,
  ): Promise<RequestIdentity | null>;
}

export function createIdentityService(
  auth: OpenExcalidrawAuth,
): IdentityService {
  return {
    async resolve(headers) {
      const webHeaders =
        headers instanceof Headers ? headers : fromNodeHeaders(headers);
      const result = await auth.api.getSession({ headers: webHeaders });
      if (!result) {
        return null;
      }

      return {
        userId: result.user.id,
        email: result.user.email,
        name: result.user.name,
        image: result.user.image ?? null,
        emailVerified: result.user.emailVerified,
        createdAt: result.user.createdAt,
        sessionId: result.session.id,
        sessionExpiresAt: result.session.expiresAt,
      };
    },
  };
}
