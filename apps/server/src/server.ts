import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CONTRACT_LIMITS } from "@open-excalidraw/contracts";
import { createDatabase } from "@open-excalidraw/database";
import { DisabledMailer, SmtpMailer, type Mailer } from "@open-excalidraw/mail";
import type { ObjectStorage } from "@open-excalidraw/storage";
import { config as loadDotenv } from "dotenv";
import { Router } from "express";
import { Server as SocketIoServer } from "socket.io";

import { createApp } from "./app.js";
import { createDocsRouter } from "./http/docs.js";
import {
  createMetricsRouter,
  type LastMaintenanceRun,
} from "./http/metrics.js";
import { enforceTokenScope } from "./http/token-scope.js";
import {
  AdminService,
  createAdminRouter,
  parseAdminEmails,
  PostgresAdminRepository,
} from "./modules/admin/index.js";
import {
  createStorageFromEnvironment,
  requiredEnvironment,
} from "./storage-config.js";
import {
  AssetError,
  AssetService,
  createAssetRouter,
  DrizzleAssetRepository,
} from "./modules/assets/index.js";
import {
  authCapabilities,
  createAuthRouter,
  createBearerResolver,
  createIdentityService,
  createOpenExcalidrawAuth,
  OneTimeManualResetLinkStore,
  type OAuthProviderCredentials,
  type OidcProviderConfig,
} from "./modules/auth/index.js";
import {
  createExportRouter,
  createSceneRenderer,
  ExportService,
} from "./modules/export/index.js";
import {
  createDrawingRouter,
  DrawingService,
  PostgresDrawingRepository,
  storageDrawingBlobStore,
} from "./modules/drawings/index.js";
import { MutationService } from "./modules/collaboration/mutation-service.js";
import { PostgresMutationRepository } from "./modules/collaboration/persistence/index.js";
import { PresenceService } from "./modules/collaboration/presence-service.js";
import { PreviewService } from "./modules/collaboration/preview-service.js";
import { RoomRegistry } from "./modules/collaboration/room-registry.js";
import {
  shareUserId,
  StrictOriginPolicy,
} from "./modules/collaboration/security/index.js";
import { attachCollaborationGateway } from "./modules/collaboration/socket-gateway.js";
import {
  ChatService,
  createChatRouter,
  MentionEmailNotifier,
  PostgresChatRepository,
  PostgresMentionNotificationRepository,
} from "./modules/chat/index.js";
import {
  ContentService,
  createContentRouter,
  PostgresContentRepository,
} from "./modules/content/index.js";
import {
  createLibraryRouter,
  LibraryService,
  PostgresLibraryRepository,
} from "./modules/library/index.js";
import { createMcpRouter } from "./modules/mcp/index.js";
import {
  createOauthClientLookup,
  createOauthRouter,
  PostgresOauthTokenResolver,
} from "./modules/oauth/index.js";
import {
  createNotificationRouter,
  PostgresNotificationSettingsRepository,
} from "./modules/notifications/index.js";
import {
  createSharingRouter,
  PostgresSharingRepository,
  SharingService,
} from "./modules/sharing/index.js";
import {
  createTokenRouter,
  PostgresTokenRepository,
  TokenService,
} from "./modules/tokens/index.js";
import { MaintenanceJobs } from "./jobs/index.js";
import { insertAuditEvent } from "./modules/audit.js";

loadEnvironmentFile();

const databaseUrl = requiredEnvironment("DATABASE_URL");
const baseUrl = process.env.APP_BASE_URL ?? "http://localhost:3000";
// ponytail: reuses the web app's icon as the email hero; swap for a dedicated banner asset if one lands.
const emailHeroImageUrl = new URL("/icon-512.png", baseUrl).toString();
const allowedBrowserOrigins = browserAllowedOrigins(baseUrl);
const secret = requiredEnvironment("BETTER_AUTH_SECRET");
const smtpEnabled = Boolean(process.env.SMTP_HOST?.trim());
const disableSignups = process.env.DISABLE_SIGNUPS === "true";
const adminResetToken = process.env.ADMIN_RESET_TOKEN?.trim();
// Length is enforced by createAuthRouter for every deployment, not just this
// one; here we only require that the token exists at all when there is no SMTP
// fallback for delivering reset links.
if (!smtpEnabled && !adminResetToken) {
  throw new Error("ADMIN_RESET_TOKEN is required when SMTP is disabled");
}
const google = oauthCredentials("GOOGLE");
const github = oauthCredentials("GITHUB");
const oidc = oidcConfig();
const database = createDatabase(databaseUrl);
const mailer = createMailer();
const manualResetLinks = new OneTimeManualResetLinkStore();
const auth = createOpenExcalidrawAuth({
  database: database.db,
  mailer,
  baseUrl,
  secret,
  smtpEnabled,
  disableSignups,
  manualResetLinks,
  heroImageUrl: emailHeroImageUrl,
  trustedOrigins: allowedBrowserOrigins,
  sessionExpiresInSeconds: positiveEnvironmentInteger(
    "SESSION_TTL_SECONDS",
    60 * 60 * 24 * 30,
  ),
  ...(google ? { google } : {}),
  ...(github ? { github } : {}),
  ...(oidc ? { oidc } : {}),
});
const tokenService = new TokenService(
  new PostgresTokenRepository(database.pool),
  {
    onTouchError: (error) =>
      operationalLog("error", "tokens.last_used_update_failed", {
        errorType: safeErrorType(error),
      }),
  },
);
// One place decides which resolver owns a presented bearer secret, so the
// identity seam and the scope gate can never disagree about a credential.
const bearerTokens = createBearerResolver({
  personalAccessTokens: {
    resolve: (secret) => tokenService.resolveIdentity(secret),
  },
  oauthAccessTokens: new PostgresOauthTokenResolver(database.pool),
});
const identity = createIdentityService(auth, bearerTokens);
const roomRegistry = new RoomRegistry();
const contentService = new ContentService(
  new PostgresContentRepository(database.pool),
  undefined,
  {
    restored: (drawingId, revision) => {
      roomRegistry.requestResync(drawingId, revision, "revision-restored");
    },
    saved: (drawingId, revision) => {
      roomRegistry.requestResync(drawingId, revision, "external-save");
    },
  },
);
const sharingRepository = new PostgresSharingRepository(database.pool);
const sharingService = new SharingService({
  repository: sharingRepository,
  mailer,
  publicBaseUrl: baseUrl,
  heroImageUrl: emailHeroImageUrl,
  requireVerifiedEmailForAcceptance: smtpEnabled,
  membershipEvents: {
    roleChanged: (drawingId, userId, role) => {
      roomRegistry.changeRole(drawingId, userId, role);
    },
    revoked: (drawingId, userId) => {
      roomRegistry.revoke(drawingId, userId);
    },
  },
  shareLinkEvents: {
    revoked: (drawingId, linkId) => {
      // Kicks live anonymous viewers through the same push path used when a
      // member's access is revoked.
      roomRegistry.revoke(drawingId, shareUserId(linkId));
    },
  },
});
const libraryService = new LibraryService(
  new PostgresLibraryRepository(database.pool),
);
const shareLinkResolver = {
  async resolveToken(token: string) {
    const resolved = await sharingRepository.resolveShareToken(token);
    return resolved
      ? { linkId: resolved.linkId, drawingId: resolved.drawingId }
      : null;
  },
};

const storage: ObjectStorage = createStorageFromEnvironment(
  process.env.STORAGE_DRIVER?.trim() || "local",
);
const drawingRepository = new PostgresDrawingRepository(
  database.pool,
  storageDrawingBlobStore(storage),
);
const drawingService = new DrawingService(drawingRepository);
const adminEmails = parseAdminEmails(process.env.ADMIN_EMAILS);
const metricsToken = process.env.METRICS_TOKEN?.trim();
// Instance-wide per-user storage quota fallback (bytes). Unset/empty = null =
// unlimited; the DB admin setting and per-user override take precedence.
const storageQuotaPerUserBytes = positiveByteEnvironment(
  "STORAGE_QUOTA_PER_USER_BYTES",
);
const adminService = new AdminService(
  new PostgresAdminRepository(database.pool, (input) =>
    drawingRepository.purge(input),
  ),
  storageQuotaPerUserBytes,
);
// At most one mention email per recipient per drawing per window, whatever the
// message volume. The maintenance prune uses the same window.
const mentionEmailCooldownMinutes = positiveEnvironmentInteger(
  "MENTION_EMAIL_COOLDOWN_MINUTES",
  15,
);
const maintenanceJobs = new MaintenanceJobs(database.pool, storage, {
  mentionEmailCooldownMs: mentionEmailCooldownMinutes * 60_000,
});
const maintenanceIntervalMs = positiveEnvironmentInteger(
  "MAINTENANCE_INTERVAL_MS",
  6 * 60 * 60 * 1_000,
);
let maintenanceInFlight: Promise<void> | null = null;
let maintenanceAbortController: AbortController | null = null;
let maintenanceStopping = false;
let lastMaintenance: LastMaintenanceRun | null = null;
const runMaintenance = (): Promise<void> => {
  if (maintenanceStopping) return Promise.resolve();
  if (maintenanceInFlight) return maintenanceInFlight;
  const abortController = new AbortController();
  maintenanceAbortController = abortController;
  maintenanceInFlight = (async () => {
    const startedAt = Date.now();
    try {
      const result = await maintenanceJobs.run(abortController.signal);
      lastMaintenance = { finishedAt: new Date(), result };
      const hasFailures = result.failures.length > 0;
      operationalLog(
        hasFailures ? "error" : "info",
        hasFailures ? "maintenance.partial_failure" : "maintenance.complete",
        {
          auditEventsDeleted: result.auditEventsDeleted,
          drawingsPurged: result.drawingsPurged,
          expiredInvitationsDeleted: result.expiredInvitationsDeleted,
          expiredSessionsDeleted: result.expiredSessionsDeleted,
          expiredVerificationsDeleted: result.expiredVerificationsDeleted,
          failures: result.failures.map(({ errorType, id, stage }) => ({
            errorType,
            id,
            stage,
          })),
          latencyMs: Date.now() - startedAt,
          mentionEmailStatesDeleted: result.mentionEmailStatesDeleted,
          mutationsDeleted: result.mutationsDeleted,
          orphanAssetsDeleted: result.orphanAssetsDeleted,
          revisionsPruned: result.revisionsPruned,
        },
      );
    } catch (error) {
      if (abortController.signal.aborted && isAbortError(error)) {
        operationalLog("info", "maintenance.cancelled", {
          latencyMs: Date.now() - startedAt,
        });
      } else {
        operationalLog("error", "maintenance.failed", {
          errorType: safeErrorType(error),
          latencyMs: Date.now() - startedAt,
        });
      }
    } finally {
      if (maintenanceAbortController === abortController) {
        maintenanceAbortController = null;
      }
      maintenanceInFlight = null;
    }
  })();
  return maintenanceInFlight;
};
const maintenanceTimer = setInterval(() => {
  void runMaintenance();
}, maintenanceIntervalMs);
maintenanceTimer.unref();
const assetService = new AssetService({
  repository: new DrizzleAssetRepository(database.db),
  storage,
  defaultStorageQuotaBytes: storageQuotaPerUserBytes,
});
const collaborationRepository = new PostgresMutationRepository(database.pool);
const membershipResolver = {
  async getRole(drawingId: string, userId: string) {
    const result = await database.pool.query<{
      role: "owner" | "editor" | "viewer";
    }>(
      `SELECT CASE
         WHEN d.owner_user_id = $2 THEN 'owner'
         ELSE m.role
       END AS role
       FROM drawings d
       LEFT JOIN drawing_members m
         ON m.drawing_id = d.id AND m.user_id = $2
       WHERE d.id = $1 AND d.deleted_at IS NULL
         AND (d.owner_user_id = $2 OR m.user_id IS NOT NULL)
       LIMIT 1`,
      [drawingId, userId],
    );
    return result.rows[0]?.role ?? null;
  },
};
const sessionValidityResolver = {
  async isSessionActive(sessionId: string, userId: string) {
    const result = await database.pool.query(
      `SELECT 1 FROM session
       WHERE id = $1 AND user_id = $2 AND expires_at > now()
       LIMIT 1`,
      [sessionId, userId],
    );
    return result.rowCount === 1;
  },
};
const mutationService = new MutationService({
  repository: collaborationRepository,
  sessionValidityResolver,
});
const previewService = new PreviewService({
  membershipResolver,
  sessionValidityResolver,
});
const presenceService = new PresenceService({
  membershipResolver,
  sessionValidityResolver,
});
const chatService = new ChatService({
  repository: new PostgresChatRepository(database.pool),
  membershipResolver,
  mentionNotifier: new MentionEmailNotifier({
    repository: new PostgresMentionNotificationRepository(database.pool),
    mailer,
    // Presence in this drawing's room only: being elsewhere in the app is not
    // being in the conversation.
    presentUserIds: (drawingId) =>
      presenceService
        .roster(drawingId)
        .map((participant) => participant.userId),
    appBaseUrl: baseUrl,
    cooldownMinutes: mentionEmailCooldownMinutes,
    heroImageUrl: emailHeroImageUrl,
    onError: (error) =>
      operationalLog("error", "chat.mention_email_failed", {
        errorType: safeErrorType(error),
      }),
  }),
});
const assetRouter = Router().use(
  "/api/v1",
  createAssetRouter({
    service: assetService,
    resolveIdentity: async (request) => {
      const resolved = await identity.resolve(request.headers);
      return resolved ? { userId: resolved.userId } : null;
    },
    resolveShareDrawing: async (token) =>
      (await shareLinkResolver.resolveToken(token))?.drawingId ?? null,
    onError: (error, request) => {
      // Expected client failures (4xx) are visible in responses; only
      // unexpected errors need operator visibility.
      if (error instanceof AssetError && error.status < 500) {
        return;
      }
      const cause = rootCause(error);
      operationalLog("error", "assets.request_failed", {
        errorType: safeErrorType(error),
        causeType: safeErrorType(cause),
        causeCode: errorCodeOf(cause),
        message: cause instanceof Error ? cause.message : String(cause),
        method: request.method,
        path: request.path,
      });
    },
  }),
);
const staticDirectory =
  process.env.STATIC_DIRECTORY ??
  (process.env.NODE_ENV === "production"
    ? productionStaticDirectory()
    : undefined);
const exportService = new ExportService({
  content: contentService,
  drawings: drawingService,
  assets: assetService,
  renderer: createSceneRenderer({
    // Excalidraw's `fonts/` tree: shipped in the web build, which the image
    // serves as the static directory, and taken from the package itself when
    // running from a source checkout.
    assetRoot:
      process.env.EXCALIDRAW_ASSET_ROOT?.trim() ||
      staticDirectory ||
      excalidrawPackageDirectory(),
    // Built by `pnpm --filter @open-excalidraw/server run bundle:excalidraw-export`;
    // exports 503 until it exists.
    bundlePath:
      process.env.EXCALIDRAW_EXPORT_BUNDLE?.trim() ||
      join(process.cwd(), "dist", "excalidraw-export.mjs"),
  }),
});
// Opt-in: only a proxy that overwrites the forwarded headers makes them
// trustworthy. Defaulting off means a directly exposed port cannot have its
// per-IP auth throttling bypassed by a spoofed header.
const trustProxy = process.env.TRUST_PROXY === "true";
const app = createApp({
  allowedOrigins: allowedBrowserOrigins,
  trustProxy,
  readiness: async () => {
    await database.pool.query("SELECT 1");
  },
  routers: [
    // Ahead of every router: a scoped token is refused here, once, rather than
    // in each route's own authorization.
    enforceTokenScope(bearerTokens),
    // Before the auth router: its authorize and register guards must run ahead
    // of Better Auth's own handlers for those paths.
    createOauthRouter({
      identity,
      publicBaseUrl: baseUrl,
      findClient: createOauthClientLookup(database.pool),
    }),
    createAuthRouter({
      auth,
      identity,
      capabilities: authCapabilities({
        smtpEnabled,
        disableSignups,
        ...(google ? { google } : {}),
        ...(github ? { github } : {}),
        ...(oidc ? { oidc } : {}),
      }),
      adminEmails,
      manualResetLinks,
      ...(adminResetToken ? { adminResetToken } : {}),
    }),
    createAdminRouter({ service: adminService, identity, adminEmails }),
    createDrawingRouter({ service: drawingService, identity }),
    createContentRouter({ service: contentService, identity }),
    createExportRouter({
      service: exportService,
      identity,
      logError: (event, error, context) =>
        operationalLog("error", event, {
          ...context,
          errorType: safeErrorType(error),
          // A failed render is the server's own fault — a missing bundle, an
          // unregistered font — and the name alone leaves an operator with a
          // 503 and nowhere to look.
          errorMessage: safeErrorMessage(error),
        }),
    }),
    createLibraryRouter({ service: libraryService, identity }),
    createSharingRouter({ service: sharingService, identity }),
    createChatRouter({ service: chatService, identity }),
    createTokenRouter({ service: tokenService, identity }),
    createMcpRouter({
      identity,
      drawings: drawingService,
      content: contentService,
      sharing: sharingService,
      export: exportService,
      assets: assetService,
      publicBaseUrl: baseUrl,
      logError: (event, error, context) =>
        operationalLog("error", event, {
          ...context,
          errorType: safeErrorType(error),
        }),
    }),
    createNotificationRouter({
      repository: new PostgresNotificationSettingsRepository(database.pool),
      identity,
    }),
    assetRouter,
    createDocsRouter(),
    createMetricsRouter({
      ...(metricsToken ? { token: metricsToken } : {}),
      overview: () => adminService.getOverview(),
      activeSessions: async () => {
        const result = await database.pool.query<{ count: string }>(
          `SELECT count(*) AS count FROM "session" WHERE expires_at > now()`,
        );
        return Number(result.rows[0]?.count ?? 0);
      },
      collabConnections: () => roomRegistry.connectionCount(),
      resyncBroadcasts: () => collaborationGateway.resyncBroadcasts(),
      lastMaintenance: () => lastMaintenance,
    }),
  ],
  ...(staticDirectory ? { staticDirectory } : {}),
});

const port = Number.parseInt(process.env.APP_PORT ?? "3000", 10);
const server = createServer(app);
const io = new SocketIoServer(server, {
  // Socket.IO's default 1 MiB cap is below the contract scene/patch limits,
  // which would silently drop large full-scene resyncs.
  maxHttpBufferSize: CONTRACT_LIMITS.sceneBytes + 2 * 1024 * 1024,
  path: "/socket.io",
  serveClient: false,
});
const collaborationGateway = attachCollaborationGateway(io, {
  chatService,
  identityService: identity,
  membershipResolver,
  mutationService,
  originPolicy: new StrictOriginPolicy(allowedBrowserOrigins),
  presenceService,
  previewService,
  roomRegistry,
  securityAudit: (event) =>
    insertAuditEvent(database.pool, {
      actorUserId: event.actorUserId,
      drawingId: event.drawingId,
      eventType: "collaboration.write_rejected",
      requestId: event.requestId,
      metadata: { action: event.action, reason: "role-forbidden" },
    }),
  sessionValidityResolver,
  shareLinkResolver,
  snapshotProvider: collaborationRepository,
});

server.listen(port, () => {
  operationalLog("info", "server.listening", { port });
  void runMaintenance();
});

let shutdownStarted = false;
const shutdown = () => {
  if (shutdownStarted) return;
  shutdownStarted = true;
  maintenanceStopping = true;
  clearInterval(maintenanceTimer);
  maintenanceAbortController?.abort();
  collaborationGateway.close();
  void io.close(() => {
    void (maintenanceInFlight ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => database.close())
      .finally(() => process.exit(0));
  });
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

function loadEnvironmentFile(): void {
  const candidates = [
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "../../.env"),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (path) loadDotenv({ path, quiet: true });
}

function positiveEnvironmentInteger(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`${name} must be a positive base-10 integer`);
  }
  const value = Number(raw);
  // Node timers overflow above a signed 32-bit millisecond delay and are
  // otherwise clamped to 1 ms, which would turn a typo into a tight loop.
  if (!Number.isSafeInteger(value) || value > 2_147_483_647) {
    throw new Error(`${name} must not exceed 2147483647`);
  }
  return value;
}

// Like positiveEnvironmentInteger but unset/empty yields null (unlimited) and
// the ceiling is 2^53 rather than 2^31 — storage quotas are byte counts, not
// timer delays, so gigabyte-scale values must not overflow a 32-bit clamp.
function positiveByteEnvironment(name: string): number | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`${name} must be a positive base-10 integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be below 2^53`);
  }
  return value;
}

function operationalLog(
  level: "info" | "error",
  event: string,
  details: Record<string, unknown>,
) {
  process.stdout.write(
    `${JSON.stringify({ level, event, time: new Date().toISOString(), ...details })}\n`,
  );
}

function rootCause(error: unknown): unknown {
  let current = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (current instanceof Error && current.cause !== undefined) {
      current = current.cause;
    } else {
      break;
    }
  }
  return current;
}

function errorCodeOf(error: unknown): string | null {
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return null;
}

function safeErrorType(error: unknown): string {
  if (
    error instanceof Error &&
    /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name)
  ) {
    return error.name;
  }
  return "UnknownError";
}

/** One sanitized line: no control characters, bounded length. */
function safeErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "";
  return [...error.message]
    .map((character) =>
      (character.codePointAt(0) ?? 0) < 0x20 ? " " : character,
    )
    .join("")
    .slice(0, 300);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function browserAllowedOrigins(publicBaseUrl: string): string[] {
  const configured = (process.env.SOCKET_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (process.env.NODE_ENV !== "production") {
    configured.push("http://localhost:5173");
  }
  return [...new Set([new URL(publicBaseUrl).origin, ...configured])];
}

function productionStaticDirectory(): string {
  const imageDirectory = join(process.cwd(), "public");
  if (existsSync(imageDirectory)) return imageDirectory;
  return join(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
}

/**
 * Where `@excalidraw/excalidraw` keeps its fonts in a source checkout, matching
 * how `apps/web/vite.config.ts` finds the same tree. The package is a dev
 * dependency, so a production install has to fall back to the static
 * directory the web build already copied them into.
 */
function excalidrawPackageDirectory(): string {
  try {
    return dirname(
      createRequire(import.meta.url).resolve("@excalidraw/excalidraw"),
    );
  } catch {
    return join(process.cwd(), "public");
  }
}

function oauthCredentials(
  provider: "GOOGLE" | "GITHUB",
): OAuthProviderCredentials | undefined {
  const clientId = process.env[`${provider}_CLIENT_ID`]?.trim();
  const clientSecret = process.env[`${provider}_CLIENT_SECRET`]?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}

function oidcConfig(): OidcProviderConfig | undefined {
  const issuerUrl = process.env.OIDC_ISSUER_URL?.trim();
  const clientId = process.env.OIDC_CLIENT_ID?.trim();
  const clientSecret = process.env.OIDC_CLIENT_SECRET?.trim();
  if (!issuerUrl || !clientId || !clientSecret) {
    return undefined;
  }
  const providerName = process.env.OIDC_PROVIDER_NAME?.trim();
  return {
    issuerUrl,
    clientId,
    clientSecret,
    ...(providerName ? { providerName } : {}),
  };
}

function createMailer(): Mailer {
  const host = process.env.SMTP_HOST?.trim();
  if (!host) {
    return new DisabledMailer();
  }

  return new SmtpMailer({
    host,
    port: Number.parseInt(process.env.SMTP_PORT ?? "587", 10),
    secure: process.env.SMTP_SECURE === "true",
    from: process.env.SMTP_FROM ?? "Open Excalidraw <noreply@example.com>",
    ...(process.env.SMTP_USER ? { user: process.env.SMTP_USER } : {}),
    ...(process.env.SMTP_PASSWORD
      ? { password: process.env.SMTP_PASSWORD }
      : {}),
  });
}
