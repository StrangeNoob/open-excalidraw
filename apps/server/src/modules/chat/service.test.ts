import { TokenBucketRateLimiter } from "../collaboration/core/rate-limit.js";
import type { SocketAuthorizationBinding } from "../collaboration/security/index.js";
import { ChatService } from "./service.js";
import type { ChatMessageRecord, ChatRepository } from "./types.js";

const DRAWING_ID = "10000000-0000-4000-8000-000000000001";
const USER_ID = "10000000-0000-4000-8000-000000000002";
const MESSAGE_ID = "10000000-0000-4000-8000-000000000003";
const MEMBER_ID = "10000000-0000-4000-8000-000000000004";
const STRANGER_ID = "10000000-0000-4000-8000-000000000005";

const binding = {
  connectionId: "connection-1",
  drawingId: DRAWING_ID,
  userId: USER_ID,
} as SocketAuthorizationBinding;

function record(overrides: Partial<ChatMessageRecord> = {}): ChatMessageRecord {
  return {
    id: MESSAGE_ID,
    drawingId: DRAWING_ID,
    userId: USER_ID,
    authorName: "Ada",
    body: "hello",
    mentions: null,
    anchor: null,
    createdAt: new Date("2026-07-15T00:00:00.000Z"),
    ...overrides,
  };
}

function createService(
  repository: Partial<ChatRepository>,
  options: { role?: "owner" | "editor" | "viewer" | null; nowMs?: number } = {},
) {
  const clockMs = { value: options.nowMs ?? 0 };
  const getRole = vi
    .fn()
    .mockResolvedValue(options.role === undefined ? "owner" : options.role);
  const service = new ChatService({
    repository: repository as ChatRepository,
    membershipResolver: { getRole },
    rateLimiter: new TokenBucketRateLimiter({
      capacity: 5,
      refillTokensPerSecond: 1,
      clock: { now: () => clockMs.value },
    }),
  });
  return { service, clockMs, getRole };
}

describe("ChatService.send", () => {
  it("persists and returns the message with server metadata", async () => {
    const insert = vi.fn().mockResolvedValue(record());
    const { service } = createService({ insert });

    const message = await service.send(binding, {
      type: "chat.send",
      messageId: MESSAGE_ID,
      body: "hello",
    });

    expect(insert).toHaveBeenCalledWith({
      id: MESSAGE_ID,
      drawingId: DRAWING_ID,
      userId: USER_ID,
      body: "hello",
    });
    expect(message).toMatchObject({
      id: MESSAGE_ID,
      authorName: "Ada",
      createdAt: "2026-07-15T00:00:00.000Z",
    });
    expect(message).not.toHaveProperty("mentions");
    expect(message).not.toHaveProperty("anchor");
  });

  it("keeps mentioned members and silently drops the rest", async () => {
    const insert = vi.fn().mockResolvedValue(record({ mentions: [MEMBER_ID] }));
    const { service, getRole } = createService({ insert });
    getRole.mockImplementation((_drawingId: string, userId: string) =>
      Promise.resolve(userId === MEMBER_ID ? "editor" : null),
    );

    const message = await service.send(binding, {
      type: "chat.send",
      messageId: MESSAGE_ID,
      body: "hello",
      mentions: [MEMBER_ID, STRANGER_ID],
    });

    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ mentions: [MEMBER_ID] }),
    );
    expect(message?.mentions).toEqual([MEMBER_ID]);
  });

  it("omits mentions entirely when none of them are members", async () => {
    const insert = vi.fn().mockResolvedValue(record());
    const { service } = createService({ insert }, { role: null });

    const message = await service.send(binding, {
      type: "chat.send",
      messageId: MESSAGE_ID,
      body: "hello",
      mentions: [STRANGER_ID],
    });

    expect(insert.mock.calls[0]?.[0]?.mentions).toBeUndefined();
    expect(message).not.toHaveProperty("mentions");
  });

  it("deduplicates mentions before resolving membership", async () => {
    const insert = vi.fn().mockResolvedValue(record());
    const { service, getRole } = createService({ insert });

    await service.send(binding, {
      type: "chat.send",
      messageId: MESSAGE_ID,
      body: "hello",
      mentions: [MEMBER_ID, USER_ID, MEMBER_ID],
    });

    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ mentions: [MEMBER_ID, USER_ID] }),
    );
    expect(getRole).toHaveBeenCalledTimes(2);
  });

  it("stores the anchor as sent without checking it against the scene", async () => {
    const anchor = { elementIds: ["Zx1", "Zx2"] };
    const insert = vi.fn().mockResolvedValue(record({ anchor }));
    const { service } = createService({ insert });

    const message = await service.send(binding, {
      type: "chat.send",
      messageId: MESSAGE_ID,
      body: "look here",
      anchor,
    });

    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ anchor }));
    expect(message?.anchor).toEqual(anchor);
  });

  it("returns null for a duplicate messageId so it is not re-broadcast", async () => {
    const { service } = createService({
      insert: vi.fn().mockResolvedValue(null),
    });

    await expect(
      service.send(binding, {
        type: "chat.send",
        messageId: MESSAGE_ID,
        body: "hello",
      }),
    ).resolves.toBeNull();
  });

  it("allows a burst of five then rate-limits until tokens refill", async () => {
    const insert = vi.fn().mockResolvedValue(record());
    const { service, clockMs } = createService({ insert });
    const send = () =>
      service.send(binding, {
        type: "chat.send",
        messageId: MESSAGE_ID,
        body: "hello",
      });

    for (let i = 0; i < 5; i += 1) {
      await send();
    }
    await expect(send()).rejects.toMatchObject({ code: "CHAT_RATE_LIMITED" });

    clockMs.value += 1_000;
    await expect(send()).resolves.not.toBeNull();
  });
});

describe("ChatService.history", () => {
  it("hides drawings the user cannot access as not found", async () => {
    const { service } = createService({ listBefore: vi.fn() }, { role: null });

    await expect(service.history(USER_ID, DRAWING_ID)).rejects.toMatchObject({
      code: "DRAWING_NOT_FOUND",
      status: 404,
    });
  });

  it("pages with a cursor and reports the next one only when more remain", async () => {
    const rows = Array.from({ length: 51 }, (_, i) =>
      record({
        id: `10000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        createdAt: new Date(Date.UTC(2026, 6, 15, 0, 0, 51 - i)),
      }),
    );
    const listBefore = vi.fn().mockResolvedValue(rows);
    const { service } = createService({ listBefore });

    const page = await service.history(USER_ID, DRAWING_ID);

    expect(listBefore).toHaveBeenCalledWith(DRAWING_ID, null, 51);
    expect(page.messages).toHaveLength(50);
    expect(page.nextCursor).not.toBeNull();

    expect(page.nextCursor).toBe(rows[49]!.id);

    listBefore.mockResolvedValue(rows.slice(0, 10));
    const lastPage = await service.history(
      USER_ID,
      DRAWING_ID,
      page.nextCursor!,
    );

    expect(listBefore).toHaveBeenLastCalledWith(DRAWING_ID, rows[49]!.id, 51);
    expect(lastPage.nextCursor).toBeNull();
  });

  it("maps mentions and anchors only for the rows that carry them", async () => {
    const anchor = { elementIds: ["Zx1"] };
    const listBefore = vi
      .fn()
      .mockResolvedValue([
        record({ id: MESSAGE_ID, mentions: [MEMBER_ID], anchor }),
        record({ id: MEMBER_ID }),
      ]);
    const { service } = createService({ listBefore });

    const page = await service.history(USER_ID, DRAWING_ID);

    expect(page.messages[0]).toMatchObject({ mentions: [MEMBER_ID], anchor });
    expect(page.messages[1]).not.toHaveProperty("mentions");
    expect(page.messages[1]).not.toHaveProperty("anchor");
  });

  it("rejects a malformed cursor as a validation error", async () => {
    const { service } = createService({ listBefore: vi.fn() });

    await expect(
      service.history(USER_ID, DRAWING_ID, "not-a-cursor"),
    ).rejects.toMatchObject({ name: "ZodError" });
  });
});

describe("ChatService.participants", () => {
  // The sharing member list is owner-only, so the mention picker would stay
  // empty for editors and viewers without this roster.
  it("lists the roster for a member of any role", async () => {
    const roster = [
      { userId: USER_ID, name: "Ada" },
      { userId: MEMBER_ID, name: "Grace" },
    ];
    const listParticipants = vi.fn().mockResolvedValue(roster);
    const { service } = createService({ listParticipants }, { role: "viewer" });

    await expect(service.participants(USER_ID, DRAWING_ID)).resolves.toEqual({
      participants: roster,
    });
    expect(listParticipants).toHaveBeenCalledWith(DRAWING_ID);
  });

  it("hides drawings the user cannot access as not found", async () => {
    const listParticipants = vi.fn();
    const { service } = createService({ listParticipants }, { role: null });

    await expect(
      service.participants(STRANGER_ID, DRAWING_ID),
    ).rejects.toMatchObject({ code: "DRAWING_NOT_FOUND", status: 404 });
    expect(listParticipants).not.toHaveBeenCalled();
  });
});
