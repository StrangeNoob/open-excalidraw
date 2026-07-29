import type { AuthCapabilities } from "@open-excalidraw/contracts";
import {
  schema as databaseSchema,
  type Database,
} from "@open-excalidraw/database";
import {
  renderPasswordResetEmail,
  renderVerificationEmail,
  type Mailer,
} from "@open-excalidraw/mail";
import {
  betterAuth,
  type BetterAuthOptions,
  type DBAdapterInstance,
} from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { genericOAuth, mcp, twoFactor } from "better-auth/plugins";

import {
  MCP_RESOURCE_PATH,
  OAUTH_CONSENT_PATH,
  OAUTH_LOGIN_PATH,
  OAUTH_SCOPES,
} from "../oauth/metadata.js";
import {
  DisabledManualResetLinkSink,
  type ManualResetLinkSink,
} from "./manual-reset.js";
import { withHashedTokens } from "./token-adapter.js";

const DEFAULT_SESSION_SECONDS = 60 * 60 * 24 * 7;
const DEFAULT_RESET_SECONDS = 60 * 60;
const OIDC_DISCOVERY_SUFFIX = "/.well-known/openid-configuration";
// Short by design: a connector's access token is replayable until it expires,
// and the client holds a refresh token to get another one.
const OAUTH_ACCESS_TOKEN_SECONDS = 15 * 60;
// Personal access tokens cap out at 365 days and may be endless; a connector
// grant deliberately cannot, so a forgotten connector dies on its own.
const OAUTH_REFRESH_TOKEN_SECONDS = 60 * 60 * 24 * 90;

type AuthPlugin = NonNullable<BetterAuthOptions["plugins"]>[number];

export interface OAuthProviderCredentials {
  clientId: string;
  clientSecret: string;
}

export interface OidcProviderConfig {
  /** Issuer URL or full discovery document URL. */
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  /** Button label shown to users; defaults to "SSO". */
  providerName?: string;
}

export interface CreateAuthInput {
  database: Database;
  /** Test/alternate adapter seam; session hashing is still applied. */
  databaseAdapter?: DBAdapterInstance;
  mailer: Mailer;
  baseUrl: string;
  secret: string;
  trustedOrigins?: string[];
  secureCookies?: boolean;
  smtpEnabled: boolean;
  google?: OAuthProviderCredentials;
  github?: OAuthProviderCredentials;
  oidc?: OidcProviderConfig;
  /** Block new-account creation across every provider; existing users still sign in. */
  disableSignups?: boolean;
  sessionExpiresInSeconds?: number;
  manualResetLinks?: ManualResetLinkSink;
  productName?: string;
  heroImageUrl?: string;
}

export type OpenExcalidrawAuth = ReturnType<typeof createOpenExcalidrawAuth>;

export function createOpenExcalidrawAuth(input: CreateAuthInput) {
  return betterAuth(buildBetterAuthOptions(input));
}

export function buildBetterAuthOptions(
  input: CreateAuthInput,
): BetterAuthOptions {
  validateInput(input);

  const sessionExpiresIn =
    input.sessionExpiresInSeconds ?? DEFAULT_SESSION_SECONDS;
  const manualResetLinks =
    input.manualResetLinks ?? new DisabledManualResetLinkSink();
  const disableSignUp = input.disableSignups ?? false;
  const socialProviders: NonNullable<BetterAuthOptions["socialProviders"]> = {};

  if (hasCompleteCredentials(input.google)) {
    socialProviders.google = { ...input.google, disableSignUp };
  }
  if (hasCompleteCredentials(input.github)) {
    socialProviders.github = { ...input.github, disableSignUp };
  }

  const adapter = withHashedTokens(
    input.databaseAdapter ??
      drizzleAdapter(input.database, {
        provider: "pg",
        schema: databaseSchema,
        transaction: true,
      }),
  );

  // twoFactor is always on (opt-in per user); genericOAuth stays conditional.
  // No options: appName is the TOTP issuer, skipVerificationOnEnable defaults
  // false so enrollment only flips twoFactorEnabled after a verify-totp, and
  // omitting otpOptions leaves sendOTP unset so /two-factor/send-otp is dead.
  const plugins: NonNullable<BetterAuthOptions["plugins"]> = [
    twoFactor(),
    // The authorization server behind claude.ai connectors. Its endpoints live
    // under /api/auth/mcp/*; the oauth router publishes discovery at the
    // well-known paths clients probe and guards registration and authorize.
    mcp({
      loginPage: OAUTH_LOGIN_PATH,
      resource: new URL(MCP_RESOURCE_PATH, input.baseUrl).toString(),
      oidcConfig: {
        // Required by the option type even though the plugin overrides it with
        // the value above; keep them the same so neither can go stale.
        loginPage: OAUTH_LOGIN_PATH,
        consentPage: OAUTH_CONSENT_PATH,
        // OAuth 2.1: proof of possession of the code, S256 only.
        requirePKCE: true,
        allowPlainCodeChallengeMethod: false,
        accessTokenExpiresIn: OAUTH_ACCESS_TOKEN_SECONDS,
        refreshTokenExpiresIn: OAUTH_REFRESH_TOKEN_SECONDS,
        scopes: [...OAUTH_SCOPES],
        // What a connector gets when it names no scope of its own. Never
        // "full": an OAuth grant must not reach the admin routes.
        defaultScope: "openid offline_access write",
      },
    }),
    rotateOAuthRefreshTokens(),
  ];
  if (hasCompleteOidc(input.oidc)) {
    plugins.push(
      genericOAuth({
        config: [
          {
            providerId: "oidc",
            discoveryUrl: oidcDiscoveryUrl(input.oidc.issuerUrl),
            clientId: input.oidc.clientId,
            clientSecret: input.oidc.clientSecret,
            scopes: ["openid", "profile", "email"],
            pkce: true,
            disableSignUp,
          },
        ],
      }),
    );
  }

  return {
    appName: input.productName ?? "Open Excalidraw",
    baseURL: input.baseUrl,
    basePath: "/api/auth",
    secret: input.secret,
    trustedOrigins: input.trustedOrigins ?? [new URL(input.baseUrl).origin],
    database: adapter,
    advanced: {
      database: { generateId: "uuid" },
      ipAddress: {
        ipAddressHeaders: ["x-forwarded-for", "x-real-ip"],
      },
      useSecureCookies: input.secureCookies ?? isHttps(input.baseUrl),
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: "lax",
        secure: input.secureCookies ?? isHttps(input.baseUrl),
        path: "/",
      },
    },
    verification: {
      storeIdentifier: "hashed",
    },
    user: {
      additionalFields: {
        // Read-only projection of the disabled_at column so the session hook
        // below can see it through the adapter; admins set it via SQL. No
        // fieldName override: the drizzle adapter resolves the column from the
        // schema by this camelCase name (like the built-in emailVerified).
        disabledAt: {
          type: "date",
          required: false,
          input: false,
        },
      },
    },
    databaseHooks: {
      session: {
        create: {
          // Block session creation for disabled users: combined with deleting
          // their sessions on disable, this is a full lockout at zero
          // per-request cost. ponytail: reads through the auth context adapter
          // (not the injected drizzle handle) so the same path works for the
          // in-memory test adapter and production drizzle alike.
          before: async (session, context) => {
            const adapter = context?.context.adapter;
            // Fail closed: without the adapter the disabled check cannot run,
            // so refuse the session rather than skip the lockout guard.
            if (!adapter) {
              throw new APIError("INTERNAL_SERVER_ERROR", {
                code: "SESSION_GUARD_UNAVAILABLE",
                message: "Session guard unavailable",
              });
            }
            const account = await adapter.findOne<{ disabledAt: Date | null }>({
              model: "user",
              where: [{ field: "id", value: session.userId }],
            });
            if (account?.disabledAt) {
              throw new APIError("FORBIDDEN", {
                code: "ACCOUNT_DISABLED",
                message: "This account has been disabled",
              });
            }
          },
        },
      },
    },
    session: {
      expiresIn: sessionExpiresIn,
      updateAge: Math.min(60 * 60 * 24, Math.floor(sessionExpiresIn / 2)),
      cookieCache: { enabled: false },
    },
    emailAndPassword: {
      enabled: true,
      disableSignUp,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      // Unverified users may sign in and use the app; verification is nudged
      // in the dashboard UI and still gates provider linking and invite
      // acceptance.
      requireEmailVerification: false,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: DEFAULT_RESET_SECONDS,
      sendResetPassword: async ({ user, url }) => {
        // Delivery is deliberately detached from the public response so an
        // attacker cannot distinguish registered emails by SMTP latency.
        queueMicrotask(() => {
          void deliverPasswordReset({
            mailer: input.mailer,
            manualResetLinks,
            productName: input.productName,
            heroImageUrl: input.heroImageUrl,
            user,
            url,
          });
        });
        await Promise.resolve();
      },
    },
    emailVerification: {
      sendOnSignUp: input.smtpEnabled,
      sendOnSignIn: input.smtpEnabled,
      autoSignInAfterVerification: true,
      expiresIn: 60 * 60,
      sendVerificationEmail: async ({ user, url }) => {
        if (!input.smtpEnabled) {
          return;
        }
        await input.mailer.send(
          renderVerificationEmail({
            to: user.email,
            verificationUrl: url,
            productName: input.productName,
            heroImageUrl: input.heroImageUrl,
          }),
        );
      },
    },
    account: {
      encryptOAuthTokens: true,
      accountLinking: {
        enabled: true,
        requireLocalEmailVerified: true,
        allowDifferentEmails: false,
      },
    },
    socialProviders,
    plugins,
    rateLimit: {
      enabled: true,
      storage: "memory",
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/email": { window: 60, max: 10 },
        "/sign-up/email": { window: 60, max: 5 },
        "/request-password-reset": { window: 60, max: 5 },
        "/send-verification-email": { window: 60, max: 5 },
      },
    },
  };
}

/**
 * The MCP plugin mints a new refresh token on every refresh but leaves the
 * consumed one valid until its own expiry, which is issuing rather than
 * rotating. Deleting the row the presented token came from makes it rotation: a
 * stolen refresh token stops working the moment the real client refreshes.
 */
function rotateOAuthRefreshTokens(): AuthPlugin {
  return {
    id: "oauth-refresh-rotation",
    hooks: {
      after: [
        {
          matcher: (context) => context.path === "/mcp/token",
          handler: createAuthMiddleware(async (ctx) => {
            const body: unknown =
              ctx.body instanceof FormData
                ? Object.fromEntries(ctx.body.entries())
                : ctx.body;
            if (typeof body !== "object" || body === null) {
              return;
            }
            const { grant_type: grantType, refresh_token: refreshToken } =
              body as Record<string, unknown>;
            // Only a successful exchange consumed the token, and success is
            // checked positively: a rejected or failed request must leave the
            // row alone so a probe cannot revoke someone else's grant.
            const issued =
              typeof ctx.context.returned === "object" &&
              ctx.context.returned !== null &&
              "access_token" in ctx.context.returned;
            if (
              !issued ||
              grantType !== "refresh_token" ||
              typeof refreshToken !== "string"
            ) {
              return;
            }
            await ctx.context.adapter.delete({
              model: "oauthAccessToken",
              where: [{ field: "refreshToken", value: refreshToken }],
            });
          }),
        },
      ],
    },
  };
}

async function deliverPasswordReset(input: {
  mailer: Mailer;
  manualResetLinks: ManualResetLinkSink;
  productName?: string;
  heroImageUrl?: string;
  user: { id: string; email: string };
  url: string;
}): Promise<void> {
  let status: "disabled" | "failed" | "sent";
  try {
    status = (
      await input.mailer.send(
        renderPasswordResetEmail({
          to: input.user.email,
          resetUrl: input.url,
          productName: input.productName,
          heroImageUrl: input.heroImageUrl,
        }),
      )
    ).status;
  } catch {
    status = "failed";
  }

  if (status !== "sent") {
    await input.manualResetLinks.publish({
      userId: input.user.id,
      email: input.user.email,
      url: input.url,
      expiresAt: new Date(Date.now() + DEFAULT_RESET_SECONDS * 1000),
      reason: status === "disabled" ? "mail-disabled" : "mail-failed",
    });
  }
}

export function authCapabilities(input: {
  smtpEnabled: boolean;
  google?: OAuthProviderCredentials;
  github?: OAuthProviderCredentials;
  oidc?: OidcProviderConfig;
  disableSignups?: boolean;
}): AuthCapabilities {
  return {
    emailPassword: true,
    google: hasCompleteCredentials(input.google),
    github: hasCompleteCredentials(input.github),
    oidc: hasCompleteOidc(input.oidc),
    oidcProviderName: input.oidc?.providerName?.trim() || "SSO",
    signupsDisabled: Boolean(input.disableSignups),
    smtp: input.smtpEnabled,
  };
}

function hasCompleteCredentials(
  value: OAuthProviderCredentials | undefined,
): value is OAuthProviderCredentials {
  return Boolean(value?.clientId.trim() && value.clientSecret.trim());
}

function hasCompleteOidc(
  value: OidcProviderConfig | undefined,
): value is OidcProviderConfig {
  return Boolean(
    value?.issuerUrl.trim() &&
    value.clientId.trim() &&
    value.clientSecret.trim(),
  );
}

function oidcDiscoveryUrl(issuerUrl: string): string {
  const url = new URL(issuerUrl.trim());
  // Plain HTTP would expose authorization codes and tokens; loopback hosts
  // are exempt so a local identity provider works in development.
  if (url.protocol !== "https:" && !isLoopbackHost(url.hostname)) {
    throw new TypeError("OIDC_ISSUER_URL must use HTTPS");
  }
  // Decide from the parsed pathname so query strings and trailing slashes
  // on an already-complete discovery URL do not get the suffix re-appended.
  const pathname = url.pathname.replace(/\/+$/, "");
  if (pathname.endsWith(OIDC_DISCOVERY_SUFFIX)) {
    return url.toString();
  }
  url.pathname = `${pathname}${OIDC_DISCOVERY_SUFFIX}`;
  return url.toString();
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
  );
}

function isHttps(value: string): boolean {
  return new URL(value).protocol === "https:";
}

function validateInput(input: CreateAuthInput): void {
  if (input.secret.length < 32) {
    throw new TypeError(
      "Better Auth secret must contain at least 32 characters",
    );
  }
  if (input.sessionExpiresInSeconds !== undefined) {
    if (
      !Number.isSafeInteger(input.sessionExpiresInSeconds) ||
      input.sessionExpiresInSeconds <= 0
    ) {
      throw new TypeError("Session expiration must be a positive integer");
    }
  }
  void new URL(input.baseUrl);
}
