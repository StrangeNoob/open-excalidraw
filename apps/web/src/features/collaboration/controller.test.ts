import "../../shared/test/excalidraw-dom";

import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import type {
  ClientRealtimeEvent,
  ExcalidrawElementDTO,
  ServerRealtimeEvent,
} from "@open-excalidraw/contracts";
import { waitFor } from "@testing-library/react";

import type { CloudOutboxRecord } from "../connectivity/storage/cloudOutboxDb";
import {
  CollaborationController,
  type CollaborationControllerOptions,
  type CollaborationOutbox,
} from "./controller";
import type {
  PresenceBroadcast,
  RealtimeTransport,
  RealtimeTransportHandlers,
  RoomReadyEvent,
} from "./types";

const DRAWING = "00000000-0000-4000-8000-000000000001";
const USER = "10000000-0000-4000-8000-000000000001";
const CLIENT = "20000000-0000-4000-8000-000000000001";

const element = (version: number, id = "element"): ExcalidrawElementDTO => ({
  id,
  index: "a0",
  isDeleted: false,
  type: "rectangle",
  version,
  versionNonce: version,
});

class MemoryOutbox implements CollaborationOutbox {
  readonly records = new Map<string, CloudOutboxRecord>();
  failNextPut = false;

  list(userId: string, drawingId: string) {
    return Promise.resolve(
      [...this.records.values()]
        .filter(
          (record) =>
            record.userId === userId && record.drawingId === drawingId,
        )
        .sort((left, right) => left.generation - right.generation),
    );
  }

  put(record: CloudOutboxRecord) {
    if (this.failNextPut) {
      this.failNextPut = false;
      return Promise.reject(new Error("IndexedDB unavailable"));
    }
    this.records.set(record.mutationId, structuredClone(record));
    return Promise.resolve();
  }

  remove(userId: string, drawingId: string, mutationId: string) {
    const record = this.records.get(mutationId);
    if (record?.userId === userId && record.drawingId === drawingId) {
      this.records.delete(mutationId);
    }
    return Promise.resolve();
  }
}

class FakeTransport implements RealtimeTransport {
  handlers: RealtimeTransportHandlers | null = null;
  readonly emitted: ClientRealtimeEvent[] = [];
  connectCalls = 0;

  setHandlers(handlers: RealtimeTransportHandlers | null) {
    this.handlers = handlers;
  }

  connect() {
    this.connectCalls += 1;
    this.handlers?.onConnect();
  }

  disconnect() {
    this.handlers?.onDisconnect("client disconnect");
  }

  emit(event: ClientRealtimeEvent) {
    this.emitted.push(structuredClone(event));
  }

  server(event: ServerRealtimeEvent) {
    this.handlers?.onServerEvent(event);
  }

  serverDisconnect(reason = "transport close") {
    this.handlers?.onDisconnect(reason);
  }

  presence(event: PresenceBroadcast) {
    this.handlers?.onPresence(event);
  }

  roster(collaborators: RoomReadyEvent["collaborators"]) {
    this.handlers?.onRoster(collaborators);
  }
}

const createEditor = () => {
  let elements: ExcalidrawElementDTO[] = [];
  let appState = {
    gridSize: 20,
    gridStep: 5,
    viewBackgroundColor: "#ffffff",
  } as unknown as AppState;
  const updateScene = vi.fn(
    (update: {
      appState?: Partial<AppState>;
      elements?: readonly unknown[];
    }) => {
      if (update.elements) {
        elements = structuredClone(update.elements) as ExcalidrawElementDTO[];
      }
      if (update.appState) {
        appState = { ...appState, ...update.appState };
      }
    },
  );
  const editor = {
    getAppState: () => appState,
    getSceneElementsIncludingDeleted: () => elements,
    updateScene,
  } as unknown as Pick<
    ExcalidrawImperativeAPI,
    "getAppState" | "getSceneElementsIncludingDeleted" | "updateScene"
  >;
  return {
    editor,
    getAppState: () => appState,
    getElements: () => elements,
    updateScene,
  };
};

const ready = (
  revision = "1",
  role: RoomReadyEvent["role"] = "editor",
  elements = [element(1)],
): RoomReadyEvent => ({
  assetManifest: [],
  collaborators: [],
  connectionId: "connection-a",
  revision,
  role,
  snapshot: {
    appState: {
      gridSize: 20,
      gridStep: 5,
      viewBackgroundColor: "#ffffff",
    },
    elements,
    source: "test",
    type: "excalidraw",
    version: 2,
  },
  type: "room.ready",
});

const setup = (options?: {
  outbox?: MemoryOutbox;
  role?: RoomReadyEvent["role"];
  presenceEnabled?: boolean;
  presenceHeartbeatMs?: number;
  deferReady?: boolean;
  initialRole?: RoomReadyEvent["role"];
  uploadAssets?: CollaborationControllerOptions["uploadAssets"];
}) => {
  const transport = new FakeTransport();
  const outbox = options?.outbox ?? new MemoryOutbox();
  const editor = createEditor();
  let id = 0;
  const controller = new CollaborationController({
    clientInstanceId: CLIENT,
    createId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
    drawingId: DRAWING,
    durableDebounceMs: 1_000,
    editor: editor.editor,
    fullResyncMs: 20_000,
    initialElements: [element(1)],
    initialRole: options?.initialRole,
    outbox,
    presenceEnabled: options?.presenceEnabled,
    presenceHeartbeatMs: options?.presenceHeartbeatMs,
    previewThrottleMs: 100,
    transport,
    uploadAssets: options?.uploadAssets,
    userId: USER,
  });
  controller.start();
  if (!options?.deferReady) transport.server(ready("1", options?.role));
  return { controller, editor, outbox, transport };
};

describe("CollaborationController", () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  it("applies remote commits without echoing them", async () => {
    const fixture = setup();
    await waitFor(() => expect(fixture.controller.state.status).toBe("ready"));
    fixture.transport.emitted.length = 0;
    fixture.transport.server({
      elements: [element(2)],
      mutationId: "00000000-0000-4000-8000-000000000099",
      revision: "2",
      type: "scene.committed",
    });
    await waitFor(() => expect(fixture.controller.state.revision).toBe("2"));

    fixture.controller.onChange(fixture.editor.getElements());
    await vi.advanceTimersByTimeAsync(2_000);

    expect(
      fixture.transport.emitted.filter((event) =>
        ["scene.preview", "scene.mutate"].includes(event.type),
      ),
    ).toEqual([]);
    expect(fixture.editor.updateScene).toHaveBeenLastCalledWith(
      expect.objectContaining({ captureUpdate: CaptureUpdateAction.NEVER }),
    );
  });

  it("keeps durable state dirty after sending a throttled preview", async () => {
    const fixture = setup();
    await waitFor(() => expect(fixture.controller.state.status).toBe("ready"));
    fixture.transport.emitted.length = 0;

    fixture.controller.onChange([element(2)]);
    expect(fixture.transport.emitted.map(({ type }) => type)).toEqual([
      "scene.preview",
    ]);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(fixture.transport.emitted.map(({ type }) => type)).toEqual([
      "scene.preview",
      "scene.mutate",
    ]);
    expect(fixture.outbox.records.size).toBe(1);
  });

  it("persists shared app-state changes without requiring an element change", async () => {
    const fixture = setup();
    await waitFor(() => expect(fixture.controller.state.status).toBe("ready"));
    fixture.transport.emitted.length = 0;

    fixture.controller.onChange(fixture.editor.getElements(), {
      ...fixture.editor.getAppState(),
      viewBackgroundColor: "#123456",
    });
    await fixture.controller.flush();

    expect(fixture.transport.emitted.at(-1)).toMatchObject({
      elements: [],
      sharedSceneState: { viewBackgroundColor: "#123456" },
      type: "scene.mutate",
    });
  });

  it("retains edits made while the room is still joining", async () => {
    const fixture = setup({ deferReady: true, initialRole: "editor" });

    fixture.controller.onChange([element(2)]);
    fixture.transport.server(ready("1", "editor", [element(1)]));

    await waitFor(() => expect(fixture.controller.state.status).toBe("ready"));
    expect(fixture.editor.getElements()[0]?.version).toBe(2);
    await fixture.controller.flush();
    expect([...fixture.outbox.records.values()][0]?.elements).toEqual([
      element(2),
    ]);
  });

  it("uploads local files before emitting their durable mutation", async () => {
    const uploaded: string[] = [];
    const fixture = setup({
      uploadAssets: (_drawingId, _files, fileIds) => {
        uploaded.push(...fileIds);
        return Promise.resolve();
      },
    });
    await waitFor(() => expect(fixture.controller.state.status).toBe("ready"));
    fixture.transport.emitted.length = 0;
    const image = {
      ...element(2, "image-element"),
      fileId: "file-1",
      type: "image",
    } as ExcalidrawElementDTO;
    const files = {
      "file-1": {
        created: 1,
        dataURL: "data:image/png;base64,AA==",
        id: "file-1",
        mimeType: "image/png",
      },
    } as unknown as BinaryFiles;

    fixture.controller.onChange([image], fixture.editor.getAppState(), files);
    await fixture.controller.flush();

    expect(uploaded).toEqual(["file-1"]);
    expect([...fixture.outbox.records.values()][0]?.files).toEqual(files);
    expect(fixture.transport.emitted.at(-1)?.type).toBe("scene.mutate");
  });

  it("removes exactly the acknowledged mutation generation", async () => {
    const fixture = setup();
    await waitFor(() => expect(fixture.controller.state.status).toBe("ready"));
    fixture.controller.onChange([element(2)]);
    await fixture.controller.flush();
    fixture.controller.onChange([element(3)]);
    await fixture.controller.flush();
    const mutations = [...fixture.outbox.records.values()];
    expect(mutations).toHaveLength(2);

    fixture.transport.server({
      mutationId: mutations[0]!.mutationId,
      revision: "2",
      status: "duplicate",
      type: "scene.ack",
    });
    await waitFor(() => expect(fixture.outbox.records.size).toBe(1));

    expect([...fixture.outbox.records][0]?.[0]).toBe(mutations[1]!.mutationId);
  });

  it("requests a snapshot resync instead of applying a revision gap", async () => {
    const fixture = setup();
    await waitFor(() => expect(fixture.controller.state.status).toBe("ready"));
    fixture.transport.emitted.length = 0;
    fixture.transport.server({
      elements: [element(3)],
      mutationId: "00000000-0000-4000-8000-000000000099",
      revision: "3",
      type: "scene.committed",
    });
    await waitFor(() =>
      expect(fixture.transport.emitted.at(-1)?.type).toBe("room.join"),
    );

    expect(fixture.controller.state.status).toBe("joining");
    expect(fixture.editor.getElements()[0]?.version).toBe(1);
  });

  it("never publishes scene writes for viewers", async () => {
    const fixture = setup({ role: "viewer" });
    await waitFor(() => expect(fixture.controller.state.status).toBe("ready"));
    fixture.transport.emitted.length = 0;
    fixture.controller.onChange([element(2)]);
    await vi.advanceTimersByTimeAsync(21_000);

    expect(
      fixture.transport.emitted.filter((event) =>
        event.type.startsWith("scene."),
      ),
    ).toEqual([]);
    fixture.controller.publishPresence({
      idleState: "active",
      pointer: { tool: "pointer", x: 4, y: 8 },
    });
    expect(fixture.transport.emitted.at(-1)?.type).toBe("presence.update");
  });

  it("drops presence payloads identical to the last published state", async () => {
    const fixture = setup();
    await waitFor(() => expect(fixture.controller.state.status).toBe("ready"));
    fixture.transport.emitted.length = 0;

    fixture.controller.publishPresence({
      idleState: "active",
      selectedElementIds: { element: true },
    });
    fixture.controller.publishPresence({
      idleState: "active",
      selectedElementIds: { element: true },
    });
    fixture.controller.publishPresence({
      idleState: "active",
      selectedElementIds: { element: true },
    });
    await vi.advanceTimersByTimeAsync(500);

    expect(
      fixture.transport.emitted.filter(
        ({ type }) => type === "presence.update",
      ),
    ).toHaveLength(1);
  });

  it("throttles pointer presence and emits the trailing update", async () => {
    const fixture = setup();
    await waitFor(() => expect(fixture.controller.state.status).toBe("ready"));
    fixture.transport.emitted.length = 0;

    for (let step = 1; step <= 30; step += 1) {
      fixture.controller.publishPresence({
        idleState: "active",
        pointer: { tool: "pointer", x: step, y: step },
      });
    }
    await vi.advanceTimersByTimeAsync(500);

    const presence = fixture.transport.emitted.filter(
      (
        event,
      ): event is Extract<ClientRealtimeEvent, { type: "presence.update" }> =>
        event.type === "presence.update",
    );
    expect(presence.length).toBeLessThanOrEqual(3);
    expect(presence.at(-1)?.pointer).toMatchObject({ x: 30, y: 30 });
  });

  it("reconnects and rejoins after a server-initiated disconnect", async () => {
    const fixture = setup();
    await waitFor(() => expect(fixture.controller.state.status).toBe("ready"));
    const joinsBefore = fixture.transport.emitted.filter(
      ({ type }) => type === "room.join",
    ).length;

    fixture.transport.serverDisconnect("io server disconnect");
    await waitFor(() =>
      expect(fixture.controller.state.status).toBe("reconnecting"),
    );
    await vi.advanceTimersByTimeAsync(2_000);

    await waitFor(() =>
      expect(
        fixture.transport.emitted.filter(({ type }) => type === "room.join"),
      ).toHaveLength(joinsBefore + 1),
    );
    expect(fixture.transport.connectCalls).toBe(2);
    fixture.transport.server(ready("1"));
    await waitFor(() => expect(fixture.controller.state.status).toBe("ready"));
  });

  it("does not reconnect after a membership revocation disconnect", async () => {
    const fixture = setup();
    await waitFor(() => expect(fixture.controller.state.status).toBe("ready"));

    fixture.transport.server({
      code: "SOCKET_MEMBERSHIP_REVOKED",
      message: "Drawing access was revoked",
      requestId: "revoked",
      retryable: false,
      type: "protocol.error",
    });
    await waitFor(() => expect(fixture.controller.state.role).toBeNull());
    fixture.transport.serverDisconnect("io server disconnect");
    await vi.advanceTimersByTimeAsync(10_000);

    expect(fixture.transport.connectCalls).toBe(1);
  });

  it("clears event-local errors once traffic succeeds again", async () => {
    const fixture = setup();
    await waitFor(() => expect(fixture.controller.state.status).toBe("ready"));
    fixture.transport.server({
      code: "PRESENCE_RATE_LIMITED",
      message: "Presence update rate exceeded",
      requestId: "request",
      retryable: true,
      type: "protocol.error",
    });
    await waitFor(() =>
      expect(fixture.controller.state.error?.code).toBe(
        "PRESENCE_RATE_LIMITED",
      ),
    );

    fixture.transport.server({
      elements: [element(2)],
      mutationId: "00000000-0000-4000-8000-000000000098",
      revision: "2",
      type: "scene.committed",
    });

    await waitFor(() => expect(fixture.controller.state.error).toBeNull());
    expect(fixture.controller.state.revision).toBe("2");
  });

  it("pauses local and periodic writes around a restore boundary and resumes after failure", async () => {
    const fixture = setup();
    await waitFor(() => expect(fixture.controller.state.status).toBe("ready"));
    fixture.transport.emitted.length = 0;
    fixture.controller.onChange([element(2)]);

    await fixture.controller.pauseWrites();
    const mutation = [...fixture.outbox.records.values()][0]!;
    expect(fixture.transport.emitted.at(-1)).toMatchObject({
      mutationId: mutation.mutationId,
      type: "scene.mutate",
    });

    fixture.controller.onChange([element(3)]);
    await vi.advanceTimersByTimeAsync(21_000);
    expect(
      fixture.transport.emitted.filter(({ type }) => type === "scene.mutate"),
    ).toHaveLength(1);

    fixture.transport.server({
      mutationId: mutation.mutationId,
      revision: "2",
      status: "duplicate",
      type: "scene.ack",
    });
    await waitFor(() => expect(fixture.outbox.records.size).toBe(0));
    await fixture.controller.resumeWrites();
    fixture.controller.onChange([element(3)]);
    await fixture.controller.flush();
    expect(
      fixture.transport.emitted.filter(({ type }) => type === "scene.mutate"),
    ).toHaveLength(2);
  });

  it("suppresses full-scene writes while a requested resync is joining", async () => {
    const fixture = setup();
    await waitFor(() => expect(fixture.controller.state.status).toBe("ready"));
    fixture.transport.emitted.length = 0;

    fixture.transport.server({
      reason: "revision-restored",
      revision: "2",
      type: "room.resyncRequired",
    });
    await waitFor(() =>
      expect(fixture.controller.state.status).toBe("joining"),
    );
    await vi.advanceTimersByTimeAsync(21_000);

    expect(
      fixture.transport.emitted.filter(({ type }) => type === "scene.mutate"),
    ).toEqual([]);
  });

  it("clears write authority on the actual membership-revoked protocol code", async () => {
    const fixture = setup();
    await waitFor(() => expect(fixture.controller.state.status).toBe("ready"));
    fixture.transport.emitted.length = 0;

    fixture.transport.server({
      code: "SOCKET_MEMBERSHIP_REVOKED",
      message: "Drawing access was revoked",
      requestId: "revoked-request",
      retryable: false,
      type: "protocol.error",
    });
    await waitFor(() => expect(fixture.controller.state.role).toBeNull());
    fixture.controller.onChange([element(2)]);
    await vi.advanceTimersByTimeAsync(21_000);

    expect(
      fixture.transport.emitted.filter(({ type }) => type.startsWith("scene.")),
    ).toEqual([]);
  });

  it("rebases persisted pending elements before reconnect resubmission", async () => {
    const outbox = new MemoryOutbox();
    const pending: CloudOutboxRecord = {
      baseRevision: "1",
      createdAt: "2026-07-11T00:00:00.000Z",
      drawingId: DRAWING,
      elements: [element(4)],
      generation: 7,
      mutationId: "00000000-0000-4000-8000-000000000077",
      userId: USER,
    };
    await outbox.put(pending);
    const fixture = setup({ outbox });
    fixture.transport.server(ready("5", "editor", [element(3)]));
    await waitFor(() => expect(fixture.controller.state.revision).toBe("5"));

    const resent = fixture.transport.emitted
      .filter(
        (event) =>
          event.type === "scene.mutate" &&
          event.mutationId === pending.mutationId,
      )
      .at(-1);
    expect(resent).toMatchObject({ baseRevision: "5", elements: [element(4)] });
    expect(fixture.editor.getElements()[0]?.version).toBe(4);
  });

  it("sends a durable full-scene resync every twenty seconds", async () => {
    const fixture = setup();
    await waitFor(() => expect(fixture.controller.state.status).toBe("ready"));
    fixture.transport.emitted.length = 0;
    await vi.advanceTimersByTimeAsync(20_000);

    expect(fixture.transport.emitted.at(-1)?.type).toBe("scene.mutate");
    expect(
      fixture.transport.emitted.at(-1) as Extract<
        ClientRealtimeEvent,
        { type: "scene.mutate" }
      >,
    ).toMatchObject({ elements: [element(1)] });
  });

  it("never includes another user's uncommitted preview in full resync", async () => {
    const fixture = setup();
    await waitFor(() => expect(fixture.controller.state.status).toBe("ready"));
    fixture.transport.emitted.length = 0;
    fixture.transport.server({
      baseRevision: "1",
      elements: [element(99, "remote-preview")],
      previewId: "00000000-0000-4000-8000-000000000088",
      type: "scene.preview",
    });
    await waitFor(() =>
      expect(
        fixture.editor.getElements().some(({ id }) => id === "remote-preview"),
      ).toBe(true),
    );
    await vi.advanceTimersByTimeAsync(20_000);

    const full = fixture.transport.emitted.find(
      (event) => event.type === "scene.mutate",
    );
    expect(full).toMatchObject({ elements: [element(1)] });

    fixture.transport.server({
      reason: "stale-preview",
      revision: "1",
      type: "room.resyncRequired",
    });
    await waitFor(() =>
      expect(
        fixture.editor.getElements().some(({ id }) => id === "remote-preview"),
      ).toBe(false),
    );
  });

  it("persists in-memory dirty edits before reconnect room state can replace them", async () => {
    const fixture = setup();
    await waitFor(() => expect(fixture.controller.state.status).toBe("ready"));
    fixture.controller.onChange([element(2)]);
    fixture.transport.serverDisconnect();
    await waitFor(() =>
      expect(fixture.controller.state.status).toBe("reconnecting"),
    );
    await waitFor(() => expect(fixture.outbox.records.size).toBe(1));

    fixture.transport.server(ready("2", "editor", [element(1)]));
    await waitFor(() => expect(fixture.controller.state.status).toBe("ready"));
    expect(fixture.editor.getElements()[0]?.version).toBe(2);
  });

  it("persists edits made while reconnecting without emitting them", async () => {
    const fixture = setup();
    await waitFor(() => expect(fixture.controller.state.status).toBe("ready"));
    fixture.transport.emitted.length = 0;
    fixture.transport.serverDisconnect();
    await waitFor(() =>
      expect(fixture.controller.state.status).toBe("reconnecting"),
    );

    fixture.controller.onChange([element(2)]);
    await vi.advanceTimersByTimeAsync(1_000);

    expect([...fixture.outbox.records.values()][0]?.elements).toEqual([
      element(2),
    ]);
    expect(
      fixture.transport.emitted.some((event) => event.type === "scene.mutate"),
    ).toBe(false);
  });

  it("keeps dirty elements when the durable outbox write fails", async () => {
    const fixture = setup();
    await waitFor(() => expect(fixture.controller.state.status).toBe("ready"));
    fixture.outbox.failNextPut = true;
    fixture.controller.onChange([element(2)]);
    await expect(fixture.controller.flush()).rejects.toThrow(
      "IndexedDB unavailable",
    );
    expect(fixture.outbox.records.size).toBe(0);

    await fixture.controller.flush();
    expect([...fixture.outbox.records.values()][0]?.elements).toEqual([
      element(2),
    ]);
  });

  it("keeps collaboration writable after event-local protocol warnings", async () => {
    const fixture = setup();
    await waitFor(() => expect(fixture.controller.state.status).toBe("ready"));
    fixture.transport.emitted.length = 0;
    fixture.transport.server({
      code: "PREVIEW_RATE_LIMITED",
      message: "Slow down previews",
      requestId: "request",
      retryable: true,
      type: "protocol.error",
    });
    await waitFor(() =>
      expect(fixture.controller.state.error?.code).toBe("PREVIEW_RATE_LIMITED"),
    );
    expect(fixture.controller.state.status).toBe("ready");

    fixture.controller.onChange([element(2)]);
    expect(fixture.transport.emitted.at(-1)?.type).toBe("scene.preview");
  });

  it("publishes periodic presence heartbeats for idle viewers", async () => {
    const fixture = setup({ presenceHeartbeatMs: 1_000, role: "viewer" });
    await waitFor(() => expect(fixture.controller.state.status).toBe("ready"));
    fixture.transport.emitted.length = 0;
    await vi.advanceTimersByTimeAsync(1_000);

    expect(fixture.transport.emitted).toEqual([
      { idleState: "active", type: "presence.update" },
    ]);
  });

  it("never emits presence when presence is disabled", async () => {
    const fixture = setup({
      presenceEnabled: false,
      presenceHeartbeatMs: 1_000,
      role: "viewer",
    });
    await waitFor(() => expect(fixture.controller.state.status).toBe("ready"));
    fixture.controller.publishPresence({
      pointer: { x: 1, y: 2, tool: "pointer" },
      idleState: "active",
    });
    await vi.advanceTimersByTimeAsync(3_000);

    expect(
      fixture.transport.emitted.filter(
        ({ type }) => type === "presence.update",
      ),
    ).toEqual([]);
  });

  it("persists dirty edits before an intentional stop", async () => {
    const fixture = setup();
    await waitFor(() => expect(fixture.controller.state.status).toBe("ready"));
    fixture.controller.onChange([element(2)]);

    await fixture.controller.stop();

    expect(fixture.controller.state.status).toBe("disconnected");
    expect([...fixture.outbox.records.values()][0]?.elements).toEqual([
      element(2),
    ]);
  });

  it("preserves cursor presence when a roster refreshes identities", async () => {
    const fixture = setup();
    await waitFor(() => expect(fixture.controller.state.status).toBe("ready"));
    fixture.transport.presence({
      connectionId: "remote",
      presence: {
        pointer: { x: 10, y: 20, tool: "pointer" },
        type: "presence.update",
      },
    });
    fixture.transport.roster([
      {
        connectionId: "remote",
        image: null,
        name: "Remote editor",
        role: "editor",
        userId: "30000000-0000-4000-8000-000000000001",
      },
    ]);

    const collaborator = [
      ...fixture.controller.state.collaborators.values(),
    ][0];
    expect(collaborator).toMatchObject({
      pointer: { x: 10, y: 20 },
      username: "Remote editor",
    });
  });
});
