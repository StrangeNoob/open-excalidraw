import {
  captureThumbnail,
  THUMBNAIL_MAX_DIMENSION,
  type ThumbnailClient,
} from "./thumbnail";

const exportToBlob = vi.hoisted(() => vi.fn());
vi.mock("@excalidraw/excalidraw", () => ({ exportToBlob }));

const DRAWING = "10000000-0000-4000-8000-000000000001";

const client = (): ThumbnailClient & {
  deleteThumbnail: ReturnType<typeof vi.fn>;
  uploadThumbnail: ReturnType<typeof vi.fn>;
} => ({
  deleteThumbnail: vi.fn(() => Promise.resolve()),
  uploadThumbnail: vi.fn(() => Promise.resolve()),
});

const editor = (elements: unknown[]) =>
  ({
    getAppState: () => ({ theme: "dark", viewBackgroundColor: "#123456" }),
    getFiles: () => ({}),
    getSceneElements: () => elements,
  }) as never;

describe("captureThumbnail", () => {
  beforeEach(() => {
    exportToBlob.mockReset();
  });

  it("clears the thumbnail instead of exporting an empty scene", async () => {
    const thumbnails = client();
    const state = await captureThumbnail(editor([]), DRAWING, thumbnails);

    expect(state).toBeNull();
    expect(thumbnails.deleteThumbnail).toHaveBeenCalledWith(DRAWING);
    expect(exportToBlob).not.toHaveBeenCalled();
    expect(thumbnails.uploadThumbnail).not.toHaveBeenCalled();
  });

  it("skips the delete once the thumbnail is known to be cleared", async () => {
    const thumbnails = client();
    const state = await captureThumbnail(editor([]), DRAWING, thumbnails, null);

    expect(state).toBeNull();
    expect(thumbnails.deleteThumbnail).not.toHaveBeenCalled();
  });

  it("exports a bounded light-mode PNG and uploads it", async () => {
    const blob = new Blob([new Uint8Array([1])], { type: "image/png" });
    exportToBlob.mockResolvedValue(blob);
    const thumbnails = client();
    const elements = [{ id: "a" }];

    const sha256 = await captureThumbnail(
      editor(elements),
      DRAWING,
      thumbnails,
    );

    expect(exportToBlob).toHaveBeenCalledWith({
      elements,
      appState: expect.objectContaining({
        exportBackground: true,
        exportWithDarkMode: false,
        viewBackgroundColor: "#123456",
      }),
      files: {},
      maxWidthOrHeight: THUMBNAIL_MAX_DIMENSION,
      mimeType: "image/png",
    });
    expect(sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(thumbnails.uploadThumbnail).toHaveBeenCalledWith(DRAWING, blob);
    expect(thumbnails.deleteThumbnail).not.toHaveBeenCalled();
  });

  it("skips the upload when the exported bytes are unchanged", async () => {
    const blob = new Blob([new Uint8Array([1])], { type: "image/png" });
    exportToBlob.mockResolvedValue(blob);
    const thumbnails = client();
    const elements = [{ id: "a" }];

    const first = await captureThumbnail(editor(elements), DRAWING, thumbnails);
    const second = await captureThumbnail(
      editor(elements),
      DRAWING,
      thumbnails,
      first,
    );

    expect(second).toBe(first);
    expect(thumbnails.uploadThumbnail).toHaveBeenCalledTimes(1);
  });

  it("propagates export failures to the caller's catch", async () => {
    exportToBlob.mockRejectedValue(new Error("canvas unavailable"));
    const thumbnails = client();

    await expect(
      captureThumbnail(editor([{ id: "a" }]), DRAWING, thumbnails),
    ).rejects.toThrow("canvas unavailable");
    expect(thumbnails.uploadThumbnail).not.toHaveBeenCalled();
  });
});
