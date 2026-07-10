import type {
  BinaryFileData,
  BinaryFiles,
  DataURL,
} from "@excalidraw/excalidraw/types";

import {
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
