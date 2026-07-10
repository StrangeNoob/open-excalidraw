import { fireEvent, render, screen } from "@testing-library/react";

import { ConflictRecoveryBanner } from "./ConflictRecoveryBanner";

describe("ConflictRecoveryBanner", () => {
  it("offers explicit server and local recovery choices", () => {
    const onReloadServer = vi.fn();
    const onRetryLocal = vi.fn();
    const onCreatePrivateCopy = vi.fn();
    const onExportLocal = vi.fn();
    const server = {
      content: {
        assetIds: [],
        revision: "4",
        savedAt: "2026-07-11T00:00:00.000Z",
        scene: {
          appState: {},
          elements: [],
          source: "test",
          type: "excalidraw" as const,
          version: 2,
        },
      },
      revision: "4",
    };
    render(
      <ConflictRecoveryBanner
        onCreatePrivateCopy={onCreatePrivateCopy}
        onExportLocal={onExportLocal}
        onReloadServer={onReloadServer}
        onRetryLoad={vi.fn()}
        onRetryLocal={onRetryLocal}
        server={server}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Reload server version" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry my version" }));
    expect(onReloadServer).toHaveBeenCalledWith(server);
    expect(onRetryLocal).toHaveBeenCalledWith("4");
    fireEvent.click(
      screen.getByRole("button", { name: "Save as a new private drawing" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Export local drawing" }),
    );
    expect(onCreatePrivateCopy).toHaveBeenCalledOnce();
    expect(onExportLocal).toHaveBeenCalledOnce();
  });

  it("can retry loading when the conflict snapshot was unavailable", () => {
    const onRetryLoad = vi.fn();
    render(
      <ConflictRecoveryBanner
        onCreatePrivateCopy={vi.fn()}
        onExportLocal={vi.fn()}
        onReloadServer={vi.fn()}
        onRetryLoad={onRetryLoad}
        onRetryLocal={vi.fn()}
        server={null}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Try loading the server version again",
      }),
    );
    expect(onRetryLoad).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("button", { name: "Export local drawing" }),
    ).toBeEnabled();
  });
});
