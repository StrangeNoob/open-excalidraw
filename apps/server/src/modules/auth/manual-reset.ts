export interface ManualResetLink {
  userId: string;
  email: string;
  url: string;
  expiresAt: Date;
  reason: "mail-disabled" | "mail-failed";
}

/**
 * Administrative boundary for reset links that could not be delivered.
 * Implementations must never log or return the link from the public forgot-
 * password endpoint.
 */
export interface ManualResetLinkSink {
  publish(link: ManualResetLink): Promise<void>;
}

export interface ManualResetLinkSource {
  consume(email: string, now?: Date): ManualResetLink | null;
}

export class DisabledManualResetLinkSink implements ManualResetLinkSink {
  public publish(link: ManualResetLink): Promise<void> {
    void link;
    return Promise.resolve();
  }
}

/**
 * Small single-process implementation suitable for an administrative command
 * boundary. Production composition can replace it with a protected store.
 */
export class OneTimeManualResetLinkStore
  implements ManualResetLinkSink, ManualResetLinkSource
{
  readonly #links = new Map<string, ManualResetLink>();

  public publish(link: ManualResetLink): Promise<void> {
    this.#links.set(normalizeEmail(link.email), link);
    return Promise.resolve();
  }

  public consume(
    email: string,
    now: Date = new Date(),
  ): ManualResetLink | null {
    const key = normalizeEmail(email);
    const link = this.#links.get(key);
    this.#links.delete(key);

    if (!link || link.expiresAt <= now) {
      return null;
    }

    return link;
  }
}

const normalizeEmail = (email: string): string => email.trim().toLowerCase();
