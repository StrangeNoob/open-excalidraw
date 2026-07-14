import {
  chatMessageBodySchema,
  CONTRACT_LIMITS,
  type ChatMessage,
} from "@open-excalidraw/contracts";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";

import type {
  CollaborationStatus,
  RealtimeProblem,
  SocketIoTransport,
} from "../collaboration";

import { ChatClient, type ChatSource } from "./api";

import "./chat.css";

const PENDING_TIMEOUT_MS = 5_000;

export interface ChatPanelProps {
  client?: ChatSource;
  drawingId: string;
  error: RealtimeProblem | null;
  onClose: () => void;
  status: CollaborationStatus;
  transport: SocketIoTransport;
  userId: string;
}

interface OutboxMessage {
  body: string;
  failed: boolean;
  messageId: string;
  sentAt: number;
}

const defaultClient = new ChatClient();

export const ChatPanel = ({
  client = defaultClient,
  drawingId,
  error,
  onClose,
  status,
  transport,
  userId,
}: ChatPanelProps) => {
  // Oldest first for rendering; the API returns pages newest first.
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // One outbox for unconfirmed sends; `failed` flips after the timeout.
  // Entries leave the outbox when their echo arrives from the server.
  const [outbox, setOutbox] = useState<OutboxMessage[]>([]);
  const logRef = useRef<HTMLDivElement | null>(null);
  const ready = status === "ready";
  const pending = outbox.filter((entry) => !entry.failed);
  const failed = outbox.filter((entry) => entry.failed);

  const loadLatest = useCallback(async () => {
    try {
      const page = await client.history(drawingId, null);
      // Merge instead of replace: a live message may have arrived while
      // this request was in flight.
      setMessages((current) => {
        const pageIds = new Set(page.messages.map(({ id }) => id));
        return [
          ...[...page.messages].reverse(),
          ...current.filter(({ id }) => !pageIds.has(id)),
        ];
      });
      setNextCursor(page.nextCursor);
      setLoadError(null);
      setLoaded(true);
    } catch {
      setLoadError("Chat history could not be loaded");
    }
  }, [client, drawingId]);

  // Load on open and reload whenever the room becomes ready again: the
  // socket does not replay missed messages, the refetch covers the gap.
  const previousReadyRef = useRef<boolean | null>(null);
  useEffect(() => {
    const previous = previousReadyRef.current;
    previousReadyRef.current = ready;
    if (previous === null || (ready && previous === false)) {
      void loadLatest();
    }
  }, [ready, loadLatest]);

  useEffect(
    () =>
      transport.onChatMessage((message) => {
        if (message.drawingId !== drawingId) {
          return;
        }
        setMessages((current) =>
          current.some((existing) => existing.id === message.id)
            ? current
            : [...current, message],
        );
        setOutbox((current) =>
          current.filter(({ messageId }) => messageId !== message.id),
        );
      }),
    [transport, drawingId],
  );

  // A pending send that never echoes back within the timeout has failed;
  // one coarse timer beats a timer per message. The updater is pure so
  // React may safely invoke it twice.
  useEffect(() => {
    if (pending.length === 0) {
      return;
    }
    const timer = setInterval(() => {
      const cutoff = Date.now() - PENDING_TIMEOUT_MS;
      setOutbox((current) =>
        current.map((entry) =>
          entry.failed || entry.sentAt > cutoff
            ? entry
            : { ...entry, failed: true },
        ),
      );
    }, 1_000);
    return () => clearInterval(timer);
  }, [pending.length]);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [messages.length, pending.length]);

  const send = useCallback(
    (body: string, reuseMessageId?: string) => {
      // The gateway disconnects sockets that emit invalid payloads, so
      // never let an invalid body reach the wire.
      const parsed = chatMessageBodySchema.safeParse(body);
      if (!parsed.success || !ready) {
        return;
      }
      const messageId = reuseMessageId ?? crypto.randomUUID();
      setOutbox((current) => [
        ...current.filter((entry) => entry.messageId !== messageId),
        { body: parsed.data, failed: false, messageId, sentAt: Date.now() },
      ]);
      transport.emit({ type: "chat.send", messageId, body: parsed.data });
    },
    [ready, transport],
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (draft.trim().length === 0) {
      return;
    }
    send(draft);
    setDraft("");
  };

  const loadOlder = async () => {
    if (!nextCursor) {
      return;
    }
    try {
      const page = await client.history(drawingId, nextCursor);
      setMessages((current) => [...[...page.messages].reverse(), ...current]);
      setNextCursor(page.nextCursor);
      setLoadError(null);
    } catch {
      setLoadError("Older messages could not be loaded");
    }
  };

  const rateLimited = error?.code === "CHAT_RATE_LIMITED";

  return (
    <aside aria-label="Chat" className="chat-panel">
      <header className="chat-panel-header">
        <h2>Chat</h2>
        <button
          aria-label="Close chat"
          className="chat-close"
          onClick={onClose}
          type="button"
        >
          ×
        </button>
      </header>
      <div className="chat-log" ref={logRef}>
        {nextCursor ? (
          <button
            className="chat-load-older"
            onClick={() => void loadOlder()}
            type="button"
          >
            Load older messages
          </button>
        ) : null}
        {loadError ? (
          <p className="chat-notice chat-notice--error" role="alert">
            {loadError}
          </p>
        ) : null}
        {loaded && messages.length === 0 && pending.length === 0 ? (
          <p className="chat-empty">No messages yet. Say hello!</p>
        ) : null}
        <ol className="chat-messages">
          {messages.map((message) => (
            <li
              className={`chat-message${
                message.userId === userId ? " chat-message--own" : ""
              }`}
              key={message.id}
            >
              <span className="chat-author">
                {message.userId === userId ? "You" : message.authorName}
              </span>
              <span className="chat-body">{message.body}</span>
              <time className="chat-time" dateTime={message.createdAt}>
                {formatTime(message.createdAt)}
              </time>
            </li>
          ))}
          {pending.map((entry) => (
            <li
              className="chat-message chat-message--own chat-message--pending"
              key={entry.messageId}
            >
              <span className="chat-author">You</span>
              <span className="chat-body">{entry.body}</span>
              <span className="chat-time">sending…</span>
            </li>
          ))}
          {failed.map((entry) => (
            <li
              className="chat-message chat-message--own chat-message--failed"
              key={entry.messageId}
            >
              <span className="chat-author">You</span>
              <span className="chat-body">{entry.body}</span>
              <button
                className="chat-retry"
                onClick={() => send(entry.body, entry.messageId)}
                type="button"
              >
                Failed — retry
              </button>
            </li>
          ))}
        </ol>
      </div>
      {rateLimited ? (
        <p className="chat-notice" role="status">
          You are sending messages too fast — give it a second.
        </p>
      ) : null}
      <form className="chat-compose" onSubmit={submit}>
        <textarea
          aria-label="Message"
          disabled={!ready}
          maxLength={CONTRACT_LIMITS.chatMessageCharacters}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder={ready ? "Message collaborators…" : "Connecting…"}
          rows={2}
          value={draft}
        />
        <button
          className="canvas-action canvas-action--primary"
          disabled={!ready || draft.trim().length === 0}
          type="submit"
        >
          Send
        </button>
      </form>
    </aside>
  );
};

const formatTime = (createdAt: string) =>
  new Date(createdAt).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
