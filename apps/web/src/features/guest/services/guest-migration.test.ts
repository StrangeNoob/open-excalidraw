import type { BinaryFiles } from "@excalidraw/excalidraw/types";

import type { GuestMigrationRecord, GuestSceneRecord } from "../model";
import {
  GuestMigrationService,
  type GuestMigrationCloud,
  type GuestMigrationRepository,
} from "./guest-migration";

const scene: GuestSceneRecord = {
  assetIds: [],
  drawingId: "guest",
  revision: 4,
  scene: { elements: [] },
  title: "Local sketch",
  updatedAt: "2026-07-11T00:00:00.000Z",
};

const setup = () => {
  const markers = new Map<string, GuestMigrationRecord>();
  const getAssets = vi.fn<GuestMigrationRepository["getAssets"]>(() =>
    Promise.resolve({} satisfies BinaryFiles),
  );
  const getMigrationMarker = vi.fn<
    GuestMigrationRepository["getMigrationMarker"]
  >((userId) => Promise.resolve(markers.get(userId)));
  const loadScene = vi.fn<GuestMigrationRepository["loadScene"]>(() =>
    Promise.resolve(scene),
  );
  const markMigrationComplete = vi.fn<
    GuestMigrationRepository["markMigrationComplete"]
  >((input) => {
    const completed: GuestMigrationRecord = {
      ...input,
      completedAt: "2026-07-11T00:01:00.000Z",
    };
    markers.set(input.userId, completed);
    return Promise.resolve(completed);
  });
  const repository: GuestMigrationRepository = {
    getAssets,
    getMigrationMarker,
    loadScene,
    markMigrationComplete,
  };
  const createDrawing = vi
    .fn<GuestMigrationCloud["createDrawing"]>()
    .mockResolvedValue({
      contentRevision: "0",
      id: "015b3d63-6e17-4a4a-aebf-dc79aa220d87",
      ownerUserId: "user-a",
    });
  const saveContent = vi
    .fn<GuestMigrationCloud["saveContent"]>()
    .mockResolvedValue({ revision: "1" });
  const uploadAssets = vi
    .fn<GuestMigrationCloud["uploadAssets"]>()
    .mockResolvedValue(undefined);
  const cloud: GuestMigrationCloud = {
    createDrawing,
    saveContent,
    uploadAssets,
  };
  const service = new GuestMigrationService(repository, cloud, (value) =>
    Promise.resolve(`stable:${value}`),
  );
  return {
    cloud,
    createDrawing,
    getMigrationMarker,
    loadScene,
    markMigrationComplete,
    repository,
    saveContent,
    service,
    uploadAssets,
  };
};

describe("GuestMigrationService", () => {
  const scopeFor = (userId: string, signal?: AbortSignal) => ({
    getActiveUserId: () => userId,
    signal,
  });

  it("retains the guest and leaves it unmarked after a failed migration", async () => {
    const { loadScene, markMigrationComplete, saveContent, service } = setup();
    saveContent.mockRejectedValueOnce(new Error("offline"));

    await expect(
      service.migrate("user-a", "guest", scopeFor("user-a")),
    ).rejects.toThrow("offline");
    expect(markMigrationComplete).not.toHaveBeenCalled();
    expect(loadScene).toHaveBeenCalledWith("guest");
  });

  it("marks only after server acknowledgement and is idempotent afterward", async () => {
    const {
      createDrawing,
      getMigrationMarker,
      markMigrationComplete,
      saveContent,
      service,
    } = setup();
    const order: string[] = [];
    saveContent.mockImplementation(() => {
      order.push("acknowledged");
      return Promise.resolve({ revision: "1" });
    });
    markMigrationComplete.mockImplementation((input) => {
      order.push("marked");
      return Promise.resolve({
        ...input,
        completedAt: "2026-07-11T00:01:00.000Z",
      });
    });

    const first = await service.migrate("user-a", "guest", scopeFor("user-a"));
    getMigrationMarker.mockResolvedValue(first);
    const second = await service.migrate("user-a", "guest", scopeFor("user-a"));

    expect(order).toEqual(["acknowledged", "marked"]);
    expect(second).toEqual(first);
    expect(createDrawing).toHaveBeenCalledOnce();
    expect(saveContent).toHaveBeenCalledOnce();
  });

  it("scopes stable create and content keys to the authenticated account", async () => {
    const { createDrawing, markMigrationComplete, saveContent, service } =
      setup();
    createDrawing.mockImplementation((_title, key) =>
      Promise.resolve({
        contentRevision: "0",
        id: "015b3d63-6e17-4a4a-aebf-dc79aa220d87",
        ownerUserId: key.includes("user-a") ? "user-a" : "user-b",
      }),
    );

    await service.migrate("user-a", "guest", scopeFor("user-a"));
    await service.migrate("user-b", "guest", scopeFor("user-b"));

    expect(createDrawing.mock.calls[0]?.[1]).toContain("user-a");
    expect(createDrawing.mock.calls[1]?.[1]).toContain("user-b");
    expect(saveContent.mock.calls[0]?.[3]).toContain("user-a");
    expect(saveContent.mock.calls[1]?.[3]).toContain("user-b");
    expect(
      markMigrationComplete.mock.calls.map(([input]) => input.userId),
    ).toEqual(["user-a", "user-b"]);
  });

  it("rejects a create response owned by another account before upload", async () => {
    const { createDrawing, markMigrationComplete, service, uploadAssets } =
      setup();
    createDrawing.mockResolvedValueOnce({
      contentRevision: "0",
      id: "015b3d63-6e17-4a4a-aebf-dc79aa220d87",
      ownerUserId: "user-b",
    });

    await expect(
      service.migrate("user-a", "guest", scopeFor("user-a")),
    ).rejects.toThrow("different account");
    expect(uploadAssets).not.toHaveBeenCalled();
    expect(markMigrationComplete).not.toHaveBeenCalled();
  });

  it("stops when the expected session changes while create is in flight", async () => {
    const { createDrawing, markMigrationComplete, service, uploadAssets } =
      setup();
    let activeUserId = "user-a";
    createDrawing.mockImplementation(() => {
      activeUserId = "user-b";
      return Promise.resolve({
        contentRevision: "0",
        id: "015b3d63-6e17-4a4a-aebf-dc79aa220d87",
        ownerUserId: "user-a",
      });
    });

    await expect(
      service.migrate("user-a", "guest", {
        getActiveUserId: () => activeUserId,
      }),
    ).rejects.toThrow("account changed");
    expect(uploadAssets).not.toHaveBeenCalled();
    expect(markMigrationComplete).not.toHaveBeenCalled();
  });
});
