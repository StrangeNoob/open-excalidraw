import type { ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import type { ExcalidrawChangeHandler } from "../../editor";
import type { GuestCanvasRepository } from "../hooks";
import { GuestCanvasPage } from "./GuestCanvasPage";

vi.mock("../../editor", () => ({
  accountIcon: null,
  // Excalidraw's Footer needs the editor's context, so the double renders the
  // status inline while keeping the same accessible role the real one exposes.
  CanvasStatusFooter: ({ label }: { label: string }) => (
    <span role="status">{label}</span>
  ),
  ExcalidrawHost: ({
    children,
    initialData,
    onChange,
    renderTopRightUI,
    title,
  }: {
    children?: React.ReactNode;
    initialData: ExcalidrawInitialDataState | null;
    onChange: ExcalidrawChangeHandler;
    renderTopRightUI?: (isMobile: boolean, appState: never) => React.ReactNode;
    title: string;
  }) => (
    <section
      aria-label={`${title} drawing canvas`}
      data-elements={initialData?.elements?.length ?? 0}
    >
      {renderTopRightUI?.(false, {} as never)}
      {children}
      <button
        onClick={() =>
          onChange(
            [],
            {
              gridModeEnabled: false,
              gridSize: null,
              gridStep: 5,
              name: title,
              theme: "light",
              viewBackgroundColor: "#ffffff",
            } as unknown as Parameters<ExcalidrawChangeHandler>[1],
            {},
          )
        }
        type="button"
      >
        Edit canvas
      </button>
    </section>
  ),
  signInIcon: null,
}));

vi.mock("@excalidraw/excalidraw", () => {
  const passthrough = ({ children }: { children?: React.ReactNode }) => (
    <>{children}</>
  );
  const MainMenu = Object.assign(passthrough, {
    DefaultItems: new Proxy({}, { get: () => () => null }),
    Item: passthrough,
    ItemLink: passthrough,
    Separator: () => null,
  });
  const Center = Object.assign(passthrough, {
    Heading: passthrough,
    Logo: passthrough,
    Menu: passthrough,
    MenuItem: passthrough,
    MenuItemHelp: () => null,
    MenuItemLoadScene: () => null,
  });
  const WelcomeScreen = Object.assign(passthrough, {
    Center,
    Hints: {
      HelpHint: () => null,
      MenuHint: passthrough,
      ToolbarHint: passthrough,
    },
  });
  return { Footer: passthrough, MainMenu, WelcomeScreen };
});

describe("GuestCanvasPage", () => {
  it("waits for IndexedDB-backed initial data before mounting the canvas", async () => {
    const repository: GuestCanvasRepository = {
      loadInitialData: vi.fn().mockResolvedValue({ elements: [] }),
      saveSnapshot: vi.fn(),
    };

    render(
      <MemoryRouter>
        <GuestCanvasPage repository={repository} title="Local sketch" />
      </MemoryRouter>,
    );

    expect(screen.getByText("Loading your local drawing…")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("region", {
          name: "Local sketch drawing canvas",
        }),
      ).toHaveAttribute("data-elements", "0"),
    );
    // The local-only nature and the account actions now surface through
    // Excalidraw's own chrome rather than a page header bar.
    expect(screen.getByRole("status")).toHaveTextContent(
      "Changes stay on this device",
    );
    expect(screen.getByText(/saved on this device only/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Create account" }),
    ).toBeInTheDocument();
  });

  it("keeps a new empty canvas mounted when local autosave fails", async () => {
    const repository: GuestCanvasRepository = {
      loadInitialData: vi.fn().mockResolvedValue(null),
      saveSnapshot: vi
        .fn()
        .mockRejectedValueOnce(new Error("IndexedDB unavailable"))
        .mockImplementation(() => new Promise(() => undefined)),
    };

    render(
      <MemoryRouter>
        <GuestCanvasPage
          repository={repository}
          saveDelayMs={25}
          title="New local sketch"
        />
      </MemoryRouter>,
    );

    const canvas = await screen.findByRole("region", {
      name: "New local sketch drawing canvas",
    });
    fireEvent.click(screen.getByRole("button", { name: "Edit canvas" }));
    await screen.findByText("Local save failed");
    expect(canvas).toBeInTheDocument();
    expect(
      screen.queryByText("Could not open this local drawing."),
    ).not.toBeInTheDocument();
  });
});
