import type {
  DrawingSummary,
  SessionResponse,
} from "@open-excalidraw/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";

import { ApiError } from "../../shared/api";
import { AuthProvider, type AuthClient } from "../auth";
import { VersionConflictError, type CloudRecoveryRecord } from "../persistence";
import type { DashboardApi } from "./dashboard-api";
import { DASHBOARD_QUERY_KEY } from "./dashboard-api";
import {
  PendingCreateDb,
  deletePendingCreateDatabase,
} from "./pending-create-db";
import {
  usePendingCreateSync,
  type PendingCreateSyncOptions,
} from "./use-pending-create-sync";

const USER_ID = "be21c1cd-a5d5-49f9-b9dd-a30e3cb80e09";
const DRAWING_ID = "00000000-0000-4000-8000-000000000001";

const session: SessionResponse = {
  capabilities: {
    emailPassword: true,
    github: false,
    google: false,
    oidc: false,
    oidcProviderName: "SSO",
    signupsDisabled: false,
    smtp: false,
  },
  user: {
    createdAt: "2026-07-10T10:00:00.000Z",
    email: "ada@example.com",
    emailVerified: true,
    id: USER_ID,
    image: null,
    isAdmin: false,
    name: "Ada",
    twoFactorEnabled: false,
  },
};

// Only getSession matters here; the rest satisfy the interface.
const authClient = (): AuthClient => ({
  changePassword: vi.fn(),
  getSession: vi.fn(() => Promise.resolve(session)),
  linkSocial: vi.fn(),
  listAccounts: vi.fn(() => Promise.resolve([])),
  requestPasswordReset: vi.fn(),
  resendVerification: vi.fn(),
  resetPassword: vi.fn(),
  setPassword: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  signUp: vi.fn(),
  startOAuth: vi.fn(),
  unlinkAccount: vi.fn(),
});

// Only createDrawing matters here; the rest satisfy the interface.
const stubApi = (
  createDrawing: DashboardApi["createDrawing"],
): DashboardApi => ({
  createDrawing,
  deleteDrawing: vi.fn(),
  duplicateDrawing: vi.fn(),
  listDrawings: vi.fn(),
  listTrash: vi.fn(),
  purgeDrawing: vi.fn(),
  renameDrawing: vi.fn(),
  restoreDrawing: vi.fn(),
  setTags: vi.fn(),
  setTemplate: vi.fn(),
});

const stores = new Set<PendingCreateDb>();
const dbNames = new Set<string>();

const seededStore = async () => {
  const name = `pending-sync-${crypto.randomUUID()}`;
  dbNames.add(name);
  const store = new PendingCreateDb(name);
  stores.add(store);
  await store.put(USER_ID, DRAWING_ID, "Offline board");
  return store;
};

const createdSummary = (): DrawingSummary => ({
  contentRevision: "0",
  createdAt: "2026-07-19T00:00:00.000Z",
  id: DRAWING_ID,
  isTemplate: false,
  metadataRevision: "0",
  ownerName: "Ada",
  ownerUserId: USER_ID,
  role: "owner",
  tags: [],
  thumbnailUpdatedAt: null,
  title: "Offline board",
  updatedAt: "2026-07-19T00:00:00.000Z",
});

// A recovery snapshot referencing one asset, so the push exercises both the
// asset upload and the content save.
const snapshot = (): CloudRecoveryRecord =>
  ({
    assetIds: ["file-1"],
    drawingId: DRAWING_ID,
    files: {
      "file-1": { dataURL: "data:image/png;base64,AAAA", id: "file-1" },
    },
    revision: "3",
    scene: {
      appState: {},
      elements: [],
      source: "https://open-excalidraw.local",
      type: "excalidraw",
      version: 2,
    },
    updatedAt: "2026-07-19T00:00:00.000Z",
    userId: USER_ID,
  }) as unknown as CloudRecoveryRecord;

const stubPush = (
  overrides: Partial<PendingCreateSyncOptions> = {},
): Required<
  Pick<PendingCreateSyncOptions, "assets" | "content" | "recovery">
> => ({
  assets: { uploadReferenced: vi.fn(() => Promise.resolve([])) },
  content: {
    save: vi.fn(() => Promise.resolve({ revision: "4", savedAt: "" })),
  },
  recovery: { get: vi.fn(() => Promise.resolve(undefined)) },
  ...overrides,
});

const renderSync = (
  store: PendingCreateDb,
  api: DashboardApi,
  overrides: Partial<PendingCreateSyncOptions> = {},
) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(DASHBOARD_QUERY_KEY, {
    nextCursor: null,
    owned: [],
    shared: [],
  });
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={queryClient}>
      <AuthProvider client={authClient()}>{children}</AuthProvider>
    </QueryClientProvider>
  );
  renderHook(() => usePendingCreateSync({ api, store, ...overrides }), {
    wrapper,
  });
  return queryClient;
};

afterEach(async () => {
  await Promise.all([...stores].map((store) => store.close()));
  await Promise.all(
    [...dbNames].map((name) => deletePendingCreateDatabase(name)),
  );
  stores.clear();
  dbNames.clear();
});

describe("usePendingCreateSync", () => {
  it("replays the create, pushes assets and content, clears the marker, and invalidates the list", async () => {
    const store = await seededStore();
    const createDrawing = vi.fn(() => Promise.resolve(createdSummary()));
    const push = stubPush({
      recovery: { get: vi.fn(() => Promise.resolve(snapshot())) },
    });
    const queryClient = renderSync(store, stubApi(createDrawing), push);

    // The client is called (title, id); the id makes it idempotent.
    await waitFor(() =>
      expect(createDrawing).toHaveBeenCalledWith("Offline board", DRAWING_ID),
    );
    // Referenced assets upload, then the scene saves against the create's
    // revision.
    await waitFor(() =>
      expect(push.assets.uploadReferenced).toHaveBeenCalledWith(
        DRAWING_ID,
        expect.objectContaining({ "file-1": expect.anything() }),
        ["file-1"],
      ),
    );
    await waitFor(() =>
      expect(push.content.save).toHaveBeenCalledWith(
        DRAWING_ID,
        // The exact recovered scene must reach the server, not a rebuilt one.
        expect.objectContaining({
          assetIds: ["file-1"],
          scene: snapshot().scene,
        }),
        "0",
        expect.any(String),
      ),
    );
    await waitFor(async () =>
      expect(await store.get(USER_ID, DRAWING_ID)).toBeUndefined(),
    );
    await waitFor(() =>
      expect(
        queryClient.getQueryState(DASHBOARD_QUERY_KEY)?.isInvalidated,
      ).toBe(true),
    );
  });

  it("clears the marker without error when the content save conflicts", async () => {
    const store = await seededStore();
    const createDrawing = vi.fn(() => Promise.resolve(createdSummary()));
    const push = stubPush({
      content: {
        save: vi.fn(() =>
          Promise.reject(new VersionConflictError(null, "0", null)),
        ),
      },
      recovery: { get: vi.fn(() => Promise.resolve(snapshot())) },
    });
    const queryClient = renderSync(store, stubApi(createDrawing), push);

    // The conflict replay must actually reach the save before the cleanup
    // assertions mean anything.
    await waitFor(() => expect(push.content.save).toHaveBeenCalledTimes(1));
    // A stale local snapshot must not clobber the newer server scene, so the
    // marker still clears and the list refreshes.
    await waitFor(async () =>
      expect(await store.get(USER_ID, DRAWING_ID)).toBeUndefined(),
    );
    await waitFor(() =>
      expect(
        queryClient.getQueryState(DASHBOARD_QUERY_KEY)?.isInvalidated,
      ).toBe(true),
    );
  });

  it("keeps the marker when the content push fails on the network", async () => {
    const store = await seededStore();
    const createDrawing = vi.fn(() => Promise.resolve(createdSummary()));
    let rejectSave!: (error: Error) => void;
    const push = stubPush({
      content: {
        save: vi.fn(
          () =>
            new Promise<never>((_, reject) => {
              rejectSave = reject;
            }),
        ),
      },
      recovery: { get: vi.fn(() => Promise.resolve(snapshot())) },
    });
    const queryClient = renderSync(store, stubApi(createDrawing), push);

    await waitFor(() => expect(push.content.save).toHaveBeenCalledTimes(1));
    rejectSave(new Error("offline"));
    // Let the rejection handler finish before asserting what it left behind.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The create replay is idempotent, so leaving the marker lets the next
    // transition retry create + push end-to-end.
    expect(await store.get(USER_ID, DRAWING_ID)).toMatchObject({
      title: "Offline board",
    });
    expect(queryClient.getQueryState(DASHBOARD_QUERY_KEY)?.isInvalidated).toBe(
      false,
    );
  });

  it("clears the marker after create when no snapshot exists", async () => {
    const store = await seededStore();
    const createDrawing = vi.fn(() => Promise.resolve(createdSummary()));
    const push = stubPush(); // recovery.get resolves undefined
    const queryClient = renderSync(store, stubApi(createDrawing), push);

    await waitFor(async () =>
      expect(await store.get(USER_ID, DRAWING_ID)).toBeUndefined(),
    );
    // Nothing to push: the content clients stay untouched.
    expect(push.assets.uploadReferenced).not.toHaveBeenCalled();
    expect(push.content.save).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(
        queryClient.getQueryState(DASHBOARD_QUERY_KEY)?.isInvalidated,
      ).toBe(true),
    );
  });

  it("leaves the marker in place on a 409 conflict", async () => {
    const store = await seededStore();
    const createDrawing = vi.fn(() =>
      Promise.reject(
        new ApiError(409, {
          code: "DRAWING_ID_CONFLICT",
          detail: "This drawing id already belongs to another user",
          requestId: "request-1",
          status: 409,
          title: "Conflict",
        }),
      ),
    );
    const queryClient = renderSync(store, stubApi(createDrawing));

    await waitFor(() => expect(createDrawing).toHaveBeenCalledTimes(1));
    // Local data is untouched: the marker survives the failed sync.
    expect(await store.get(USER_ID, DRAWING_ID)).toMatchObject({
      title: "Offline board",
    });
    expect(queryClient.getQueryState(DASHBOARD_QUERY_KEY)?.isInvalidated).toBe(
      false,
    );
  });
});
