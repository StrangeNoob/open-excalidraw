import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDatabase, runMigrations } from "@open-excalidraw/database";
import { DisabledMailer } from "@open-excalidraw/mail";
import { LocalObjectStorage } from "@open-excalidraw/storage";
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from "testcontainers";
import { Router } from "express";
import request from "supertest";

import { createApp } from "../src/app.js";
import {
  AssetService,
  createAssetRouter,
  DrizzleAssetRepository,
} from "../src/modules/assets/index.js";
import {
  authCapabilities,
  createAuthRouter,
  createIdentityService,
  createOpenExcalidrawAuth,
} from "../src/modules/auth/index.js";
import {
  createDrawingRouter,
  DrawingService,
  PostgresDrawingRepository,
  storageDrawingBlobStore,
} from "../src/modules/drawings/index.js";
import {
  ContentService,
  createContentRouter,
  PostgresContentRepository,
} from "../src/modules/content/index.js";
import {
  createSharingRouter,
  PostgresSharingRepository,
  SharingService,
} from "../src/modules/sharing/index.js";

const BASE_URL = "http://localhost:3000";
const SECRET = "integration-secret-with-at-least-thirty-two-characters";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

let container: StartedTestContainer | undefined;
let databaseUrl: string;

beforeAll(async () => {
  if (process.env.DATABASE_TEST_URL) {
    databaseUrl = process.env.DATABASE_TEST_URL;
    return;
  }

  container = await new GenericContainer("postgres:17-alpine")
    .withEnvironment({
      POSTGRES_DB: "open_excalidraw_platform_test",
      POSTGRES_PASSWORD: "open_excalidraw",
      POSTGRES_USER: "open_excalidraw",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(
      Wait.forLogMessage("database system is ready to accept connections", 2),
    )
    .start();
  databaseUrl = `postgresql://open_excalidraw:open_excalidraw@${container.getHost()}:${container.getMappedPort(5432)}/open_excalidraw_platform_test`;
}, 60_000);

afterAll(async () => {
  await container?.stop();
});

describe("Wave 2 platform flow", () => {
  it("registers, creates a drawing, and round-trips an authorized asset", async () => {
    const database = createDatabase(databaseUrl);
    const assetDirectory = await mkdtemp(
      join(tmpdir(), "open-excalidraw-platform-assets-"),
    );

    try {
      await runMigrations({ pool: database.pool });
      await database.pool.query('TRUNCATE TABLE "user" CASCADE');

      const auth = createOpenExcalidrawAuth({
        database: database.db,
        mailer: new DisabledMailer(),
        baseUrl: BASE_URL,
        secret: SECRET,
        secureCookies: false,
        smtpEnabled: false,
      });
      const identity = createIdentityService(auth);
      const storage = new LocalObjectStorage({ rootDirectory: assetDirectory });
      const drawingService = new DrawingService(
        new PostgresDrawingRepository(
          database.pool,
          storageDrawingBlobStore(storage),
        ),
      );
      const contentService = new ContentService(
        new PostgresContentRepository(database.pool),
      );
      const sharingService = new SharingService({
        repository: new PostgresSharingRepository(database.pool),
        mailer: new DisabledMailer(),
        publicBaseUrl: BASE_URL,
        requireVerifiedEmailForAcceptance: false,
      });
      const assetService = new AssetService({
        repository: new DrizzleAssetRepository(database.db),
        storage,
      });
      const assetRouter = Router().use(
        "/api/v1",
        createAssetRouter({
          service: assetService,
          resolveIdentity: async (incoming) => {
            const resolved = await identity.resolve(incoming.headers);
            return resolved ? { userId: resolved.userId } : null;
          },
        }),
      );
      const app = createApp({
        allowedOrigins: [BASE_URL],
        readiness: async () => {
          await database.pool.query("SELECT 1");
        },
        routers: [
          createAuthRouter({
            auth,
            identity,
            capabilities: authCapabilities({ smtpEnabled: false }),
          }),
          createDrawingRouter({ service: drawingService, identity }),
          createContentRouter({ service: contentService, identity }),
          createSharingRouter({ service: sharingService, identity }),
          assetRouter,
        ],
      });
      const agent = request.agent(app);

      await agent.get("/health/ready").expect(200, { status: "ready" });
      await agent
        .post("/api/auth/sign-up/email")
        .set("origin", BASE_URL)
        .send({
          email: "platform-flow@example.test",
          name: "Platform Flow",
          password: "correct-horse-battery-staple",
        })
        .expect(200);

      const session = await agent.get("/api/v1/me").expect(200);
      expect(session.body.user).toMatchObject({
        email: "platform-flow@example.test",
      });

      const createDrawing = () =>
        agent.post("/api/v1/drawings").send({
          title: "Platform flow drawing",
          idempotencyKey: "d021fbbb-f9c4-4dc4-a679-fafacbbc4ef4",
        });
      const [created, replayedCreate] = await Promise.all([
        createDrawing(),
        createDrawing(),
      ]);
      expect(created.status).toBe(201);
      expect(replayedCreate.status).toBe(201);
      const drawingId = String(created.body.id);
      expect(replayedCreate.body.id).toBe(drawingId);
      const drawingCount = await database.pool.query<{ count: string }>(
        "SELECT count(*) FROM drawings WHERE id = $1",
        [drawingId],
      );
      expect(drawingCount.rows[0]?.count).toBe("1");
      const checksum = createHash("sha256").update(PNG).digest("hex");

      await agent
        .put(`/api/v1/drawings/${drawingId}/assets/platform-image`)
        .set("content-type", "image/png")
        .set("x-content-sha256", checksum)
        .send(PNG)
        .expect(201);
      const downloaded = await agent
        .get(`/api/v1/drawings/${drawingId}/assets/platform-image`)
        .expect(200);
      expect(downloaded.body).toEqual(PNG);

      const saved = await agent
        .put(`/api/v1/drawings/${drawingId}/content`)
        .set("if-match", '"0"')
        .set("idempotency-key", "a8bc7237-0778-46d7-85d0-392ed424fc85")
        .send({
          scene: {
            type: "excalidraw",
            version: 2,
            source: "open-excalidraw-platform-test",
            elements: [
              {
                id: "image-1",
                type: "image",
                version: 1,
                versionNonce: 1,
                isDeleted: false,
                index: "a0",
                fileId: "platform-image",
              },
            ],
            appState: {},
          },
          assetIds: ["platform-image"],
        })
        .expect(200);
      expect(saved.headers.etag).toBe('"1"');

      const invitation = await agent
        .post(`/api/v1/drawings/${drawingId}/invitations`)
        .send({ email: "platform-editor@example.test", role: "editor" })
        .expect(201);
      expect(invitation.body.deliveryStatus).toBe("manual");
      const invitationToken = new URL(
        String(invitation.body.manualUrl),
      ).pathname
        .split("/")
        .at(-1);
      expect(invitationToken).toBeTruthy();

      const editor = request.agent(app);
      await editor
        .post("/api/auth/sign-up/email")
        .set("origin", BASE_URL)
        .send({
          email: "platform-editor@example.test",
          name: "Platform Editor",
          password: "correct-horse-battery-staple",
        })
        .expect(200);
      await editor
        .post(`/api/v1/invitations/${invitationToken}/accept`)
        .expect(200);
      const sharedContent = await editor
        .get(`/api/v1/drawings/${drawingId}/content`)
        .expect(200);
      expect(sharedContent.headers.etag).toBe('"1"');
      expect(sharedContent.body.assetIds).toEqual(["platform-image"]);

      // Duplicating copies the scene, asset rows, and asset blobs into a
      // drawing owned by the caller, with revisions reset.
      const duplicated = await editor
        .post(`/api/v1/drawings/${drawingId}/duplicate`)
        .expect(201);
      expect(duplicated.body).toMatchObject({
        title: "Platform flow drawing copy",
        role: "owner",
        contentRevision: "0",
        isTemplate: false,
      });
      const copyId = String(duplicated.body.id);
      expect(copyId).not.toBe(drawingId);

      const copyContent = await editor
        .get(`/api/v1/drawings/${copyId}/content`)
        .expect(200);
      expect(copyContent.headers.etag).toBe('"0"');
      expect(copyContent.body.scene.elements).toHaveLength(1);

      const copyAsset = await editor
        .get(`/api/v1/drawings/${copyId}/assets/platform-image`)
        .expect(200);
      expect(copyAsset.body).toEqual(PNG);

      // The owner cannot reach the copy; it belongs to the duplicator.
      await agent.get(`/api/v1/drawings/${copyId}`).expect(404);
    } finally {
      await database.close();
      await rm(assetDirectory, { force: true, recursive: true });
    }
  });
});
