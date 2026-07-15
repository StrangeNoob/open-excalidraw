import type { ChatMessage } from "@open-excalidraw/contracts";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { SocketIoTransport } from "../collaboration";

import { ChatPanel } from "./ChatPanel";

const DRAWING_ID = "00000000-0000-4000-8000-000000000001";
const ME_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_ID = "10000000-0000-4000-8000-000000000002";

const message = (overrides: Partial<ChatMessage>): ChatMessage => ({
  id: crypto.randomUUID(),
  drawingId: DRAWING_ID,
  userId: OTHER_ID,
  authorName: "Ada",
  body: "hello",
  createdAt: "2026-07-15T00:00:00.000Z",
  ...overrides,
});

function createFakeTransport() {
  const listeners = new Set<(m: ChatMessage) => void>();
  const emitted: unknown[] = [];
  const transport = {
    emit: (event: unknown) => {
      emitted.push(event);
    },
    onChatMessage: (listener: (m: ChatMessage) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    transport: transport as unknown as SocketIoTransport,
    emitted,
    receive: (m: ChatMessage) => {
      act(() => {
        for (const listener of listeners) listener(m);
      });
    },
  };
}

const renderPanel = (
  fake = createFakeTransport(),
  overrides: Partial<Parameters<typeof ChatPanel>[0]> = {},
) => {
  const client = {
    history: vi.fn(() =>
      Promise.resolve({
        messages: [message({ body: "welcome" })],
        nextCursor: null,
      }),
    ),
  };
  render(
    <ChatPanel
      client={client}
      drawingId={DRAWING_ID}
      error={null}
      onClose={vi.fn()}
      status="ready"
      transport={fake.transport}
      userId={ME_ID}
      {...overrides}
    />,
  );
  return { client, fake };
};

describe("ChatPanel", () => {
  it("renders history and appends live messages", async () => {
    const { fake } = renderPanel();

    expect(await screen.findByText("welcome")).toBeInTheDocument();

    fake.receive(message({ body: "a live one" }));
    expect(await screen.findByText("a live one")).toBeInTheDocument();
  });

  it("sends the draft and confirms it via the echoed broadcast", async () => {
    const user = userEvent.setup();
    const { fake } = renderPanel();
    await screen.findByText("welcome");

    await user.type(screen.getByLabelText("Message"), "shipping it");
    await user.click(screen.getByRole("button", { name: "Send" }));

    const sent = fake.emitted[0] as {
      type: string;
      messageId: string;
      body: string;
    };
    expect(sent).toMatchObject({ type: "chat.send", body: "shipping it" });
    expect(screen.getByText("sending…")).toBeInTheDocument();

    fake.receive(
      message({ id: sent.messageId, userId: ME_ID, body: "shipping it" }),
    );
    expect(await screen.findByText("You")).toBeInTheDocument();
    expect(screen.queryByText("sending…")).not.toBeInTheDocument();
    expect(screen.getAllByText("shipping it")).toHaveLength(1);
  });

  it("disables the composer until the room is ready", async () => {
    renderPanel(createFakeTransport(), { status: "connecting" });

    expect(await screen.findByLabelText("Message")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("shows the rate limit notice inline", async () => {
    renderPanel(createFakeTransport(), {
      error: {
        code: "CHAT_RATE_LIMITED",
        message: "Chat message rate exceeded",
        requestId: "r1",
        retryable: true,
      },
    });

    expect(
      await screen.findByText(/sending messages too fast/),
    ).toBeInTheDocument();
  });

  it("keeps chronological order when a reconnect reloads after older pages", async () => {
    const user = userEvent.setup();
    const fake = createFakeTransport();
    const oldest = message({
      body: "oldest",
      createdAt: "2026-07-15T00:00:00.000Z",
    });
    const middle = message({
      body: "middle",
      createdAt: "2026-07-15T00:01:00.000Z",
    });
    const newest = message({
      body: "newest",
      createdAt: "2026-07-15T00:02:00.000Z",
    });
    const client = {
      history: vi.fn((_drawingId: string, before: string | null) =>
        Promise.resolve(
          before
            ? { messages: [oldest], nextCursor: null }
            : { messages: [newest, middle], nextCursor: oldest.id },
        ),
      ),
    };
    const props = {
      client,
      drawingId: DRAWING_ID,
      error: null,
      onClose: vi.fn(),
      transport: fake.transport,
      userId: ME_ID,
    };

    const { rerender } = render(<ChatPanel {...props} status="ready" />);
    await user.click(
      await screen.findByRole("button", { name: "Load older messages" }),
    );
    await screen.findByText("oldest");

    rerender(<ChatPanel {...props} status="reconnecting" />);
    rerender(<ChatPanel {...props} status="ready" />);
    await waitFor(() => expect(client.history).toHaveBeenCalledTimes(3));

    const bodies = [...document.querySelectorAll(".chat-body")].map(
      (element) => element.textContent,
    );
    expect(bodies).toEqual(["oldest", "middle", "newest"]);
  });

  it("ignores messages for other drawings", async () => {
    const { fake } = renderPanel();
    await screen.findByText("welcome");

    fake.receive(
      message({ drawingId: crypto.randomUUID(), body: "wrong room" }),
    );

    expect(screen.queryByText("wrong room")).not.toBeInTheDocument();
  });
});
