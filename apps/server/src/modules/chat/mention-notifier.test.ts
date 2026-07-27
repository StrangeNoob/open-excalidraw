import {
  DisabledMailer,
  type MailMessage,
  type Mailer,
} from "@open-excalidraw/mail";

import { MentionEmailNotifier } from "./mention-notifier.js";
import type {
  MentionEmailRecipient,
  MentionNotificationRepository,
} from "./types.js";

const DRAWING_ID = "10000000-0000-4000-8000-000000000001";
const SENDER_ID = "10000000-0000-4000-8000-000000000002";
const AWAY_ID = "10000000-0000-4000-8000-000000000003";
const PRESENT_ID = "10000000-0000-4000-8000-000000000004";
const OPTED_OUT_ID = "10000000-0000-4000-8000-000000000005";

const COOLDOWN_MINUTES = 15;
const COOLDOWN_MS = COOLDOWN_MINUTES * 60_000;

function recipient(
  userId: string,
  overrides: Partial<MentionEmailRecipient> = {},
): MentionEmailRecipient {
  return {
    userId,
    email: `${userId}@example.test`,
    mentionEmails: true,
    drawingTitle: "Roadmap",
    ...overrides,
  };
}

/**
 * In-memory stand-in for the Postgres claim: one send per (user, drawing) per
 * window, the same contract the conditional upsert implements.
 */
function fakeRepository(
  recipients: MentionEmailRecipient[],
  clock: { nowMs: number } = { nowMs: 0 },
): MentionNotificationRepository & { clock: { nowMs: number } } {
  const lastSentAt = new Map<string, number>();
  return {
    clock,
    findMentionRecipients: ({ userIds }) =>
      Promise.resolve(
        recipients.filter((entry) => userIds.includes(entry.userId)),
      ),
    claimMentionEmailCooldown: ({ drawingId, userIds, cooldownMinutes }) =>
      Promise.resolve(
        userIds.filter((userId) => {
          const key = `${userId}:${drawingId}`;
          const previous = lastSentAt.get(key);
          if (
            previous !== undefined &&
            previous > clock.nowMs - cooldownMinutes * 60_000
          ) {
            return false;
          }
          lastSentAt.set(key, clock.nowMs);
          return true;
        }),
      ),
  };
}

function createNotifier(
  repository: MentionNotificationRepository,
  options: {
    present?: string[];
    mailer?: Mailer;
    onError?: (error: unknown) => void;
  } = {},
) {
  const sent: MailMessage[] = [];
  const mailer: Mailer =
    options.mailer ??
    ({
      send: (message: MailMessage) => {
        sent.push(message);
        return Promise.resolve({ status: "sent" as const });
      },
    } satisfies Mailer);
  const notifier = new MentionEmailNotifier({
    repository,
    mailer,
    presentUserIds: () => options.present ?? [],
    appBaseUrl: "https://draw.example.test",
    cooldownMinutes: COOLDOWN_MINUTES,
    ...(options.onError ? { onError: options.onError } : {}),
  });
  const notify = (mentions: string[]) =>
    notifier.notify({
      drawingId: DRAWING_ID,
      senderUserId: SENDER_ID,
      senderName: "Ada",
      mentions,
    });
  return { notifier, notify, sent };
}

describe("MentionEmailNotifier", () => {
  it("emails a mentioned member who is away from the drawing", async () => {
    const { notify, sent } = createNotifier(
      fakeRepository([recipient(AWAY_ID)]),
    );

    await notify([AWAY_ID]);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: `${AWAY_ID}@example.test`,
      subject: "Ada mentioned you in “Roadmap”",
    });
    expect(sent[0]?.text).toContain(
      `https://draw.example.test/drawings/${DRAWING_ID}`,
    );
    // The message body must never reach the mail provider.
    expect(sent[0]?.html).not.toContain("hello");
  });

  it("never emails the sender for a self-mention", async () => {
    const repository = fakeRepository([recipient(SENDER_ID)]);
    const findMentionRecipients = vi.spyOn(repository, "findMentionRecipients");
    const { notify, sent } = createNotifier(repository);

    await notify([SENDER_ID]);

    expect(sent).toEqual([]);
    expect(findMentionRecipients).not.toHaveBeenCalled();
  });

  it("skips members present in that drawing's room", async () => {
    const { notify, sent } = createNotifier(
      fakeRepository([recipient(AWAY_ID), recipient(PRESENT_ID)]),
      { present: [PRESENT_ID] },
    );

    await notify([AWAY_ID, PRESENT_ID]);

    expect(sent.map((message) => message.to)).toEqual([
      `${AWAY_ID}@example.test`,
    ]);
  });

  it("skips members who opted out of mention emails", async () => {
    const { notify, sent } = createNotifier(
      fakeRepository([
        recipient(AWAY_ID),
        recipient(OPTED_OUT_ID, { mentionEmails: false }),
      ]),
    );

    await notify([AWAY_ID, OPTED_OUT_ID]);

    expect(sent.map((message) => message.to)).toEqual([
      `${AWAY_ID}@example.test`,
    ]);
  });

  it("sends once per cooldown window and again after it expires", async () => {
    const clock = { nowMs: 0 };
    const { notify, sent } = createNotifier(
      fakeRepository([recipient(AWAY_ID)], clock),
    );

    await notify([AWAY_ID]);
    clock.nowMs += COOLDOWN_MS - 1;
    await notify([AWAY_ID]);
    expect(sent).toHaveLength(1);

    clock.nowMs += 2;
    await notify([AWAY_ID]);
    expect(sent).toHaveLength(2);
  });

  it("does nothing observable when the mailer is disabled", async () => {
    const onError = vi.fn();
    const { notify } = createNotifier(fakeRepository([recipient(AWAY_ID)]), {
      mailer: new DisabledMailer(),
      onError,
    });

    await expect(notify([AWAY_ID])).resolves.toBeUndefined();
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports a repository failure instead of propagating it", async () => {
    const onError = vi.fn();
    const repository = fakeRepository([recipient(AWAY_ID)]);
    repository.findMentionRecipients = () =>
      Promise.reject(new Error("connection terminated"));
    const { notify } = createNotifier(repository, { onError });

    await expect(notify([AWAY_ID])).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("reports a failed delivery and still emails the other recipients", async () => {
    const onError = vi.fn();
    const sent: string[] = [];
    // A real mailer resolves with a failed status; it never rejects.
    const mailer: Mailer = {
      send: (message) => {
        if (message.to === `${AWAY_ID}@example.test`) {
          return Promise.resolve({
            status: "failed" as const,
            reason: "transport" as const,
            retryable: true,
            code: "SMTP_TRANSPORT" as const,
          });
        }
        sent.push(message.to);
        return Promise.resolve({ status: "sent" as const });
      },
    };
    const { notify } = createNotifier(
      fakeRepository([recipient(AWAY_ID), recipient(PRESENT_ID)]),
      { mailer, onError },
    );

    await expect(notify([AWAY_ID, PRESENT_ID])).resolves.toBeUndefined();
    expect(sent).toEqual([`${PRESENT_ID}@example.test`]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toMatchObject({
      name: "MailDeliveryFailed",
    });
  });

  it("rejects a non-positive cooldown at construction", () => {
    expect(
      () =>
        new MentionEmailNotifier({
          repository: fakeRepository([]),
          mailer: new DisabledMailer(),
          presentUserIds: () => [],
          appBaseUrl: "https://draw.example.test",
          cooldownMinutes: 0,
        }),
    ).toThrow(RangeError);
  });
});
