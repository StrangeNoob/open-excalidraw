import type { SaveContentRequest } from "@open-excalidraw/contracts";

import {
  AutosaveController,
  isRetryableAutosaveError,
} from "./autosave-controller";
import { ContentRequestError, VersionConflictError } from "./content-client";

const snapshot = (version: number) => ({
  request: {
    assetIds: [],
    scene: {
      appState: {},
      elements: [
        {
          id: "element",
          isDeleted: false,
          type: "rectangle",
          version,
          versionNonce: version,
        },
      ],
      source: "test",
      type: "excalidraw" as const,
      version: 2,
    },
  } satisfies SaveContentRequest,
});

describe("AutosaveController", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("coalesces rapid edits with a one-second debounce", async () => {
    const persist = vi.fn().mockResolvedValue({ revision: "1" });
    const controller = new AutosaveController({
      createIdempotencyKey: () => "save-key",
      initialRevision: "0",
      persist,
    });

    controller.schedule(snapshot(1));
    await vi.advanceTimersByTimeAsync(900);
    controller.schedule(snapshot(2));
    await vi.advanceTimersByTimeAsync(999);
    expect(persist).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(persist).toHaveBeenCalledOnce();
    expect(persist.mock.calls[0]?.[0]).toEqual(snapshot(2));
    expect(controller.state.revision).toBe("1");
  });

  it("keeps changes made during an in-flight save dirty", async () => {
    let resolveFirst!: (value: { revision: string }) => void;
    const persist = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<{ revision: string }>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({ revision: "2" });
    const controller = new AutosaveController({
      debounceMs: 10,
      initialRevision: "0",
      persist,
    });

    controller.schedule(snapshot(1));
    await vi.advanceTimersByTimeAsync(10);
    expect(controller.state.status).toBe("saving");
    controller.schedule(snapshot(2));
    expect(controller.state.status).toBe("dirty");
    resolveFirst({ revision: "1" });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10);

    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist.mock.calls[1]?.[0]).toEqual(snapshot(2));
    expect(persist.mock.calls[1]?.[1]).toBe("1");
  });

  it("flushes at the five-second maximum during continuous edits", async () => {
    const persist = vi.fn().mockResolvedValue({ revision: "1" });
    const controller = new AutosaveController({
      initialRevision: "0",
      persist,
    });

    for (let version = 1; version <= 6; version += 1) {
      controller.schedule(snapshot(version));
      if (version < 6) {
        await vi.advanceTimersByTimeAsync(999);
      }
    }
    await vi.advanceTimersByTimeAsync(5);

    expect(persist).toHaveBeenCalledOnce();
    expect(persist.mock.calls[0]?.[0]).toEqual(snapshot(6));
  });

  it("retries a lost response with the same idempotency key", async () => {
    const persist = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network failed"))
      .mockResolvedValueOnce({ revision: "1" });
    const createIdempotencyKey = vi
      .fn()
      .mockReturnValueOnce("stable-key")
      .mockReturnValueOnce("different-key");
    const controller = new AutosaveController({
      createIdempotencyKey,
      debounceMs: 1,
      initialRevision: "0",
      persist,
      retryBaseMs: 10,
    });

    controller.schedule(snapshot(1));
    await vi.advanceTimersByTimeAsync(1);
    expect(controller.state.status).toBe("retrying");
    await vi.advanceTimersByTimeAsync(10);

    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenNthCalledWith(1, snapshot(1), "0", "stable-key");
    expect(persist).toHaveBeenNthCalledWith(2, snapshot(1), "0", "stable-key");
    expect(createIdempotencyKey).toHaveBeenCalledOnce();
    expect(controller.state.revision).toBe("1");
  });

  it("pauses terminal failures but allows a corrected edit to save", async () => {
    const persist = vi
      .fn()
      .mockRejectedValueOnce(new ContentRequestError(422, null))
      .mockResolvedValueOnce({ revision: "1" });
    const controller = new AutosaveController({
      debounceMs: 1,
      initialRevision: "0",
      persist,
      retryBaseMs: 1,
    });

    controller.schedule(snapshot(1));
    await vi.advanceTimersByTimeAsync(1);
    expect(controller.state.status).toBe("error");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(persist).toHaveBeenCalledOnce();

    controller.schedule(snapshot(1));
    await vi.advanceTimersByTimeAsync(1);
    expect(persist).toHaveBeenCalledOnce();

    controller.schedule(snapshot(2));
    await vi.advanceTimersByTimeAsync(1);
    expect(persist).toHaveBeenCalledTimes(2);
    expect(controller.state.status).toBe("saved");
  });

  it("retries only transient HTTP failure classes", () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      expect(
        isRetryableAutosaveError(new ContentRequestError(status, null)),
      ).toBe(true);
    }
    for (const status of [400, 401, 403, 404, 409, 412, 413, 422, 501]) {
      expect(
        isRetryableAutosaveError(new ContentRequestError(status, null)),
      ).toBe(false);
    }
  });

  it("can reload canonical content after a conflict follow-up load failed", async () => {
    const persist = vi
      .fn()
      .mockRejectedValueOnce(new VersionConflictError(null, "0", null));
    const controller = new AutosaveController({
      debounceMs: 1,
      initialRevision: "0",
      persist,
    });
    controller.schedule(snapshot(1));
    await vi.advanceTimersByTimeAsync(1);
    expect(controller.state.conflict?.server).toBeNull();

    const server = {
      content: {
        ...snapshot(2).request,
        revision: "2",
        savedAt: "2026-07-11T00:00:00.000Z",
      },
      revision: "2",
    };
    await controller.reloadConflictServer(() => Promise.resolve(server));

    expect(controller.state.conflict?.server).toEqual(server);
    expect(controller.state.status).toBe("conflict");
  });

  it("explicitly retries the exact terminal snapshot after authentication recovery", async () => {
    const terminalSnapshot = snapshot(3);
    const persist = vi
      .fn()
      .mockRejectedValueOnce(new ContentRequestError(401, null))
      .mockResolvedValueOnce({ revision: "1" });
    const controller = new AutosaveController({
      debounceMs: 1,
      initialRevision: "0",
      persist,
    });
    controller.schedule(terminalSnapshot);
    await vi.advanceTimersByTimeAsync(1);
    expect(controller.state.status).toBe("error");

    await controller.retryTerminal();

    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist.mock.calls[0]?.[0]).toBe(terminalSnapshot);
    expect(persist.mock.calls[1]?.[0]).toBe(terminalSnapshot);
    expect(controller.state.status).toBe("saved");
  });

  it("retries the same paused scene after a missing local file is recovered", async () => {
    const files: Record<string, unknown> = {};
    const terminalSnapshot = { ...snapshot(4), files };
    const persist = vi.fn((pending: { files?: unknown }) =>
      (pending.files as Record<string, unknown>).image
        ? Promise.resolve({ revision: "1" })
        : Promise.reject(
            new Error("Referenced asset image is unavailable locally"),
          ),
    );
    const controller = new AutosaveController({
      debounceMs: 1,
      initialRevision: "0",
      persist,
    });
    controller.schedule(terminalSnapshot);
    await vi.advanceTimersByTimeAsync(1);
    expect(controller.state.status).toBe("error");

    files.image = { id: "image" };
    await controller.retryTerminal();

    expect(persist).toHaveBeenCalledTimes(2);
    expect(persist.mock.calls[1]?.[0]).toBe(terminalSnapshot);
    expect(controller.state.status).toBe("saved");
  });
});
