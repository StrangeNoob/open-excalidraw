import { createHash } from "node:crypto";

import type { Mock } from "vitest";

import { ExportDomainError } from "./errors.js";
import { ExportService, MAX_EXPORT_BYTES } from "./service.js";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const DRAWING_ID = "10000000-0000-4000-8000-000000000002";

const PNG = Buffer.from("fake-png");

function createHarness(
  overrides: {
    scene?: Record<string, unknown>;
    thumbnailUpdatedAt?: string | null;
    png?: Mock;
    svg?: Mock;
  } = {},
) {
  const renderer = {
    svg: overrides.svg ?? vi.fn().mockResolvedValue("<svg/>"),
    png: overrides.png ?? vi.fn().mockResolvedValue(PNG),
  };
  const content = {
    load: vi.fn().mockResolvedValue({
      revision: "7",
      scene: {
        type: "excalidraw",
        version: 2,
        source: "test",
        elements: [{ id: "a" }],
        appState: { viewBackgroundColor: "#f5f5f5", exportWithDarkMode: true },
        ...overrides.scene,
      },
      assetIds: [],
      savedAt: "2026-07-29T00:00:00.000Z",
    }),
  };
  const drawings = {
    get: vi.fn().mockResolvedValue({
      id: DRAWING_ID,
      thumbnailUpdatedAt: overrides.thumbnailUpdatedAt ?? null,
    }),
  };
  const assets = { uploadThumbnail: vi.fn().mockResolvedValue(undefined) };
  const service = new ExportService({
    content,
    drawings,
    assets,
    renderer,
  });
  return { service, renderer, content, drawings, assets };
}

describe("ExportService.render", () => {
  it("renders SVG with the scene's revision and a light export state", async () => {
    const { service, renderer } = createHarness();

    const result = await service.render(USER_ID, DRAWING_ID, {
      format: "svg",
    });

    expect(result).toEqual({
      revision: "7",
      contentType: "image/svg+xml",
      body: Buffer.from("<svg/>", "utf8"),
    });
    expect(renderer.svg).toHaveBeenCalledWith({
      elements: [{ id: "a" }],
      appState: {
        viewBackgroundColor: "#f5f5f5",
        exportBackground: true,
        exportWithDarkMode: false,
      },
    });
  });

  it("passes scale and the fit limit through to the PNG render", async () => {
    const { service, renderer } = createHarness();

    const result = await service.render(USER_ID, DRAWING_ID, {
      format: "png",
      scale: 2,
      maxWidthOrHeight: 512,
    });

    expect(result.contentType).toBe("image/png");
    expect(renderer.png).toHaveBeenCalledWith(
      expect.objectContaining({ scale: 2, maxWidthOrHeight: 512 }),
    );
  });

  it("refuses a render larger than the output cap", async () => {
    const { service } = createHarness({
      png: vi.fn().mockResolvedValue(Buffer.alloc(MAX_EXPORT_BYTES + 1)),
    });

    await expect(
      service.render(USER_ID, DRAWING_ID, { format: "png" }),
    ).rejects.toMatchObject({ code: "EXPORT_TOO_LARGE", status: 413 });
  });

  it("reports a renderer failure as unavailable, keeping the cause", async () => {
    const cause = new Error("skia exploded");
    const { service } = createHarness({
      svg: vi.fn().mockRejectedValue(cause),
    });

    const error = await service
      .render(USER_ID, DRAWING_ID, { format: "svg" })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ExportDomainError);
    expect(error).toMatchObject({ code: "EXPORT_UNAVAILABLE", status: 503 });
    expect((error as ExportDomainError).cause).toBe(cause);
  });

  it("lets an access failure from the content load through unchanged", async () => {
    const { service, content } = createHarness();
    content.load.mockRejectedValue(
      Object.assign(new Error("nope"), { code: "DRAWING_NOT_FOUND" }),
    );

    await expect(
      service.render(USER_ID, DRAWING_ID, { format: "svg" }),
    ).rejects.toMatchObject({ code: "DRAWING_NOT_FOUND" });
  });
});

describe("ExportService.ensureThumbnail", () => {
  it("uploads a checksummed 640px PNG when the drawing has none", async () => {
    const { service, renderer, assets } = createHarness();

    await expect(service.ensureThumbnail(USER_ID, DRAWING_ID)).resolves.toBe(
      true,
    );
    expect(renderer.png).toHaveBeenCalledWith(
      expect.objectContaining({ maxWidthOrHeight: 640 }),
    );
    expect(assets.uploadThumbnail).toHaveBeenCalledWith({
      identity: { userId: USER_ID },
      drawingId: DRAWING_ID,
      declaredMimeType: "image/png",
      expectedSha256: createHash("sha256").update(PNG).digest("hex"),
      bytes: PNG,
    });
  });

  it("leaves an existing thumbnail alone", async () => {
    const { service, renderer, assets } = createHarness({
      thumbnailUpdatedAt: "2026-07-29T00:00:00.000Z",
    });

    await expect(service.ensureThumbnail(USER_ID, DRAWING_ID)).resolves.toBe(
      false,
    );
    expect(renderer.png).not.toHaveBeenCalled();
    expect(assets.uploadThumbnail).not.toHaveBeenCalled();
  });

  it("skips a render too large for the thumbnail store", async () => {
    const { service, assets } = createHarness({
      png: vi.fn().mockResolvedValue(Buffer.alloc(512 * 1024 + 1)),
    });

    await expect(service.ensureThumbnail(USER_ID, DRAWING_ID)).resolves.toBe(
      false,
    );
    expect(assets.uploadThumbnail).not.toHaveBeenCalled();
  });
});
