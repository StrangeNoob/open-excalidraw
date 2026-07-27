import { renderMentionEmail, type Mailer } from "@open-excalidraw/mail";

import type { MentionNotificationRepository } from "./types.js";

export interface MentionEmailNotifierOptions {
  repository: MentionNotificationRepository;
  mailer: Mailer;
  /** Ids present in that drawing's room; presence elsewhere never suppresses. */
  presentUserIds: (drawingId: string) => string[];
  appBaseUrl: string;
  cooldownMinutes: number;
  heroImageUrl?: string;
  /** Reports a swallowed failure; delivery never fails the chat message. */
  onError?: (error: unknown) => void;
}

/**
 * Emails members who were mentioned while away from the drawing. Suppression
 * runs cheapest-first — sender, then presence (in memory), then the opt-out
 * and the cooldown claim (one database round trip each) — so the common case
 * of mentioning someone who is right there costs nothing.
 */
export class MentionEmailNotifier {
  readonly #repository: MentionNotificationRepository;
  readonly #mailer: Mailer;
  readonly #presentUserIds: (drawingId: string) => string[];
  readonly #appBaseUrl: URL;
  readonly #cooldownMinutes: number;
  readonly #heroImageUrl: string | undefined;
  readonly #onError: (error: unknown) => void;

  public constructor(options: MentionEmailNotifierOptions) {
    this.#repository = options.repository;
    this.#mailer = options.mailer;
    this.#presentUserIds = options.presentUserIds;
    this.#appBaseUrl = new URL(options.appBaseUrl);
    this.#cooldownMinutes = options.cooldownMinutes;
    if (
      !Number.isSafeInteger(this.#cooldownMinutes) ||
      this.#cooldownMinutes <= 0
    ) {
      throw new RangeError("cooldownMinutes must be a positive integer");
    }
    this.#heroImageUrl = options.heroImageUrl;
    this.#onError = options.onError ?? (() => {});
  }

  /** Never rejects: every failure is reported through onError and dropped. */
  public async notify(input: {
    drawingId: string;
    senderUserId: string;
    senderName: string;
    mentions: string[];
  }): Promise<void> {
    try {
      const present = new Set(this.#presentUserIds(input.drawingId));
      const candidates = input.mentions.filter(
        (userId) => userId !== input.senderUserId && !present.has(userId),
      );
      if (candidates.length === 0) return;

      const recipients = (
        await this.#repository.findMentionRecipients({
          drawingId: input.drawingId,
          userIds: candidates,
        })
      ).filter((recipient) => recipient.mentionEmails);
      if (recipients.length === 0) return;

      const claimed = new Set(
        await this.#repository.claimMentionEmailCooldown({
          drawingId: input.drawingId,
          userIds: recipients.map((recipient) => recipient.userId),
          cooldownMinutes: this.#cooldownMinutes,
        }),
      );
      const drawingUrl = new URL(
        `/drawings/${encodeURIComponent(input.drawingId)}`,
        this.#appBaseUrl,
      ).toString();

      for (const recipient of recipients) {
        if (!claimed.has(recipient.userId)) continue;
        const message = renderMentionEmail({
          to: recipient.email,
          drawingUrl,
          senderName: input.senderName,
          drawingTitle: recipient.drawingTitle,
          ...(this.#heroImageUrl ? { heroImageUrl: this.#heroImageUrl } : {}),
        });
        // Per recipient, so one rejected address cannot skip the rest. The
        // mailer reports a delivery failure by resolving rather than
        // rejecting, so the result is inspected too; "disabled" is a
        // deployment choice, not a fault.
        const delivery = await this.#mailer
          .send(message)
          .catch((error: unknown) => {
            this.#onError(error);
            return null;
          });
        if (delivery?.status === "failed") {
          const failure = new Error(`mention email ${delivery.code}`);
          failure.name = "MailDeliveryFailed";
          this.#onError(failure);
        }
      }
    } catch (error) {
      this.#onError(error);
    }
  }
}
