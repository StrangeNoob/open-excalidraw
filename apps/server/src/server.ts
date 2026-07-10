import "dotenv/config";

import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createDatabase } from "@open-excalidraw/database";
import { DisabledMailer, SmtpMailer, type Mailer } from "@open-excalidraw/mail";
import { LocalObjectStorage } from "@open-excalidraw/storage";
import { Router } from "express";
import { Server as SocketIoServer } from "socket.io";

import { createApp } from "./app.js";
import {
  AssetService,
  createAssetRouter,
  DrizzleAssetRepository,
} from "./modules/assets/index.js";
import {
  authCapabilities,
  createAuthRouter,
  createIdentityService,
  createOpenExcalidrawAuth,
  OneTimeManualResetLinkStore,
  type OAuthProviderCredentials,
} from "./modules/auth/index.js";
import {
  createDrawingRouter,
  DrawingService,
  PostgresDrawingRepository,
} from "./modules/drawings/index.js";
import { MutationService } from "./modules/collaboration/mutation-service.js";
import { PostgresMutationRepository } from "./modules/collaboration/persistence/index.js";
import { PresenceService } from "./modules/collaboration/presence-service.js";
import { PreviewService } from "./modules/collaboration/preview-service.js";
import { RoomRegistry } from "./modules/collaboration/room-registry.js";
import { StrictOriginPolicy } from "./modules/collaboration/security/index.js";
import { attachCollaborationGateway } from "./modules/collaboration/socket-gateway.js";
import {
  ContentService,
  createContentRouter,
  PostgresContentRepository,
} from "./modules/content/index.js";
import {
  createSharingRouter,
  PostgresSharingRepository,
  SharingService,
} from "./modules/sharing/index.js";

const databaseUrl = requiredEnvironment("DATABASE_URL");
const baseUrl = process.env.APP_BASE_URL ?? "http://localhost:3000";
const secret = requiredEnvironment("BETTER_AUTH_SECRET");
const smtpEnabled = Boolean(process.env.SMTP_HOST?.trim());
const adminResetToken = process.env.ADMIN_RESET_TOKEN?.trim();
if (!smtpEnabled && (!adminResetToken || adminResetToken.length < 32)) {
  throw new Error(
    "ADMIN_RESET_TOKEN with at least 32 characters is required when SMTP is disabled",
  );
}
const google = oauthCredentials("GOOGLE");
const github = oauthCredentials("GITHUB");
const database = createDatabase(databaseUrl);
const mailer = createMailer();
const manualResetLinks = new OneTimeManualResetLinkStore();
const auth = createOpenExcalidrawAuth({
  database: database.db,
  mailer,
  baseUrl,
  secret,
  smtpEnabled,
  manualResetLinks,
  ...(google ? { google } : {}),
  ...(github ? { github } : {}),
});
const identity = createIdentityService(auth);
const drawingService = new DrawingService(
  new PostgresDrawingRepository(database.pool),
);
const contentService = new ContentService(
  new PostgresContentRepository(database.pool),
);
const roomRegistry = new RoomRegistry();
const sharingService = new SharingService({
  repository: new PostgresSharingRepository(database.pool),
  mailer,
  publicBaseUrl: baseUrl,
  requireVerifiedEmailForAcceptance: smtpEnabled,
  membershipEvents: {
    roleChanged: (drawingId, userId, role) => {
      roomRegistry.changeRole(drawingId, userId, role);
    },
    revoked: (drawingId, userId) => {
      roomRegistry.revoke(drawingId, userId);
    },
  },
});

if ((process.env.STORAGE_DRIVER ?? "local") !== "local") {
  throw new Error("Only STORAGE_DRIVER=local is available in this release");
}

const storage = new LocalObjectStorage({
  rootDirectory:
    process.env.STORAGE_LOCAL_PATH ?? join(process.cwd(), "uploads"),
});
const assetService = new AssetService({
  repository: new DrizzleAssetRepository(database.db),
  storage,
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
const assetRouter = Router().use(
  "/api/v1",
  createAssetRouter({
    service: assetService,
    resolveIdentity: async (request) => {
      const resolved = await identity.resolve(request.headers);
      return resolved ? { userId: resolved.userId } : null;
    },
  }),
);
const staticDirectory =
  process.env.STATIC_DIRECTORY ??
  (process.env.NODE_ENV === "production"
    ? productionStaticDirectory()
    : undefined);
const app = createApp({
  readiness: async () => {
    await database.pool.query("SELECT 1");
  },
  routers: [
    createAuthRouter({
      auth,
      identity,
      capabilities: authCapabilities({
        smtpEnabled,
        ...(google ? { google } : {}),
        ...(github ? { github } : {}),
      }),
      manualResetLinks,
      ...(adminResetToken ? { adminResetToken } : {}),
    }),
    createDrawingRouter({ service: drawingService, identity }),
    createContentRouter({ service: contentService, identity }),
    createSharingRouter({ service: sharingService, identity }),
    assetRouter,
  ],
  ...(staticDirectory ? { staticDirectory } : {}),
});

const port = Number.parseInt(process.env.APP_PORT ?? "3000", 10);
const server = createServer(app);
const io = new SocketIoServer(server, {
  path: "/socket.io",
  serveClient: false,
});
const collaborationGateway = attachCollaborationGateway(io, {
  identityService: identity,
  membershipResolver,
  mutationService,
  originPolicy: new StrictOriginPolicy(socketAllowedOrigins(baseUrl)),
  presenceService,
  previewService,
  roomRegistry,
  sessionValidityResolver,
  snapshotProvider: collaborationRepository,
});

server.listen(port, () => {
  process.stdout.write(`Open Excalidraw server listening on ${port}\n`);
});

const shutdown = () => {
  collaborationGateway.close();
  void io.close(() => {
    void database.close().finally(() => process.exit(0));
  });
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function socketAllowedOrigins(publicBaseUrl: string): string[] {
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

function oauthCredentials(
  provider: "GOOGLE" | "GITHUB",
): OAuthProviderCredentials | undefined {
  const clientId = process.env[`${provider}_CLIENT_ID`]?.trim();
  const clientSecret = process.env[`${provider}_CLIENT_SECRET`]?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
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
