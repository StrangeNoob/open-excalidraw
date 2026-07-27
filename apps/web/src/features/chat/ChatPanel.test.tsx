import {
  CONTRACT_LIMITS,
  type ChatMessage,
  type ChatParticipant,
} from "@open-excalidraw/contracts";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { SocketIoTransport } from "../collaboration";

import { ChatPanel } from "./ChatPanel";

const DRAWING_ID = "00000000-0000-4000-8000-000000000001";
const ME_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_ID = "10000000-0000-4000-8000-000000000002";
const THIRD_ID = "10000000-0000-4000-8000-000000000003";
const FOURTH_ID = "10000000-0000-4000-8000-000000000004";

const message = (overrides: Partial<ChatMessage>): ChatMessage => ({
  id: crypto.randomUUID(),
  drawingId: DRAWING_ID,
  userId: OTHER_ID,
  authorName: "Ada",
  body: "hello",
  createdAt: "2026-07-15T00:00:00.000Z",
  ...overrides,
});

// "Ada Lovelace" overlaps "Ada": a token must go to the member it spells out.
const PARTICIPANTS: ChatParticipant[] = [
  { userId: ME_ID, name: "Linus" },
  { userId: OTHER_ID, name: "Ada" },
  { userId: THIRD_ID, name: "Grace" },
  { userId: FOURTH_ID, name: "Ada Lovelace" },
];

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
    participants: vi.fn(() => Promise.resolve({ participants: PARTICIPANTS })),
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
      participants: vi.fn(() =>
        Promise.resolve({ participants: PARTICIPANTS }),
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

  it("opens the mention picker on @ and inserts the picked member", async () => {
    const user = userEvent.setup();
    const { client } = renderPanel();
    await screen.findByText("welcome");
    const composer = screen.getByLabelText("Message");

    // The roster comes from the chat client: the sharing member list is
    // owner-only, so editors and viewers would get nothing to pick from.
    expect(client.participants).toHaveBeenCalledWith(DRAWING_ID);

    await user.type(composer, "ping @Ad");

    expect(
      screen.queryByRole("button", { name: "Grace" }),
    ).not.toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Ada" }));

    expect(composer).toHaveValue("ping @Ada ");
    expect(
      screen.queryByRole("button", { name: "Ada" }),
    ).not.toBeInTheDocument();
  });

  it("sends the recorded mentions and the attached canvas selection", async () => {
    const user = userEvent.setup();
    const fake = createFakeTransport();
    renderPanel(fake, {
      editorBridge: {
        focusElements: vi.fn(() => true),
        getSelectedElementIds: () => ["el-1", "el-2"],
      },
    });
    await screen.findByText("welcome");
    const composer = screen.getByLabelText("Message");

    await user.type(composer, "@Ad");
    await user.click(await screen.findByRole("button", { name: "Ada" }));
    await user.type(composer, "look at this");
    await user.click(
      await screen.findByRole("button", { name: "Attach selection (2)" }),
    );
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(fake.emitted[0]).toMatchObject({
      anchor: { elementIds: ["el-1", "el-2"] },
      body: "@Ada look at this",
      mentions: [OTHER_ID],
      type: "chat.send",
    });
    expect(composer).toHaveValue("");
    expect(
      screen.getByRole("button", { name: "Attach selection (2)" }),
    ).toBeInTheDocument();
    // The echo has not arrived yet, so the message is still a pending outbox
    // row — its anchor chip must already be visible there.
    expect(
      screen.getByRole("button", { name: "2 elements" }),
    ).toBeInTheDocument();
  });

  it("drops a mention whose token no longer appears in the body", async () => {
    const user = userEvent.setup();
    const fake = createFakeTransport();
    renderPanel(fake);
    await screen.findByText("welcome");
    const composer = screen.getByLabelText("Message");

    await user.type(composer, "@Ad");
    await user.click(await screen.findByRole("button", { name: "Ada" }));
    await user.clear(composer);
    // The leftover text still contains "@Ada", but not as a mention token.
    await user.type(composer, "never mind, ask sales@Adamant.example");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(fake.emitted[0]).toEqual({
      body: "never mind, ask sales@Adamant.example",
      messageId: expect.any(String),
      type: "chat.send",
    });
  });

  it("leaves a token that spells a longer name to that member alone", async () => {
    const user = userEvent.setup();
    const fake = createFakeTransport();
    renderPanel(fake);
    await screen.findByText("welcome");
    const composer = screen.getByLabelText("Message");

    await user.type(composer, "@Ad");
    await user.click(await screen.findByRole("button", { name: "Ada" }));
    // The picker stays shut once the query holds a space, so the longer name
    // is typed out and never picked.
    await user.type(composer, "Lovelace please look");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(fake.emitted[0]).toEqual({
      body: "@Ada Lovelace please look",
      messageId: expect.any(String),
      type: "chat.send",
    });
  });

  it("keeps an over-limit draft instead of sending and clearing it", async () => {
    const user = userEvent.setup();
    const fake = createFakeTransport();
    renderPanel(fake);
    await screen.findByText("welcome");
    const composer = screen.getByLabelText("Message");
    const filler = "x".repeat(CONTRACT_LIMITS.chatMessageCharacters - 5);

    fireEvent.change(composer, { target: { value: filler } });
    // Typing stops at the limit, but inserting a mention rewrites the draft
    // past it: "@Gr" (3 characters) becomes "@Grace " (7).
    await user.type(composer, " @Gr");
    await user.click(await screen.findByRole("button", { name: "Grace" }));

    expect(await screen.findByText(/Message is too long/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();

    await user.type(composer, "{enter}");

    expect(fake.emitted).toHaveLength(0);
    expect(composer).toHaveValue(`${filler} @Grace `);
    expect(screen.queryByText("sending…")).not.toBeInTheDocument();
  });

  it("highlights mentioned names and marks messages that mention you", async () => {
    const { fake } = renderPanel();
    await screen.findByText("welcome");

    fake.receive(
      message({
        body: "ping @Linus about @Grace",
        mentions: [ME_ID, THIRD_ID],
      }),
    );
    fake.receive(message({ body: "@Grace only", mentions: [THIRD_ID] }));

    await waitFor(() =>
      expect(
        [...document.querySelectorAll(".chat-mention")].map(
          (element) => element.textContent,
        ),
      ).toEqual(["@Linus", "@Grace", "@Grace"]),
    );
    const flagged = document.querySelectorAll(".chat-message--mentions-you");
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toHaveTextContent("ping @Linus about @Grace");
  });

  it("focuses an anchor and disables the chip once its elements are gone", async () => {
    const user = userEvent.setup();
    const focusElements = vi.fn(() => true);
    const { fake } = renderPanel(createFakeTransport(), {
      editorBridge: { focusElements, getSelectedElementIds: () => [] },
    });
    await screen.findByText("welcome");

    fake.receive(
      message({ body: "over here", anchor: { elementIds: ["el-1"] } }),
    );

    const chip = await screen.findByRole("button", { name: "1 element" });
    await user.click(chip);
    expect(focusElements).toHaveBeenCalledWith(["el-1"]);
    expect(chip).toBeEnabled();

    focusElements.mockReturnValue(false);
    await user.click(chip);

    const removed = await screen.findByRole("button", {
      name: "Element removed",
    });
    expect(removed).toBeDisabled();
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
