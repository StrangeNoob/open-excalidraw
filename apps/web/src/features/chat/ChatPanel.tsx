import {
  chatMessageBodySchema,
  CONTRACT_LIMITS,
  type ChatMessage,
  type ChatMessageAnchor,
  type ChatParticipant,
} from "@open-excalidraw/contracts";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from "react";

import type {
  CollaborationStatus,
  RealtimeProblem,
  SocketIoTransport,
} from "../collaboration";

import { ChatClient, type ChatSource } from "./api";

import "./chat.css";

const PENDING_TIMEOUT_MS = 5_000;
// Excalidraw exposes no selection subscription, so the composer samples it.
const SELECTION_POLL_MS = 500;
const MENTION_SUGGESTIONS = 6;

export interface ChatEditorBridge {
  /** False when none of the anchored elements are on the canvas any more. */
  focusElements(elementIds: string[]): boolean;
  getSelectedElementIds(): string[];
}

export interface ChatPanelProps {
  client?: ChatSource;
  drawingId: string;
  editorBridge?: ChatEditorBridge;
  error: RealtimeProblem | null;
  onClose: () => void;
  status: CollaborationStatus;
  transport: SocketIoTransport;
  userId: string;
}

interface OutgoingMessage {
  anchor?: ChatMessageAnchor;
  body: string;
  mentions?: string[];
}

interface OutboxMessage extends OutgoingMessage {
  failed: boolean;
  messageId: string;
  sentAt: number;
}

// The name is kept alongside the id: a mention only ships while its token
// survives in the draft, and the body carries names, not ids.
interface DraftMention {
  name: string;
  userId: string;
}

interface MentionSearch {
  end: number;
  query: string;
  start: number;
}

const defaultClient = new ChatClient();

export const ChatPanel = ({
  client = defaultClient,
  drawingId,
  editorBridge,
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
  const [participants, setParticipants] = useState<ChatParticipant[]>([]);
  const [draftMentions, setDraftMentions] = useState<DraftMention[]>([]);
  const [mentionSearch, setMentionSearch] = useState<MentionSearch | null>(
    null,
  );
  const [mentionIndex, setMentionIndex] = useState(0);
  const [selectedElementIds, setSelectedElementIds] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<string[] | null>(null);
  // One outbox for unconfirmed sends; `failed` flips after the timeout.
  // Entries leave the outbox when their echo arrives from the server.
  const [outbox, setOutbox] = useState<OutboxMessage[]>([]);
  const logRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const caretRef = useRef<number | null>(null);
  const ready = status === "ready";
  const pending = outbox.filter((entry) => !entry.failed);
  const failed = outbox.filter((entry) => entry.failed);

  const loadLatest = useCallback(async () => {
    try {
      const page = await client.history(drawingId, null);
      // Merge instead of replace: a live message may have arrived while
      // this request was in flight, and a reconnect reload must slot the
      // latest page after any older pages already on screen.
      setMessages((current) => {
        const byId = new Map(current.map((message) => [message.id, message]));
        for (const message of page.messages) {
          byId.set(message.id, message);
        }
        return [...byId.values()].sort(
          (a, b) =>
            a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
        );
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

  // Participants drive the picker, the highlighting of received mentions and
  // the token matching that decides which mentions ship.
  useEffect(() => {
    let active = true;
    const loadParticipants = async () => {
      try {
        const result = await client.participants(drawingId);
        if (active) {
          setParticipants(result.participants);
        }
      } catch {
        // Mentions are a convenience: without the roster the composer still
        // sends.
      }
    };
    void loadParticipants();
    return () => {
      active = false;
    };
  }, [client, drawingId]);

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

  useEffect(() => {
    if (!editorBridge) {
      return;
    }
    const sample = () => {
      const ids = editorBridge
        .getSelectedElementIds()
        .slice(0, CONTRACT_LIMITS.chatAnchorElements);
      setSelectedElementIds((current) =>
        sameIds(current, ids) ? current : ids,
      );
    };
    sample();
    const timer = setInterval(sample, SELECTION_POLL_MS);
    return () => clearInterval(timer);
  }, [editorBridge]);

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

  // Restores the caret after a picked mention rewrote the draft around it.
  useEffect(() => {
    const caret = caretRef.current;
    if (caret === null || !composerRef.current) {
      return;
    }
    caretRef.current = null;
    composerRef.current.focus();
    composerRef.current.setSelectionRange(caret, caret);
  }, [draft]);

  /** False when the message was not emitted, so the draft must be kept. */
  const send = useCallback(
    (outgoing: OutgoingMessage, reuseMessageId?: string): boolean => {
      // The gateway disconnects sockets that emit invalid payloads, so
      // never let an invalid body reach the wire.
      const parsed = chatMessageBodySchema.safeParse(outgoing.body);
      if (!parsed.success || !ready) {
        return false;
      }
      const messageId = reuseMessageId ?? crypto.randomUUID();
      const payload = {
        body: parsed.data,
        ...(outgoing.mentions?.length ? { mentions: outgoing.mentions } : {}),
        ...(outgoing.anchor ? { anchor: outgoing.anchor } : {}),
      };
      setOutbox((current) => [
        ...current.filter((entry) => entry.messageId !== messageId),
        { ...payload, failed: false, messageId, sentAt: Date.now() },
      ]);
      transport.emit({ type: "chat.send", messageId, ...payload });
      return true;
    },
    [ready, transport],
  );

  const participantNames = useMemo(
    () => new Map(participants.map((member) => [member.userId, member.name])),
    [participants],
  );

  const suggestions = useMemo(() => {
    if (!mentionSearch) {
      return [];
    }
    const query = mentionSearch.query.toLowerCase();
    return participants
      .filter((member) => member.name.toLowerCase().includes(query))
      .slice(0, MENTION_SUGGESTIONS);
  }, [participants, mentionSearch]);
  const activeIndex = Math.min(mentionIndex, suggestions.length - 1);
  // The textarea's maxLength only constrains typing; inserting a picked
  // mention rewrites the draft and can push it past the limit.
  const excess = draft.trim().length - CONTRACT_LIMITS.chatMessageCharacters;
  const overLimit = excess > 0;

  const changeDraft = (event: ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(event.target.value);
    setMentionSearch(
      findMentionSearch(event.target.value, event.target.selectionStart),
    );
    setMentionIndex(0);
  };

  const insertMention = (member: ChatParticipant) => {
    if (!mentionSearch) {
      return;
    }
    const token = `@${member.name} `;
    setDraft(
      `${draft.slice(0, mentionSearch.start)}${token}${draft.slice(mentionSearch.end)}`,
    );
    setDraftMentions((current) =>
      current.some((entry) => entry.userId === member.userId)
        ? current
        : [...current, { name: member.name, userId: member.userId }],
    );
    setMentionSearch(null);
    caretRef.current = mentionSearch.start + token.length;
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const body = draft.trim();
    // An over-limit draft or a room that dropped out of ready keeps the
    // composed message: clearing it would discard the text with nothing sent.
    if (body.length === 0 || overLimit) {
      return;
    }
    const sent = send({
      ...(anchor ? { anchor: { elementIds: anchor } } : {}),
      body,
      mentions: sentMentions(
        body,
        draftMentions,
        participants.map((member) => member.name),
      ),
    });
    if (!sent) {
      return;
    }
    setDraft("");
    setDraftMentions([]);
    setMentionSearch(null);
    setAnchor(null);
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
          {messages.map((message) => {
            const own = message.userId === userId;
            const mentionsMe =
              !own && (message.mentions?.includes(userId) ?? false);
            return (
              <li
                className={`chat-message${own ? " chat-message--own" : ""}${
                  mentionsMe ? " chat-message--mentions-you" : ""
                }`}
                key={message.id}
              >
                <span className="chat-author">
                  {own ? "You" : message.authorName}
                </span>
                <span className="chat-body">
                  {highlightMentions(
                    message.body,
                    mentionedNames(message, participantNames),
                  )}
                </span>
                {message.anchor ? (
                  <AnchorChip anchor={message.anchor} bridge={editorBridge} />
                ) : null}
                <time className="chat-time" dateTime={message.createdAt}>
                  {formatTime(message.createdAt)}
                </time>
              </li>
            );
          })}
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
                onClick={() => send(entry, entry.messageId)}
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
      {overLimit ? (
        <p className="chat-notice chat-notice--error" role="alert">
          {`Message is too long — remove ${excess} character${
            excess === 1 ? "" : "s"
          }.`}
        </p>
      ) : null}
      <div className="chat-composer">
        {suggestions.length > 0 ? (
          <ul aria-label="Mention a member" className="chat-mention-picker">
            {suggestions.map((member, index) => (
              <li key={member.userId}>
                <button
                  className={`chat-mention-option${
                    index === activeIndex ? " chat-mention-option--active" : ""
                  }`}
                  onClick={() => insertMention(member)}
                  type="button"
                >
                  {member.name}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <form className="chat-compose" onSubmit={submit}>
          {editorBridge && (anchor || selectedElementIds.length > 0) ? (
            <button
              aria-pressed={anchor !== null}
              className="chat-attach"
              onClick={() => setAnchor(anchor ? null : selectedElementIds)}
              type="button"
            >
              {anchor
                ? `Attached (${anchor.length})`
                : `Attach selection (${selectedElementIds.length})`}
            </button>
          ) : null}
          <textarea
            aria-label="Message"
            disabled={!ready}
            maxLength={CONTRACT_LIMITS.chatMessageCharacters}
            onChange={changeDraft}
            onKeyDown={(event) => {
              if (suggestions.length > 0) {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const step =
                    event.key === "ArrowDown" ? 1 : suggestions.length - 1;
                  setMentionIndex(
                    (current) => (current + step) % suggestions.length,
                  );
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setMentionSearch(null);
                  return;
                }
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  const picked = suggestions[activeIndex];
                  if (picked) {
                    insertMention(picked);
                  }
                  return;
                }
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder={ready ? "Message collaborators…" : "Connecting…"}
            ref={composerRef}
            rows={2}
            value={draft}
          />
          <button
            className="canvas-action canvas-action--primary"
            disabled={!ready || draft.trim().length === 0 || overLimit}
            type="submit"
          >
            Send
          </button>
        </form>
      </div>
    </aside>
  );
};

const AnchorChip = ({
  anchor,
  bridge,
}: {
  anchor: ChatMessageAnchor;
  bridge: ChatEditorBridge | undefined;
}) => {
  // Anchors are resolved at click time only: the scene moves on, and elements
  // may well be gone by the time somebody follows the chip.
  const [removed, setRemoved] = useState(false);
  const count = anchor.elementIds.length;
  return (
    <button
      className={`chat-anchor${removed ? " chat-anchor--removed" : ""}`}
      disabled={!bridge || removed}
      onClick={() => {
        if (bridge && !bridge.focusElements(anchor.elementIds)) {
          setRemoved(true);
        }
      }}
      type="button"
    >
      {removed
        ? "Element removed"
        : `${count} element${count === 1 ? "" : "s"}`}
    </button>
  );
};

const formatTime = (createdAt: string) =>
  new Date(createdAt).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });

const sameIds = (current: readonly string[], next: readonly string[]) =>
  current.length === next.length &&
  current.every((id, index) => id === next[index]);

// Only an "@" that opens a word starts a mention, and the token ends at the
// first space: "a@b" and a caret past "@ada " must not reopen the picker.
const findMentionSearch = (
  value: string,
  caret: number,
): MentionSearch | null => {
  const upto = value.slice(0, caret);
  const start = upto.lastIndexOf("@");
  if (start < 0 || (start > 0 && !/\s/.test(upto.charAt(start - 1)))) {
    return null;
  }
  const query = upto.slice(start + 1);
  return /\s/.test(query) ? null : { end: caret, query, start };
};

interface MentionToken {
  end: number;
  name: string;
  start: number;
}

/**
 * Finds the "@name" tokens of `names` in `body`. Only an "@" that opens a word
 * starts one, and the longest name wins, so "@Ada Lovelace" is never read as a
 * mention of a member called "Ada" and "sales@Adamant.example" tags nobody.
 */
const findMentionTokens = (
  body: string,
  names: readonly string[],
): MentionToken[] => {
  const ordered = [...names].sort((a, b) => b.length - a.length);
  const tokens: MentionToken[] = [];
  let index = body.indexOf("@");
  while (index >= 0) {
    const rest = body.slice(index + 1);
    const name =
      index === 0 || /\s/.test(body.charAt(index - 1))
        ? ordered.find(
            (candidate) =>
              rest.startsWith(candidate) &&
              endsToken(rest.charAt(candidate.length)),
          )
        : undefined;
    if (name === undefined) {
      index = body.indexOf("@", index + 1);
      continue;
    }
    const end = index + 1 + name.length;
    tokens.push({ end, name, start: index });
    index = body.indexOf("@", end);
  }
  return tokens;
};

// A name has to end where a word ends: "@Ada" must not match in "@Adalyn".
const endsToken = (next: string) => next === "" || !/[\p{L}\p{N}]/u.test(next);

// A mention ships only while its own token survives in the body: deleting the
// name after picking it, or another member's name growing over it, must not
// tag that member anyway.
const sentMentions = (
  body: string,
  drafted: readonly DraftMention[],
  names: readonly string[],
) => {
  const tokens = new Set(
    findMentionTokens(body, names).map((token) => token.name),
  );
  const ids = new Set<string>();
  for (const mention of drafted) {
    if (tokens.has(mention.name)) {
      ids.add(mention.userId);
    }
  }
  return [...ids].slice(0, CONTRACT_LIMITS.chatMentionsPerMessage);
};

const mentionedNames = (
  message: ChatMessage,
  names: ReadonlyMap<string, string>,
): string[] =>
  (message.mentions ?? [])
    .map((mentionedId) => names.get(mentionedId))
    .filter((name): name is string => name !== undefined);

const highlightMentions = (
  body: string,
  names: readonly string[],
): ReactNode => {
  const tokens = findMentionTokens(body, names);
  if (tokens.length === 0) {
    return body;
  }
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const token of tokens) {
    parts.push(
      body.slice(cursor, token.start),
      <span className="chat-mention" key={token.start}>
        {body.slice(token.start, token.end)}
      </span>,
    );
    cursor = token.end;
  }
  parts.push(body.slice(cursor));
  return parts;
};
