export interface Clock {
  now(): number;
}

const systemClock: Clock = { now: () => Date.now() };

/** A deterministic, per-key minimum-interval limiter with no burst allowance. */
export class MinimumIntervalRateLimiter {
  readonly #minimumIntervalMs: number;
  readonly #clock: Clock;
  readonly #lastAcceptedAt = new Map<string, number>();

  public constructor(minimumIntervalMs: number, clock: Clock = systemClock) {
    assertPositiveFinite(minimumIntervalMs, "minimumIntervalMs");
    this.#minimumIntervalMs = minimumIntervalMs;
    this.#clock = clock;
  }

  public tryConsume(key: string): boolean {
    const now = this.#clock.now();
    const previous = this.#lastAcceptedAt.get(key);
    if (previous !== undefined && now - previous < this.#minimumIntervalMs) {
      return false;
    }
    this.#lastAcceptedAt.set(key, now);
    return true;
  }

  public delete(key: string): void {
    this.#lastAcceptedAt.delete(key);
  }

  public clear(): void {
    this.#lastAcceptedAt.clear();
  }
}

export interface TokenBucketOptions {
  capacity: number;
  refillTokensPerSecond: number;
  clock?: Clock;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/** A per-key token bucket suitable for burst-tolerant ephemeral presence. */
export class TokenBucketRateLimiter {
  readonly #capacity: number;
  readonly #refillPerMillisecond: number;
  readonly #clock: Clock;
  readonly #buckets = new Map<string, Bucket>();

  public constructor(options: TokenBucketOptions) {
    assertPositiveFinite(options.capacity, "capacity");
    assertPositiveFinite(
      options.refillTokensPerSecond,
      "refillTokensPerSecond",
    );
    this.#capacity = options.capacity;
    this.#refillPerMillisecond = options.refillTokensPerSecond / 1_000;
    this.#clock = options.clock ?? systemClock;
  }

  public tryConsume(key: string, cost = 1): boolean {
    assertPositiveFinite(cost, "cost");
    if (cost > this.#capacity) {
      return false;
    }

    const now = this.#clock.now();
    const existing = this.#buckets.get(key);
    const elapsed = existing ? Math.max(0, now - existing.updatedAt) : 0;
    const available = existing
      ? Math.min(
          this.#capacity,
          existing.tokens + elapsed * this.#refillPerMillisecond,
        )
      : this.#capacity;

    if (available < cost) {
      this.#buckets.set(key, { tokens: available, updatedAt: now });
      return false;
    }

    this.#buckets.set(key, { tokens: available - cost, updatedAt: now });
    return true;
  }

  public delete(key: string): void {
    this.#buckets.delete(key);
  }

  public clear(): void {
    this.#buckets.clear();
  }
}

export interface RealtimeRateLimiters {
  preview: MinimumIntervalRateLimiter;
  presence: TokenBucketRateLimiter;
}

export function createRealtimeRateLimiters(
  clock: Clock = systemClock,
): RealtimeRateLimiters {
  return {
    preview: new MinimumIntervalRateLimiter(100, clock),
    presence: new TokenBucketRateLimiter({
      capacity: 30,
      refillTokensPerSecond: 15,
      clock,
    }),
  };
}

function assertPositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive finite number`);
  }
}
