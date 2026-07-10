import type { LoadedContent } from "./content-client";

export interface ConflictRecoveryBannerProps {
  server: LoadedContent | null;
  onCreatePrivateCopy: () => void;
  onExportLocal: () => void;
  onReloadServer: (server: LoadedContent) => void;
  onRetryLoad: () => void | Promise<void>;
  onRetryLocal: (serverRevision: string) => void;
}

export const ConflictRecoveryBanner = ({
  server,
  onCreatePrivateCopy,
  onExportLocal,
  onReloadServer,
  onRetryLoad,
  onRetryLocal,
}: ConflictRecoveryBannerProps) => (
  <section aria-label="Save conflict" role="alert">
    <strong>This drawing changed somewhere else.</strong>
    <p>Your local recovery copy is still stored on this device.</p>
    <button
      disabled={!server}
      onClick={() => server && onReloadServer(server)}
      type="button"
    >
      Reload server version
    </button>
    <button
      disabled={!server}
      onClick={() => server && onRetryLocal(server.revision)}
      type="button"
    >
      Retry my version
    </button>
    {!server ? (
      <button onClick={() => void onRetryLoad()} type="button">
        Try loading the server version again
      </button>
    ) : null}
    <button onClick={onCreatePrivateCopy} type="button">
      Save as a new private drawing
    </button>
    <button onClick={onExportLocal} type="button">
      Export local drawing
    </button>
  </section>
);
