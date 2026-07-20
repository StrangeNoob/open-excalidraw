import { basename } from "node:path";
import { Readable } from "node:stream";

import {
  StorageNotFoundError,
  type ObjectStorage,
} from "@open-excalidraw/storage";

import {
  exportDrawings,
  type ExportableAsset,
  type ExportableDrawing,
} from "../../src/tools/export-drawings";

interface ExportedDocument {
  type: string;
  elements: unknown;
  appState: unknown;
  files: Record<
    string,
    { id: string; mimeType: string; dataURL: string; created: number }
  >;
}

const unused = () => Promise.reject(new Error("unused in export"));

function stubStorage(objects: Record<string, Buffer>): {
  storage: ObjectStorage;
  reads: string[];
} {
  const reads: string[] = [];
  const storage: ObjectStorage = {
    get: (key) => {
      reads.push(key);
      const bytes = objects[key];
      if (!bytes) {
        return Promise.reject(new StorageNotFoundError(key));
      }
      return Promise.resolve(Readable.from(bytes));
    },
    put: unused,
    stat: unused,
    delete: unused,
  };
  return { storage, reads };
}

function collectWrites() {
  const writes: { path: string; contents: string }[] = [];
  return {
    writes,
    writeFile: (path: string, contents: string) => {
      writes.push({ path, contents });
      return Promise.resolve();
    },
  };
}

const scene = {
  type: "excalidraw",
  version: 2,
  source: "https://draw.example.com",
  elements: [{ id: "el1", type: "image", fileId: "file-1" }],
  appState: { viewBackgroundColor: "#ffffff" },
};

describe("exportDrawings", () => {
  it("inlines a live image asset as a data URL", async () => {
    const drawing: ExportableDrawing = {
      id: "draw-1",
      title: "My Diagram",
      scene,
    };
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    const asset: ExportableAsset = {
      fileId: "file-1",
      storageKey: "assets/file-1",
      mimeType: "image/png",
      createdAt: new Date("2026-01-02T03:04:05.000Z"),
    };
    const { storage } = stubStorage({ "assets/file-1": bytes });
    const { writes, writeFile } = collectWrites();

    const summary = await exportDrawings({
      drawings: [drawing],
      loadAssets: () => Promise.resolve([asset]),
      storage,
      outputDirectory: "/out",
      writeFile,
    });

    expect(summary).toEqual({
      exported: 1,
      assetsInlined: 1,
      missingAssets: 0,
      failed: 0,
    });
    expect(writes).toHaveLength(1);
    const [write] = writes;
    if (!write) {
      throw new Error("expected one write");
    }
    expect(basename(write.path)).toBe("my-diagram-draw-1.excalidraw");

    const document = JSON.parse(write.contents) as ExportedDocument;
    expect(document.type).toBe("excalidraw");
    expect(document.elements).toEqual(scene.elements);
    expect(document.appState).toEqual(scene.appState);

    const file = document.files["file-1"];
    if (!file) {
      throw new Error("expected an inlined file");
    }
    expect(file.mimeType).toBe("image/png");
    expect(file.created).toBe(asset.createdAt.getTime());
    expect(file.dataURL).toBe(
      `data:image/png;base64,${bytes.toString("base64")}`,
    );
  });

  it("still writes a drawing when its asset is missing from storage", async () => {
    const drawing: ExportableDrawing = {
      id: "draw-2",
      title: "Gone",
      scene,
    };
    const asset: ExportableAsset = {
      fileId: "file-1",
      storageKey: "assets/missing",
      mimeType: "image/png",
      createdAt: new Date(0),
    };
    const { storage } = stubStorage({});
    const { writes, writeFile } = collectWrites();

    const summary = await exportDrawings({
      drawings: [drawing],
      loadAssets: () => Promise.resolve([asset]),
      storage,
      outputDirectory: "/out",
      writeFile,
    });

    expect(summary).toEqual({
      exported: 1,
      assetsInlined: 0,
      missingAssets: 1,
      failed: 0,
    });
    expect(writes).toHaveLength(1);
    const [write] = writes;
    if (!write) {
      throw new Error("expected one write");
    }
    const document = JSON.parse(write.contents) as ExportedDocument;
    expect(document.files).toEqual({});
  });

  it("falls back to an untitled slug for empty or symbol-only titles", async () => {
    const drawings: ExportableDrawing[] = [
      { id: "draw-empty", title: "", scene },
      { id: "draw-symbols", title: "!@#$%", scene },
    ];
    const { storage } = stubStorage({});
    const { writes, writeFile } = collectWrites();

    await exportDrawings({
      drawings,
      loadAssets: () => Promise.resolve([]),
      storage,
      outputDirectory: "/out",
      writeFile,
    });

    expect(writes.map((write) => basename(write.path))).toEqual([
      "untitled-draw-empty.excalidraw",
      "untitled-draw-symbols.excalidraw",
    ]);
  });

  it("reads and writes nothing in dry-run mode", async () => {
    const { storage, reads } = stubStorage({
      "assets/file-1": Buffer.from("x"),
    });
    const { writes, writeFile } = collectWrites();

    const summary = await exportDrawings({
      drawings: [{ id: "draw-3", title: "Dry", scene }],
      loadAssets: () =>
        Promise.resolve([
          {
            fileId: "file-1",
            storageKey: "assets/file-1",
            mimeType: "image/png",
            createdAt: new Date(0),
          },
        ]),
      storage,
      outputDirectory: "/out",
      writeFile,
      dryRun: true,
    });

    expect(summary.exported).toBe(1);
    expect(writes).toHaveLength(0);
    expect(reads).toHaveLength(0);
  });
});
