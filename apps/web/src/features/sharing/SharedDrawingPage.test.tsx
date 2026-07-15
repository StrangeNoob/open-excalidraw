import "../../shared/test/excalidraw-dom";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";

import { ApiError } from "../../shared/api";
import type { SocketIoTransport } from "../collaboration";
import type {
  RealtimeTransportHandlers,
  RealtimeProblem,
} from "../collaboration";
import type { ExcalidrawHostProps } from "../editor";
import { SharedDrawingPage } from "./SharedDrawingPage";

const TOKEN = "s".repeat(43);
const DRAWING_ID = "00000000-0000-4000-8000-000000000001";

const sharedDrawing = {
  drawingId: DRAWING_ID,
  revision: "7",
  scene: {
    appState: {},
    elements: [],
    source: "test",
    type: "excalidraw" as const,
    version: 2,
  },
  title: "Roadmap sketch",
};

class FakeShareTransport {
  handlers: RealtimeTransportHandlers | null = null;
  setHandlers(handlers: RealtimeTransportHandlers | null) {
    this.handlers = handlers;
  }
  onChatMessage() {
    return () => undefined;
  }
  connect() {}
  disconnect() {}
  emit() {}
}

const fakeEditor = {
  addFiles: vi.fn(),
  getAppState: vi.fn(() => ({})),
  getSceneElementsIncludingDeleted: vi.fn(() => []),
  updateScene: vi.fn(),
} as unknown as ExcalidrawImperativeAPI;

const FakeHost = ({ onApiChange, readOnly, title }: ExcalidrawHostProps) => {
  useEffect(() => {
    onApiChange?.(fakeEditor);
    return () => onApiChange?.(null);
  }, [onApiChange]);
  return (
    <div data-read-only={readOnly} data-testid="share-host">
      {title}
    </div>
  );
};

const renderPage = (options?: {
  inspect?: () => Promise<typeof sharedDrawing>;
  transport?: FakeShareTransport;
  path?: string;
}) => {
  const transport = options?.transport ?? new FakeShareTransport();
  const inspect = vi.fn(
    options?.inspect ?? (() => Promise.resolve(sharedDrawing)),
  );
  const router = createMemoryRouter(
    [
      {
        path: "/s/:token",
        element: (
          <SharedDrawingPage
            dependencies={{
              assets: () => ({ download: vi.fn() }),
              createRealtimeTransport: () =>
                transport as unknown as SocketIoTransport,
              host: FakeHost,
              share: { inspect },
            }}
          />
        ),
      },
    ],
    { initialEntries: [options?.path ?? `/s/${TOKEN}`] },
  );
  render(<RouterProvider router={router} />);
  return { inspect, transport };
};

describe("SharedDrawingPage", () => {
  it("renders the shared drawing read-only", async () => {
    const { inspect } = renderPage();

    expect(await screen.findByTestId("share-host")).toHaveAttribute(
      "data-read-only",
      "true",
    );
    expect(screen.getByText("Roadmap sketch")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("View only");
    expect(inspect).toHaveBeenCalledWith(TOKEN);
  });

  it("shows the unavailable screen for an unknown token", async () => {
    renderPage({
      inspect: () =>
        Promise.reject(
          new ApiError(404, {
            code: "SHARE_LINK_NOT_FOUND",
            requestId: "test",
            status: 404,
            title: "Share link not found",
          }),
        ),
    });

    expect(
      await screen.findByRole("heading", { name: "This link isn't available" }),
    ).toBeInTheDocument();
  });

  it("rejects malformed tokens without calling the API", () => {
    const { inspect } = renderPage({ path: "/s/not-a-token" });

    expect(
      screen.getByRole("heading", { name: "This link isn't available" }),
    ).toBeInTheDocument();
    expect(inspect).not.toHaveBeenCalled();
  });

  it("replaces the canvas when the link is revoked mid-session", async () => {
    const transport = new FakeShareTransport();
    renderPage({ transport });
    await screen.findByTestId("share-host");

    const problem: RealtimeProblem = {
      code: "SOCKET_MEMBERSHIP_REVOKED",
      message: "Drawing access was revoked",
      requestId: "test",
      retryable: false,
    };
    await vi.waitFor(() => expect(transport.handlers).not.toBeNull());
    transport.handlers?.onError(problem);

    expect(
      await screen.findByRole("heading", { name: "This link isn't available" }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("share-host")).toBeNull();
  });
});
