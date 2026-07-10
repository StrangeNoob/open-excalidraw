import type { ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import type { ExcalidrawChangeHandler } from "../../editor";
import type { GuestCanvasRepository } from "../hooks";
import { GuestCanvasPage } from "./GuestCanvasPage";

vi.mock("../../editor", () => ({
  ExcalidrawHost: ({
    initialData,
    onChange,
    title,
  }: {
    initialData: ExcalidrawInitialDataState | null;
    onChange: ExcalidrawChangeHandler;
    title: string;
  }) => (
    <section
      aria-label={`${title} drawing canvas`}
      data-elements={initialData?.elements?.length ?? 0}
    >
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
}));

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
    expect(screen.getByText("Local only")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      "/login?returnTo=%2Fapp",
    );
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
