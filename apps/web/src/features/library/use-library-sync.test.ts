import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { act, renderHook } from "@testing-library/react";

import { LibraryRequestError } from "./library-client";
import { useLibrarySync } from "./use-library-sync";

const item = (id: string) => ({
  created: 1,
  elements: [],
  id,
  status: "unpublished" as const,
});

const response = (items: ReturnType<typeof item>[] = []) => ({
  items,
  updatedAt: "2026-07-11T00:00:00.000Z",
});

const createApi = () => {
  // Mirrors the real API: updateLibrary resolves with the resulting items.
  const updateLibrary = vi.fn(
    ({ libraryItems }: { libraryItems: ReturnType<typeof item>[] }) =>
      Promise.resolve(libraryItems),
  );
  return {
    api: { updateLibrary } as unknown as ExcalidrawImperativeAPI,
    updateLibrary,
  };
};

// Flushes the load/save promise chains without advancing the debounce clock.
const settle = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

describe("useLibrarySync", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("applies the loaded library to the editor once the API is available", async () => {
    const { api, updateLibrary } = createApi();
    const client = {
      load: vi.fn(() => Promise.resolve(response([item("a")]))),
      save: vi.fn(() => Promise.resolve(response())),
    };

    renderHook(() => useLibrarySync(api, { client }));
    await settle();

    expect(client.load).toHaveBeenCalledTimes(1);
    expect(updateLibrary).toHaveBeenCalledWith({
      libraryItems: [item("a")],
      merge: false,
    });
  });

  it("merges rather than replaces when the server library is empty", async () => {
    const { api, updateLibrary } = createApi();
    const client = {
      load: vi.fn(() => Promise.resolve(response())),
      save: vi.fn(() => Promise.resolve(response())),
    };

    renderHook(() => useLibrarySync(api, { client }));
    await settle();

    expect(updateLibrary).toHaveBeenCalledWith({
      libraryItems: [],
      merge: true,
    });
  });

  it("ignores library changes until the initial load has been applied", async () => {
    let resolveLoad!: (value: ReturnType<typeof response>) => void;
    const client = {
      load: vi.fn(
        () =>
          new Promise<ReturnType<typeof response>>((resolve) => {
            resolveLoad = resolve;
          }),
      ),
      save: vi.fn(() => Promise.resolve(response())),
    };
    const { api } = createApi();

    const { result } = renderHook(() => useLibrarySync(api, { client }));

    act(() => {
      void result.current([item("early")]);
    });
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(client.save).not.toHaveBeenCalled();

    await act(async () => {
      resolveLoad(response());
      await Promise.resolve();
    });
    expect(client.save).not.toHaveBeenCalled();
  });

  it("does not save when the change matches the last synced snapshot", async () => {
    const client = {
      load: vi.fn(() => Promise.resolve(response([item("a")]))),
      save: vi.fn(() => Promise.resolve(response())),
    };
    const { api } = createApi();

    const { result } = renderHook(() => useLibrarySync(api, { client }));
    await settle();

    act(() => {
      void result.current([item("a")]);
    });
    act(() => {
      vi.advanceTimersByTime(2_000);
    });

    expect(client.save).not.toHaveBeenCalled();
  });

  it("saves once after the debounce, collapsing rapid changes", async () => {
    const client = {
      load: vi.fn(() => Promise.resolve(response())),
      save: vi.fn(() => Promise.resolve(response([item("a")]))),
    };
    const { api } = createApi();

    const { result } = renderHook(() => useLibrarySync(api, { client }));
    await settle();

    act(() => {
      void result.current([item("a")]);
    });
    act(() => {
      void result.current([item("a"), item("b")]);
    });
    expect(client.save).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(client.save).toHaveBeenCalledTimes(1);
    expect(client.save).toHaveBeenCalledWith([item("a"), item("b")]);
  });

  it("retries a transient failure automatically after a backoff delay", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const client = {
      load: vi.fn(() => Promise.resolve(response())),
      save: vi
        .fn()
        .mockRejectedValueOnce(new Error("network down"))
        .mockResolvedValueOnce(response([item("a")])),
    };
    const { api } = createApi();

    const { result } = renderHook(() => useLibrarySync(api, { client }));
    await settle();

    act(() => {
      void result.current([item("a")]);
    });
    await act(async () => {
      vi.advanceTimersByTime(2_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(client.save).toHaveBeenCalledTimes(1);

    // No further onLibraryChange: the backoff timer resends the same snapshot.
    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(client.save).toHaveBeenCalledTimes(2);
    expect(client.save).toHaveBeenLastCalledWith([item("a")]);

    warn.mockRestore();
  });

  it("retries a transient 429 failure after a backoff delay", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const client = {
      load: vi.fn(() => Promise.resolve(response())),
      save: vi
        .fn()
        .mockRejectedValueOnce(new LibraryRequestError(429, null))
        .mockResolvedValueOnce(response([item("a")])),
    };
    const { api } = createApi();

    const { result } = renderHook(() => useLibrarySync(api, { client }));
    await settle();

    act(() => {
      void result.current([item("a")]);
    });
    await act(async () => {
      vi.advanceTimersByTime(2_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(client.save).toHaveBeenCalledTimes(1);

    // No further onLibraryChange: the backoff timer resends the same snapshot.
    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(client.save).toHaveBeenCalledTimes(2);
    expect(client.save).toHaveBeenLastCalledWith([item("a")]);

    warn.mockRestore();
  });

  it("does not retry a permanent 4xx failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const client = {
      load: vi.fn(() => Promise.resolve(response())),
      save: vi.fn(() => Promise.reject(new LibraryRequestError(400, null))),
    };
    const { api } = createApi();

    const { result } = renderHook(() => useLibrarySync(api, { client }));
    await settle();

    act(() => {
      void result.current([item("a")]);
    });
    await act(async () => {
      vi.advanceTimersByTime(2_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(client.save).toHaveBeenCalledTimes(1);

    // Well past any backoff window: a permanent error is never retried.
    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
    });
    expect(client.save).toHaveBeenCalledTimes(1);

    warn.mockRestore();
  });

  it("lets a newer change supersede a queued retry", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const client = {
      load: vi.fn(() => Promise.resolve(response())),
      save: vi
        .fn()
        .mockRejectedValueOnce(new Error("network down"))
        .mockResolvedValue(response()),
    };
    const { api } = createApi();

    const { result } = renderHook(() => useLibrarySync(api, { client }));
    await settle();

    act(() => {
      void result.current([item("a")]);
    });
    await act(async () => {
      vi.advanceTimersByTime(2_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(client.save).toHaveBeenCalledTimes(1);
    expect(client.save).toHaveBeenLastCalledWith([item("a")]);

    // A newer change replaces the [a] retry that was queued after the failure.
    act(() => {
      void result.current([item("a"), item("b")]);
    });
    await act(async () => {
      vi.advanceTimersByTime(2_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(client.save).toHaveBeenCalledTimes(2);
    expect(client.save).toHaveBeenLastCalledWith([item("a"), item("b")]);

    warn.mockRestore();
  });

  it("flushes a pending debounced change on unmount", async () => {
    const client = {
      load: vi.fn(() => Promise.resolve(response())),
      save: vi.fn(() => Promise.resolve(response())),
    };
    const { api } = createApi();

    const { result, unmount } = renderHook(() =>
      useLibrarySync(api, { client }),
    );
    await settle();

    // Still inside the debounce window when the editor session tears down.
    act(() => {
      void result.current([item("a")]);
    });
    expect(client.save).not.toHaveBeenCalled();

    await act(async () => {
      unmount();
      await Promise.resolve();
    });
    expect(client.save).toHaveBeenCalledTimes(1);
    expect(client.save).toHaveBeenCalledWith([item("a")]);
  });

  it("does not open a second PUT when the effect re-runs mid-save", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let resolveFirst!: () => void;
    const track = () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
    };
    const save = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<ReturnType<typeof response>>((resolve) => {
            track();
            resolveFirst = () => {
              inFlight -= 1;
              resolve(response());
            };
          }),
      )
      .mockImplementation(() => {
        track();
        return Promise.resolve(response());
      });
    const client = { load: vi.fn(() => Promise.resolve(response())), save };
    const { api: firstApi } = createApi();
    const { api: secondApi } = createApi();

    const { result, rerender } = renderHook(
      ({ api }) => useLibrarySync(api, { client }),
      { initialProps: { api: firstApi } },
    );
    await settle();

    // First save is left in flight.
    act(() => {
      void result.current([item("a")]);
    });
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(save).toHaveBeenCalledTimes(1);

    // Re-run the effect with a new API while that save is still in flight.
    await act(async () => {
      rerender({ api: secondApi });
      await Promise.resolve();
      await Promise.resolve();
    });
    // A change after the remount must still queue behind the in-flight PUT.
    act(() => {
      void result.current([item("a"), item("b")]);
    });
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(maxInFlight).toBe(1);

    // Releasing the first save lets the queued snapshot go, one at a time.
    await act(async () => {
      resolveFirst();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith([item("a"), item("b")]);
    expect(maxInFlight).toBe(1);
  });

  it("serializes saves so a slow request is not overtaken", async () => {
    let resolveFirst!: () => void;
    const save = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<ReturnType<typeof response>>((resolve) => {
            resolveFirst = () => resolve(response());
          }),
      )
      .mockImplementation(() => Promise.resolve(response()));
    const client = { load: vi.fn(() => Promise.resolve(response())), save };
    const { api } = createApi();

    const { result } = renderHook(() => useLibrarySync(api, { client }));
    await settle();

    // First change starts a save that stays in flight.
    act(() => {
      void result.current([item("a")]);
    });
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(save).toHaveBeenCalledTimes(1);

    // A second change while the first is in flight must not open a second PUT.
    act(() => {
      void result.current([item("a"), item("b")]);
    });
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(save).toHaveBeenCalledTimes(1);

    // Once the in-flight save settles, the latest snapshot is sent.
    await act(async () => {
      resolveFirst();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith([item("a"), item("b")]);
  });

  it("keeps saving disabled after a failed initial load", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const client = {
      load: vi.fn(() => Promise.reject(new Error("server down"))),
      save: vi.fn(() => Promise.resolve(response())),
    };
    const { api } = createApi();

    const { result } = renderHook(() => useLibrarySync(api, { client }));
    await settle();

    act(() => {
      void result.current([item("x")]);
    });
    act(() => {
      vi.advanceTimersByTime(5_000);
    });

    expect(client.save).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("keeps saving disabled when applying the loaded library fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { api, updateLibrary } = createApi();
    updateLibrary.mockImplementationOnce(() =>
      Promise.reject(new Error("apply failed")),
    );
    const client = {
      load: vi.fn(() => Promise.resolve(response([item("a")]))),
      save: vi.fn(() => Promise.resolve(response())),
    };

    const { result } = renderHook(() => useLibrarySync(api, { client }));
    await settle();

    act(() => {
      void result.current([item("x")]);
    });
    act(() => {
      vi.advanceTimersByTime(5_000);
    });

    expect(client.save).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("persists the merged library after an empty-server load without an edit", async () => {
    const { api, updateLibrary } = createApi();
    // Simulates Excalidraw merging a pre-existing local library into the
    // empty server copy.
    updateLibrary.mockImplementationOnce(() =>
      Promise.resolve([item("local")]),
    );
    const client = {
      load: vi.fn(() => Promise.resolve(response())),
      save: vi.fn(() => Promise.resolve(response())),
    };

    renderHook(() => useLibrarySync(api, { client }));
    await settle();
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    await settle();

    expect(client.save).toHaveBeenCalledTimes(1);
    expect(client.save).toHaveBeenCalledWith([item("local")]);
  });

  it("still saves a revert to the last synced snapshot while a save is in flight", async () => {
    let resolveFirst!: () => void;
    const save = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<ReturnType<typeof response>>((resolve) => {
            resolveFirst = () => resolve(response());
          }),
      )
      .mockImplementation(() => Promise.resolve(response()));
    const client = {
      load: vi.fn(() => Promise.resolve(response([item("a")]))),
      save,
    };
    const { api } = createApi();

    const { result } = renderHook(() => useLibrarySync(api, { client }));
    await settle();

    // Edit away from the synced snapshot; the save stays in flight.
    act(() => {
      void result.current([item("a"), item("b")]);
    });
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(save).toHaveBeenCalledTimes(1);

    // Revert to the synced snapshot while the newer save is in flight: it
    // must queue, or the server would keep the superseding snapshot.
    act(() => {
      void result.current([item("a")]);
    });
    await act(async () => {
      resolveFirst();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    await settle();

    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith([item("a")]);
  });

  it("does not apply a stale load over an outstanding write when the effect re-runs", async () => {
    let resolveSave!: () => void;
    const save = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<ReturnType<typeof response>>((resolve) => {
            resolveSave = () => resolve(response());
          }),
      )
      .mockImplementation(() => Promise.resolve(response()));
    const client = {
      load: vi
        .fn()
        .mockResolvedValueOnce(response([item("a")]))
        .mockResolvedValue(response([item("stale")])),
      save,
    };
    const { api: firstApi } = createApi();
    const { api: secondApi, updateLibrary: secondUpdate } = createApi();

    const { result, rerender } = renderHook(
      ({ api }) => useLibrarySync(api, { client }),
      { initialProps: { api: firstApi } },
    );
    await settle();

    // Edit away from the synced snapshot; the change is still in the debounce.
    act(() => {
      void result.current([item("a"), item("b")]);
    });

    // Re-run the effect with a new API: cleanup flushes the pending [a, b],
    // starting a save that stays in flight, then generation 2 loads OLD items.
    await act(async () => {
      rerender({ api: secondApi });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith([item("a"), item("b")]);
    // The stale GET must not overwrite the newer local state mid-flight.
    expect(secondUpdate).not.toHaveBeenCalled();

    // Once the in-flight save settles, everything is consistent.
    await act(async () => {
      resolveSave();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(save).toHaveBeenCalledTimes(1);
  });
});
