import "dotenv/config";

import { createServer } from "node:http";
import { join } from "node:path";

import { createDatabase } from "@open-excalidraw/database";
import { DisabledMailer, SmtpMailer, type Mailer } from "@open-excalidraw/mail";
import { LocalObjectStorage } from "@open-excalidraw/storage";
import { Router } from "express";

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
    ? join(process.cwd(), "public")
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
    assetRouter,
  ],
  ...(staticDirectory ? { staticDirectory } : {}),
});

const port = Number.parseInt(process.env.APP_PORT ?? "3000", 10);
const server = createServer(app);

server.listen(port, () => {
  process.stdout.write(`Open Excalidraw server listening on ${port}\n`);
});

const shutdown = () => {
  server.close(() => {
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
