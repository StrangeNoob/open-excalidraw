import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { act, renderHook } from "@testing-library/react";

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
  const updateLibrary = vi.fn(() => Promise.resolve([]));
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

  it("retries on the next change after a failed save", async () => {
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
    });
    expect(client.save).toHaveBeenCalledTimes(1);

    // The failed save left the snapshot unsynced, so the same content saves again.
    act(() => {
      void result.current([item("a")]);
    });
    await act(async () => {
      vi.advanceTimersByTime(2_000);
      await Promise.resolve();
    });
    expect(client.save).toHaveBeenCalledTimes(2);

    warn.mockRestore();
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
});
