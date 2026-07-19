import type {
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";
import type { SharedDrawingResponse } from "@open-excalidraw/contracts";
import { type ComponentType, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { ViewerBanner } from "../access";
import {
  collectAssetReferences,
  hydrateAssets,
  ShareAssetClient,
  type AssetClient,
} from "../assets";
import {
  CollaborationController,
  SocketIoTransport,
  type CollaborationState,
} from "../collaboration";
import { ExcalidrawHost, type ExcalidrawHostProps } from "../editor";
import { ApiError } from "../../shared/api";

import { ShareClient } from "./api";

import "./sharing.css";

const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const EMPTY_COLLABORATION_STATE: CollaborationState = {
  collaborators: new Map(),
  error: null,
  overriddenElements: null,
  revision: "0",
  role: "viewer",
  status: "idle",
};

// The share socket is receive-only, so nothing is ever written to an outbox.
const NOOP_OUTBOX = {
  list: () => Promise.resolve([]),
  put: () => Promise.resolve(),
  remove: () => Promise.resolve(),
};

const REVOKED_SOCKET_CODES = new Set([
  "SOCKET_MEMBERSHIP_REVOKED",
  "SOCKET_NOT_MEMBER",
  "SOCKET_UNAUTHENTICATED",
]);

export interface SharedDrawingDependencies {
  assets?: (token: string) => Pick<AssetClient, "download">;
  createRealtimeTransport?: (token: string) => SocketIoTransport;
  host?: ComponentType<ExcalidrawHostProps>;
  hydrate?: typeof hydrateAssets;
  share?: Pick<ShareClient, "inspect">;
}

export interface SharedDrawingPageProps {
  dependencies?: SharedDrawingDependencies;
}

type LoadStatus = "loading" | "ready" | "not-found" | "error";

/**
 * Route entry for /s/:token. Remounts the page per token so no load, socket,
 * or error state can survive navigation between share URLs.
 */
export const SharedDrawingRoute = (props: SharedDrawingPageProps) => {
  const { token = "" } = useParams();
  return <SharedDrawingPage key={token} {...props} />;
};

export const SharedDrawingPage = ({
  dependencies,
}: SharedDrawingPageProps = {}) => {
  const { token = "" } = useParams();
  const tokenValid = SHARE_TOKEN_PATTERN.test(token);

  const resolved = useMemo(
    () => ({
      assets:
        dependencies?.assets ??
        ((shareToken: string) => new ShareAssetClient(shareToken)),
      createRealtimeTransport:
        dependencies?.createRealtimeTransport ??
        ((shareToken: string) =>
          new SocketIoTransport({ auth: { shareToken } })),
      host: dependencies?.host ?? ExcalidrawHost,
      hydrate: dependencies?.hydrate ?? hydrateAssets,
      share: dependencies?.share ?? new ShareClient(),
    }),
    [dependencies],
  );

  const [status, setStatus] = useState<LoadStatus>(
    tokenValid ? "loading" : "not-found",
  );
  const [loaded, setLoaded] = useState<{
    token: string;
    drawing: SharedDrawingResponse;
  } | null>(null);
  const [editorApi, setEditorApi] = useState<ExcalidrawImperativeAPI | null>(
    null,
  );
  const [collaboration, setCollaboration] = useState<CollaborationState>(
    EMPTY_COLLABORATION_STATE,
  );
  // Latched, not derived from live collaboration state: rendering the notice
  // unmounts the editor, whose cleanup resets the collaboration state — a
  // derived flag would clear itself and flip the page back to the canvas.
  const [linkRevoked, setLinkRevoked] = useState(false);
  // Belt to SharedDrawingRoute's remount-per-token suspenders: a drawing is
  // only ever rendered against the token it was loaded for.
  const shared =
    loaded !== null && loaded.token === token ? loaded.drawing : null;

  useEffect(() => {
    if (!tokenValid) return;
    let active = true;
    resolved.share
      .inspect(token)
      .then((drawing) => {
        if (!active) return;
        setLoaded({ token, drawing });
        setStatus("ready");
      })
      .catch((caught: unknown) => {
        if (!active) return;
        setStatus(
          caught instanceof ApiError && caught.status === 404
            ? "not-found"
            : "error",
        );
      });
    return () => {
      active = false;
    };
  }, [resolved.share, token, tokenValid]);

  useEffect(() => {
    if (!editorApi || !shared) return;

    const realtime = new CollaborationController({
      drawingId: shared.drawingId,
      editor: editorApi,
      initialAppState: shared.scene.appState,
      initialElements: shared.scene.elements,
      initialRole: "viewer",
      outbox: NOOP_OUTBOX,
      presenceEnabled: false,
      transport: resolved.createRealtimeTransport(token),
      userId: "share-viewer",
    });
    const unsubscribe = realtime.subscribe((state) => {
      setCollaboration(state);
      if (state.error !== null && REVOKED_SOCKET_CODES.has(state.error.code)) {
        setLinkRevoked(true);
      }
    });
    realtime.start();
    return () => {
      unsubscribe();
      setCollaboration(EMPTY_COLLABORATION_STATE);
      void realtime.stop().catch(() => undefined);
    };
  }, [editorApi, resolved, shared, token]);

  const revision = collaboration.revision;
  useEffect(() => {
    if (!editorApi || !shared) return;
    const assetIds = collectAssetReferences(
      editorApi.getSceneElementsIncludingDeleted(),
    );
    if (assetIds.length === 0) return;
    const abort = new AbortController();
    void resolved
      .hydrate(
        editorApi,
        resolved.assets(token),
        shared.drawingId,
        assetIds,
        abort.signal,
      )
      .catch(() => undefined);
    return () => abort.abort();
  }, [editorApi, resolved, revision, shared, token]);

  if (!tokenValid || status === "not-found" || linkRevoked) {
    return (
      <main className="shared-drawing-notice">
        <h1>This link isn&apos;t available</h1>
        <p>
          The share link may have been revoked or never existed. Ask the
          drawing&apos;s owner for a new link.
        </p>
        <Link to="/">Go to Open Excalidraw</Link>
      </main>
    );
  }
  if (status === "error") {
    return (
      <main className="shared-drawing-notice">
        <h1>Could not open this drawing</h1>
        <p>Something went wrong while loading the shared drawing.</p>
        <Link to="/">Go to Open Excalidraw</Link>
      </main>
    );
  }
  if (status === "loading" || !shared) {
    return <p aria-live="polite">Opening shared drawing…</p>;
  }

  const Host = resolved.host;
  const initialData: ExcalidrawInitialDataState = {
    appState: shared.scene.appState,
    elements: shared.scene
      .elements as unknown as ExcalidrawInitialDataState["elements"],
    scrollToContent: true,
  };
  return (
    <div className="shared-drawing-page">
      <ViewerBanner />
      <Host
        initialData={initialData}
        isCollaborating={collaboration.status === "ready"}
        onApiChange={setEditorApi}
        readOnly
        title={shared.title}
      />
    </div>
  );
};
