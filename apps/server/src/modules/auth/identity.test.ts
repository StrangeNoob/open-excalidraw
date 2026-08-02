import { PERSONAL_ACCESS_TOKEN_PREFIX } from "@open-excalidraw/contracts";

import type { OpenExcalidrawAuth } from "./config.js";
import {
  createBearerResolver,
  createIdentityService,
  type RequestIdentity,
} from "./identity.js";

const identityFor = (userId: string) =>
  ({ userId, authKind: "token", tokenScope: "write" }) as RequestIdentity;

const sessionAuth = (userId: string | null) =>
  ({
    api: {
      getSession: () =>
        Promise.resolve(
          userId
            ? {
                user: {
                  id: userId,
                  email: "user@example.test",
                  name: "Session User",
                  image: null,
                  emailVerified: true,
                  createdAt: new Date(),
                },
                session: { id: "s1", expiresAt: new Date() },
              }
            : null,
        ),
    },
  }) as unknown as OpenExcalidrawAuth;

describe("bearer resolution", () => {
  const personalAccessTokens = {
    resolve: (secret: string) =>
      Promise.resolve(
        secret === `${PERSONAL_ACCESS_TOKEN_PREFIX}ok`
          ? identityFor("pat-owner")
          : null,
      ),
  };
  const oauthAccessTokens = {
    resolve: (secret: string) =>
      Promise.resolve(
        secret === "connector" ? identityFor("connector-owner") : null,
      ),
  };
  const bearer = createBearerResolver({
    personalAccessTokens,
    oauthAccessTokens,
  });

  it("routes each credential to the resolver that owns it", async () => {
    await expect(
      bearer.resolve(`${PERSONAL_ACCESS_TOKEN_PREFIX}ok`),
    ).resolves.toMatchObject({ userId: "pat-owner" });
    await expect(bearer.resolve("connector")).resolves.toMatchObject({
      userId: "connector-owner",
    });
    // A prefixed value is never offered to the OAuth resolver, and vice versa.
    await expect(
      bearer.resolve(`${PERSONAL_ACCESS_TOKEN_PREFIX}unknown`),
    ).resolves.toBeNull();
    await expect(bearer.resolve("unknown")).resolves.toBeNull();
  });

  it("never falls back to the session cookie once a bearer is presented", async () => {
    const identity = createIdentityService(sessionAuth("cookie-owner"), bearer);

    await expect(
      identity.resolve({ authorization: "Bearer connector", cookie: "s=1" }),
    ).resolves.toMatchObject({ userId: "connector-owner", authKind: "token" });
    // A rejected bearer must not ride the session alongside it.
    await expect(
      identity.resolve({ authorization: "Bearer expired", cookie: "s=1" }),
    ).resolves.toBeNull();
    // A non-bearer Authorization header still resolves the session.
    await expect(
      identity.resolve({ authorization: "Basic abc", cookie: "s=1" }),
    ).resolves.toMatchObject({ userId: "cookie-owner", authKind: "session" });
  });
});
