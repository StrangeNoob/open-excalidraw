import { createHash } from "node:crypto";

import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import type { TokenScope } from "@open-excalidraw/contracts";
import type { Express } from "express";
import request from "supertest";
import type { Mock } from "vitest";

import { createApp } from "../../app.js";
import type { AssetService } from "../assets/service.js";
import type { IdentityService } from "../auth/identity.js";
import { ContentDomainError } from "../content/errors.js";
import type { ContentService } from "../content/service.js";
import type { DrawingService } from "../drawings/service.js";
import type { ExportService } from "../export/service.js";
import type { SharingService } from "../sharing/service.js";
import { createMcpRouter } from "./router.js";

const TOKEN = "oepat_test";
const USER_ID = "10000000-0000-4000-8000-000000000001";
const DRAWING_ID = "10000000-0000-4000-8000-000000000002";

const scene = {
  type: "excalidraw" as const,
  version: 2,
  source: "test",
  elements: [],
  appState: {},
};

function createHarness(
  overrides: {
    content?: { load?: Mock; save?: Mock };
    drawings?: { list?: Mock; search?: Mock };
    exports?: { render?: Mock; ensureThumbnail?: Mock };
    assets?: { upload?: Mock };
    tokenScope?: TokenScope;
  } = {},
) {
  const content = {
    load: vi.fn().mockResolvedValue({
      revision: "4",
      scene,
      assetIds: [],
      savedAt: "2026-07-29T00:00:00.000Z",
    }),
    save: vi
      .fn()
      .mockResolvedValue({ revision: "5", savedAt: "2026-07-29T00:00:01Z" }),
    ...overrides.content,
  };
  const exports = {
    render: vi.fn().mockResolvedValue({
      revision: "4",
      contentType: "image/png",
      body: Buffer.from([137, 80, 78, 71]),
    }),
    ensureThumbnail: vi.fn().mockResolvedValue(true),
    ...overrides.exports,
  };
  const assets = {
    upload: vi.fn().mockImplementation(({ fileId, declaredMimeType, bytes }) =>
      Promise.resolve({
        asset: {
          fileId,
          mimeType: declaredMimeType,
          byteSize: (bytes as Buffer).byteLength,
        },
        created: true,
      }),
    ),
    ...overrides.assets,
  };
  const identity: IdentityService = {
    resolve: (headers) =>
      Promise.resolve(
        (headers as Record<string, string>).authorization === `Bearer ${TOKEN}`
          ? ({
              userId: USER_ID,
              ...(overrides.tokenScope
                ? { tokenScope: overrides.tokenScope }
                : {}),
            } as never)
          : null,
      ),
  };
  const logError = vi.fn();
  const app = createApp({
    routers: [
      createMcpRouter({
        identity,
        content: content as unknown as ContentService,
        drawings: (overrides.drawings ?? {}) as unknown as DrawingService,
        sharing: {} as SharingService,
        export: exports as unknown as ExportService,
        assets: assets as unknown as AssetService,
        logError,
        publicBaseUrl: "https://draw.example.com",
      }),
    ],
  });
  return { app, content, exports, assets, logError };
}

let nextId = 0;

const rpc = (
  app: Express,
  method: string,
  params?: Record<string, unknown>,
  token: string | null = TOKEN,
) => {
  const call = request(app)
    .post("/api/mcp")
    .set("accept", "application/json, text/event-stream")
    .set("content-type", "application/json");
  if (token) call.set("authorization", `Bearer ${token}`);
  return call.send({
    jsonrpc: "2.0",
    id: (nextId += 1),
    method,
    ...(params ? { params } : {}),
  });
};

const callTool = async (
  app: Express,
  name: string,
  args: Record<string, unknown> = {},
) => {
  const response = await rpc(app, "tools/call", { name, arguments: args });
  expect(response.status).toBe(200);
  return response.body.result as {
    isError?: boolean;
    content: { type: string; text: string }[];
  };
};

describe("MCP endpoint", () => {
  it("rejects an unauthenticated call before any MCP processing", async () => {
    const { app, content } = createHarness();

    const response = await rpc(app, "tools/list", undefined, null);

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ code: "AUTHENTICATION_REQUIRED" });
    expect(content.load).not.toHaveBeenCalled();
  });

  it("rejects a bad token", async () => {
    const { app } = createHarness();

    const response = await rpc(app, "tools/list", undefined, "oepat_wrong");

    expect(response.status).toBe(401);
  });

  it("has no stream to open and no session to delete", async () => {
    const { app } = createHarness();

    for (const method of ["get", "delete"] as const) {
      const response = await request(app)[method]("/api/mcp");
      expect(response.status).toBe(405);
      expect(response.headers.allow).toBe("POST");
    }
  });

  it("initializes and advertises its tools", async () => {
    const { app } = createHarness();

    const initialized = await rpc(app, "initialize", {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(initialized.status).toBe(200);
    expect(initialized.body.result.serverInfo.name).toBe("open-excalidraw");

    const listed = await rpc(app, "tools/list");
    expect(
      (listed.body.result.tools as { name: string }[]).map((tool) => tool.name),
    ).toEqual([
      "read_format",
      "list_drawings",
      "get_scene",
      "export_png",
      "create_drawing",
      "edit_scene",
      "upload_asset",
      "share_drawing",
    ]);
  });

  it("hides the write tools from a read-scoped token", async () => {
    const { app } = createHarness({ tokenScope: "read" });

    const listed = await rpc(app, "tools/list");

    expect(
      (listed.body.result.tools as { name: string }[]).map((tool) => tool.name),
    ).toEqual(["read_format", "list_drawings", "get_scene", "export_png"]);
  });

  it("keeps the write tools for a write-scoped token", async () => {
    const { app } = createHarness({ tokenScope: "write" });

    const listed = await rpc(app, "tools/list");

    expect(
      (listed.body.result.tools as { name: string }[]).map((tool) => tool.name),
    ).toContain("edit_scene");
  });

  it("serves the format reference", async () => {
    const { app } = createHarness();

    const result = await callTool(app, "read_format");

    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toContain("tombstones");
  });

  it("returns search hits as titles, in relevance order", async () => {
    const summary = (id: string, title: string) => ({
      id,
      title,
      updatedAt: "2026-07-29T00:00:00.000Z",
    });
    const { app } = createHarness({
      drawings: {
        list: vi.fn().mockResolvedValue({
          owned: [summary("a", "First"), summary("b", "Second")],
          shared: [summary("c", "Third")],
        }),
        search: vi.fn().mockResolvedValue({ drawingIds: ["c", "a", "gone"] }),
      },
    });

    const result = await callTool(app, "list_drawings", { search: "deploy" });

    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual([
      { drawingId: "c", title: "Third", updatedAt: "2026-07-29T00:00:00.000Z" },
      { drawingId: "a", title: "First", updatedAt: "2026-07-29T00:00:00.000Z" },
    ]);
  });

  it("saves an edit against the revision it read", async () => {
    const { app, content } = createHarness();

    const result = await callTool(app, "edit_scene", {
      drawingId: DRAWING_ID,
      upsert: [{ id: "box", type: "rectangle", x: 0, y: 0 }],
    });

    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
      revision: "5",
      elementCount: 1,
      unknownDeleteIds: [],
      url: `https://draw.example.com/drawings/${DRAWING_ID}`,
    });
    const [userId, drawingId, expectedRevision, mutationId, body] = content.save
      .mock.calls[0] as [
      string,
      string,
      bigint,
      string,
      { scene: { elements: Record<string, unknown>[] }; assetIds: string[] },
    ];
    expect([userId, drawingId, expectedRevision]).toEqual([
      USER_ID,
      DRAWING_ID,
      4n,
    ]);
    expect(mutationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.scene.elements[0]).toMatchObject({
      id: "box",
      version: 1,
      index: "a1",
    });
    expect(body.assetIds).toEqual([]);
  });

  it("re-reads and retries once the drawing moved under it", async () => {
    const conflict = new ContentDomainError(
      "VERSION_CONFLICT",
      412,
      "The drawing has changed",
    );
    const { app, content } = createHarness({
      content: {
        save: vi.fn().mockRejectedValueOnce(conflict).mockResolvedValue({
          revision: "9",
          savedAt: "2026-07-29T00:00:02Z",
        }),
      },
    });

    const result = await callTool(app, "edit_scene", {
      drawingId: DRAWING_ID,
      deleteIds: ["ghost"],
    });

    expect(JSON.parse(result.content[0]?.text ?? "")).toMatchObject({
      revision: "9",
      unknownDeleteIds: ["ghost"],
    });
    expect(content.load).toHaveBeenCalledTimes(2);
    // The rebased payload differs, so replaying the first mutation id would be
    // an idempotency mismatch.
    expect(content.save.mock.calls[0]?.[3]).not.toBe(
      content.save.mock.calls[1]?.[3],
    );
  });

  it("gives up after the retry cap when the conflict never clears", async () => {
    const conflict = new ContentDomainError(
      "VERSION_CONFLICT",
      412,
      "The drawing has changed",
    );
    const { app, content } = createHarness({
      content: { save: vi.fn().mockRejectedValue(conflict) },
    });

    const result = await callTool(app, "edit_scene", {
      drawingId: DRAWING_ID,
      upsert: [{ id: "box", type: "rectangle", x: 0, y: 0 }],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("VERSION_CONFLICT");
    expect(content.save).toHaveBeenCalledTimes(4);
  });

  it("does not retry non-conflict save failures", async () => {
    const mismatch = new ContentDomainError(
      "IDEMPOTENCY_MISMATCH",
      409,
      "Idempotency key was already used",
    );
    const { app, content } = createHarness({
      content: { save: vi.fn().mockRejectedValue(mismatch) },
    });

    const result = await callTool(app, "edit_scene", {
      drawingId: DRAWING_ID,
      upsert: [{ id: "box", type: "rectangle", x: 0, y: 0 }],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("IDEMPOTENCY_MISMATCH");
    expect(content.save).toHaveBeenCalledTimes(1);
  });

  it("returns the problem code as a tool error, never a stack trace", async () => {
    const { app } = createHarness({
      content: {
        load: vi
          .fn()
          .mockRejectedValue(
            new ContentDomainError(
              "DRAWING_NOT_FOUND",
              404,
              "Drawing not found",
            ),
          ),
      },
    });

    const result = await callTool(app, "get_scene", { drawingId: DRAWING_ID });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe(
      "DRAWING_NOT_FOUND: Drawing not found",
    );
  });

  it("hands back a rendered PNG as an image block, not JSON", async () => {
    const { app, exports } = createHarness();

    const result = await callTool(app, "export_png", { drawingId: DRAWING_ID });

    expect(result.isError).toBeFalsy();
    expect(result.content[0]).toEqual({
      type: "image",
      data: Buffer.from([137, 80, 78, 71]).toString("base64"),
      mimeType: "image/png",
    });
    expect(exports.render).toHaveBeenCalledWith(USER_ID, DRAWING_ID, {
      format: "png",
      maxWidthOrHeight: 512,
    });
  });

  it("gives an agent-written drawing a dashboard thumbnail on save", async () => {
    const { app, exports } = createHarness();

    await callTool(app, "edit_scene", {
      drawingId: DRAWING_ID,
      upsert: [{ id: "box", type: "rectangle", x: 0, y: 0 }],
    });

    expect(exports.ensureThumbnail).toHaveBeenCalledWith(USER_ID, DRAWING_ID);
  });

  it("uploads image bytes under a content-addressed file ID", async () => {
    const { app, assets } = createHarness();
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    const result = await callTool(app, "upload_asset", {
      drawingId: DRAWING_ID,
      mimeType: "image/png",
      dataBase64: bytes.toString("base64"),
    });

    expect(assets.upload).toHaveBeenCalledWith({
      identity: { userId: USER_ID },
      drawingId: DRAWING_ID,
      fileId: sha256,
      declaredMimeType: "image/png",
      expectedSha256: sha256,
      fileVersion: null,
      bytes,
    });
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
      fileId: sha256,
      mimeType: "image/png",
      byteSize: bytes.byteLength,
    });
  });

  it("refuses an oversize upload without calling the asset service", async () => {
    const { app, assets } = createHarness();

    const result = await callTool(app, "upload_asset", {
      drawingId: DRAWING_ID,
      mimeType: "image/png",
      dataBase64: Buffer.alloc(4 * 1024 * 1024 + 1).toString("base64"),
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("ASSET_TOO_LARGE");
    expect(assets.upload).not.toHaveBeenCalled();
  });

  it("refuses malformed base64 instead of uploading truncated bytes", async () => {
    const { app, assets } = createHarness();

    const result = await callTool(app, "upload_asset", {
      drawingId: DRAWING_ID,
      mimeType: "image/png",
      dataBase64: "not base64!!",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/base64/i);
    expect(assets.upload).not.toHaveBeenCalled();
  });

  it("keeps a committed save when the thumbnail render fails", async () => {
    const failure = new Error("skia exploded");
    const { app, logError } = createHarness({
      exports: { ensureThumbnail: vi.fn().mockRejectedValue(failure) },
    });

    const result = await callTool(app, "edit_scene", {
      drawingId: DRAWING_ID,
      upsert: [{ id: "box", type: "rectangle", x: 0, y: 0 }],
    });

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0]?.text ?? "")).toMatchObject({
      revision: "5",
    });
    expect(logError).toHaveBeenCalledWith(
      "mcp.thumbnail_failed",
      failure,
      expect.objectContaining({ drawingId: DRAWING_ID }),
    );
  });
});
