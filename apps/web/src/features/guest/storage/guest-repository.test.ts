import type { BinaryFileData, DataURL } from "@excalidraw/excalidraw/types";

import { GuestRepository, deleteGuestDatabase } from "./guest-repository";

const databaseNames = new Set<string>();
const repositories = new Set<GuestRepository>();

const createRepository = () => {
  const databaseName = `guest-test-${crypto.randomUUID()}`;
  const repository = new GuestRepository({ databaseName });

  databaseNames.add(databaseName);
  repositories.add(repository);

  return { databaseName, repository };
};

const createFile = (id: string): BinaryFileData => ({
  created: 1,
  dataURL: "data:image/png;base64,AA==" as DataURL,
  id: id as BinaryFileData["id"],
  mimeType: "image/png",
});

afterEach(async () => {
  await Promise.all([...repositories].map((repository) => repository.close()));
  await Promise.all(
    [...databaseNames].map((name) => deleteGuestDatabase(name)),
  );
  repositories.clear();
  databaseNames.clear();
  vi.unstubAllGlobals();
});

describe("GuestRepository", () => {
  it("persists scenes and assets across repository recreation", async () => {
    const { databaseName, repository } = createRepository();
    const file = createFile("asset-1");

    await repository.saveSnapshot({
      drawingId: "default",
      files: { [file.id]: file },
      scene: { elements: [] },
      title: "Local sketch",
    });
    await repository.close();

    const reopened = new GuestRepository({ databaseName });
    repositories.add(reopened);

    await expect(reopened.loadScene("default")).resolves.toMatchObject({
      assetIds: ["asset-1"],
      revision: 1,
      title: "Local sketch",
    });
    await expect(reopened.getAsset("default", "asset-1")).resolves.toEqual(
      file,
    );
    await expect(reopened.loadInitialData("default")).resolves.toMatchObject({
      elements: [],
      files: { "asset-1": file },
    });
    await expect(reopened.getMigrationMarkers()).resolves.toEqual([]);
  });

  it("preserves existing asset references when a scene-only save omits asset ids", async () => {
    const { repository } = createRepository();
    const file = createFile("asset-1");

    await repository.saveSnapshot({
      drawingId: "default",
      files: { [file.id]: file },
      scene: { elements: [] },
      title: "With asset",
    });
    const sceneOnlySave = await repository.saveScene({
      drawingId: "default",
      scene: { elements: [] },
      title: "Still with asset",
    });

    expect(sceneOnlySave).toMatchObject({
      assetIds: ["asset-1"],
      revision: 2,
    });
    await expect(repository.loadInitialData("default")).resolves.toMatchObject({
      files: { "asset-1": file },
    });
  });

  it("removes guest assets omitted from a later complete snapshot", async () => {
    const { repository } = createRepository();
    const retained = createFile("retained");
    const removed = createFile("removed");

    await repository.saveSnapshot({
      drawingId: "default",
      files: { [retained.id]: retained, [removed.id]: removed },
      scene: { elements: [] },
      title: "Two assets",
    });
    await repository.saveSnapshot({
      drawingId: "default",
      files: { [retained.id]: retained },
      scene: { elements: [] },
      title: "One asset",
    });

    await expect(repository.getAsset("default", "retained")).resolves.toEqual(
      retained,
    );
    await expect(
      repository.getAsset("default", "removed"),
    ).resolves.toBeUndefined();
  });

  it("records guest-to-cloud migration progress per drawing", async () => {
    const databaseName = `guest-test-${crypto.randomUUID()}`;
    const completedAt = new Date("2026-07-10T12:30:00.000Z");
    const repository = new GuestRepository({
      databaseName,
      now: () => completedAt,
    });
    databaseNames.add(databaseName);
    repositories.add(repository);

    await repository.saveScene({
      drawingId: "default",
      scene: { elements: [] },
      title: "Ready to migrate",
    });
    const marker = await repository.markMigrationComplete({
      drawingId: "default",
      migratedLocalRevision: 1,
      targetCloudDrawingId: "015b3d63-6e17-4a4a-aebf-dc79aa220d87",
    });

    expect(marker).toEqual({
      completedAt: completedAt.toISOString(),
      drawingId: "default",
      migratedLocalRevision: 1,
      targetCloudDrawingId: "015b3d63-6e17-4a4a-aebf-dc79aa220d87",
    });
    await repository.close();

    const reopened = new GuestRepository({ databaseName });
    repositories.add(reopened);
    await expect(reopened.getMigrationMarker("default")).resolves.toEqual(
      marker,
    );

    await reopened.clearMigrationMarker("default");
    await expect(
      reopened.getMigrationMarker("default"),
    ).resolves.toBeUndefined();
  });

  it("rejects migration markers ahead of the local scene revision", async () => {
    const { repository } = createRepository();
    await repository.saveScene({
      drawingId: "default",
      scene: { elements: [] },
      title: "Local",
    });

    await expect(
      repository.markMigrationComplete({
        drawingId: "default",
        migratedLocalRevision: 2,
        targetCloudDrawingId: "015b3d63-6e17-4a4a-aebf-dc79aa220d87",
      }),
    ).rejects.toThrow("newer than the guest drawing");
  });

  it("assigns monotonic revisions, including concurrent writes", async () => {
    const { repository } = createRepository();

    const records = await Promise.all(
      ["One", "Two", "Three"].map((title) =>
        repository.saveScene({
          drawingId: "default",
          scene: { elements: [] },
          title,
        }),
      ),
    );

    expect(records.map(({ revision }) => revision)).toEqual([1, 2, 3]);
    await expect(repository.loadScene("default")).resolves.toMatchObject({
      revision: 3,
      title: "Three",
    });
  });

  it("performs guest persistence without HTTP or WebSocket activity", async () => {
    const fetch = vi.fn();
    const WebSocket = vi.fn();
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("WebSocket", WebSocket);
    const { repository } = createRepository();

    await repository.saveScene({
      drawingId: "default",
      scene: { elements: [] },
      title: "Offline",
    });
    await repository.loadInitialData("default");

    expect(fetch).not.toHaveBeenCalled();
    expect(WebSocket).not.toHaveBeenCalled();
  });
});
