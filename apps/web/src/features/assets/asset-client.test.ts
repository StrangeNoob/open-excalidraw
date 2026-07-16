import type {
  BinaryFileData,
  BinaryFiles,
  DataURL,
} from "@excalidraw/excalidraw/types";

import {
  AssetClient,
  AssetUploadManager,
  collectAssetReferences,
  hydrateAssets,
} from "./asset-client";
import { CloudPersistence } from "./cloud-persistence";

const file = (id: string): BinaryFileData => ({
  created: 1,
  dataURL: "data:image/png;base64,AA==" as DataURL,
  id: id as BinaryFileData["id"],
  mimeType: "image/png",
});

describe("asset pipeline", () => {
  it("deduplicates uploads and commits the scene only afterward", async () => {
    const order: string[] = [];
    const upload = vi.fn((_drawingId: string, value: BinaryFileData) => {
      order.push(`upload:${value.id}`);
      return Promise.resolve({} as never);
    });
    const save = vi.fn(() => {
      order.push("save");
      return Promise.resolve({
        revision: "2",
        savedAt: new Date().toISOString(),
      });
    });
    const files: BinaryFiles = { image: file("image") };
    const manager = new AssetUploadManager({ client: { upload } });
    const persistence = new CloudPersistence("drawing", { save }, manager);
    const snapshot = {
      files,
      request: {
        assetIds: ["image"],
        scene: {
          appState: {},
          elements: [],
          source: "test",
          type: "excalidraw" as const,
          version: 2,
        },
      },
    };

    await Promise.all([
      persistence.persist(snapshot, "1", "key-1"),
      persistence.persist(snapshot, "1", "key-2"),
    ]);

    expect(upload).toHaveBeenCalledOnce();
    expect(order[0]).toBe("upload:image");
    expect(order.filter((entry) => entry === "save")).toHaveLength(2);
  });

  it("hydrates available images incrementally and exposes failures", async () => {
    let resolveSlow!: (value: BinaryFileData) => void;
    const slow = new Promise<BinaryFileData>((resolve) => {
      resolveSlow = resolve;
    });
    const client = {
      download: vi.fn((_drawingId: string, fileId: string) => {
        if (fileId === "missing") {
          return Promise.reject(new Error("not found"));
        }
        return slow;
      }),
    };
    const api = { addFiles: vi.fn() };
    const pending = hydrateAssets(api, client, "drawing", ["slow", "missing"]);
    await Promise.resolve();
    expect(api.addFiles).not.toHaveBeenCalled();
    resolveSlow(file("slow"));
    const result = await pending;

    expect(api.addFiles).toHaveBeenCalledWith([file("slow")]);
    expect(result.loaded).toEqual(["slow"]);
    expect(result.failed.get("missing")?.message).toBe("not found");
    expect(result.cancelled).toBe(false);
  });

  it("does not add a stale download after hydration is aborted", async () => {
    let resolveDownload!: (value: BinaryFileData) => void;
    const client = {
      download: vi.fn(
        () =>
          new Promise<BinaryFileData>((resolve) => {
            resolveDownload = resolve;
          }),
      ),
    };
    const api = { addFiles: vi.fn() };
    const abort = new AbortController();
    const pending = hydrateAssets(
      api,
      client,
      "old-drawing",
      ["image"],
      abort.signal,
    );
    abort.abort();
    resolveDownload(file("image"));

    await expect(pending).resolves.toMatchObject({
      cancelled: true,
      loaded: [],
    });
    expect(api.addFiles).not.toHaveBeenCalled();
  });

  it("uploads and deletes thumbnails with checksum, type, and credentials", async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(new Response(null, { status: 204 })),
    );
    const client = new AssetClient({
      fetch: fetch as unknown as typeof globalThis.fetch,
      sha256: () => Promise.resolve("ab".repeat(32)),
    });

    await client.uploadThumbnail(
      "10000000-0000-4000-8000-000000000001",
      new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
    );
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/drawings/10000000-0000-4000-8000-000000000001/thumbnail",
      expect.objectContaining({
        credentials: "include",
        headers: {
          "content-type": "image/png",
          "x-content-sha256": "ab".repeat(32),
        },
        method: "PUT",
      }),
    );

    await client.deleteThumbnail("10000000-0000-4000-8000-000000000001");
    expect(fetch).toHaveBeenLastCalledWith(
      "/api/v1/drawings/10000000-0000-4000-8000-000000000001/thumbnail",
      expect.objectContaining({ credentials: "include", method: "DELETE" }),
    );

    fetch.mockResolvedValueOnce(new Response(null, { status: 403 }));
    await expect(
      client.uploadThumbnail(
        "10000000-0000-4000-8000-000000000001",
        new Blob([new Uint8Array([1])], { type: "image/png" }),
      ),
    ).rejects.toMatchObject({ status: 403 });

    fetch.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(
      client.deleteThumbnail("10000000-0000-4000-8000-000000000001"),
    ).rejects.toThrow("thumbnail delete failed (503)");
  });

  it("collects image references from live elements and retained tombstones", () => {
    expect(
      collectAssetReferences([
        { fileId: "b", isDeleted: false },
        { fileId: "a", isDeleted: false },
        { fileId: "a", isDeleted: false },
        { fileId: "deleted", isDeleted: true },
      ]),
    ).toEqual(["a", "b", "deleted"]);
  });
});
