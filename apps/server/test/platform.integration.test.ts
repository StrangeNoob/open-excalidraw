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
} from "../src/modules/drawings/index.js";

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
      const drawingService = new DrawingService(
        new PostgresDrawingRepository(database.pool),
      );
      const assetService = new AssetService({
        repository: new DrizzleAssetRepository(database.db),
        storage: new LocalObjectStorage({ rootDirectory: assetDirectory }),
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

      const created = await agent
        .post("/api/v1/drawings")
        .send({ title: "Platform flow drawing" })
        .expect(201);
      const drawingId = String(created.body.id);
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
    } finally {
      await database.close();
      await rm(assetDirectory, { force: true, recursive: true });
    }
  });
});
