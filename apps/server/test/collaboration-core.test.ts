import type { ExcalidrawElementDTO } from "@open-excalidraw/contracts";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import {
  createRealtimeRateLimiters,
  reconcileElements,
  ReconciliationLimitError,
  type Clock,
} from "../src/modules/collaboration/core/index.js";

function element(
  id: string,
  version: number,
  versionNonce: number,
  index: string | null,
  extra: Record<string, unknown> = {},
): ExcalidrawElementDTO {
  return {
    id,
    type: "rectangle",
    version,
    versionNonce,
    isDeleted: false,
    index,
    ...extra,
  };
}

describe("collaboration reconciliation", () => {
  it("merges concurrent inserts in fractional-index order independent of input order", () => {
    const left = element("left", 1, 5, "a0");
    const middle = element("middle", 1, 7, "a1");
    const right = element("right", 1, 9, "a2");

    const first = reconcileElements([left], [right, middle]);
    const second = reconcileElements([right], [middle, left]);

    expect(first.elements.map(({ id }) => id)).toEqual([
      "left",
      "middle",
      "right",
    ]);
    expect(second.elements).toEqual(first.elements);
    expect(first.elements.map(({ index }) => index)).toEqual([
      "a0",
      "a1",
      "a2",
    ]);
  });

  it("uses higher versions and then lower nonces deterministically", () => {
    const base = element("same", 4, 90, "a0", { x: 0 });
    const highNonce = element("same", 5, 200, "a0", { x: 200 });
    const lowNonce = element("same", 5, 100, "a0", { x: 100 });

    const forward = reconcileElements([base], [highNonce, lowNonce]);
    const reverse = reconcileElements([base], [lowNonce, highNonce]);

    expect(forward.elements[0]).toMatchObject({ version: 5, x: 100 });
    expect(reverse.elements).toEqual(forward.elements);
    expect(forward.changedElementIds).toEqual(["same"]);
  });

  it("settles reused version and nonce tuples independent of merge direction", () => {
    const left = element("collision", 2, 22, "a0", {
      customData: { z: [2, 1], a: true },
    });
    const right = element("collision", 2, 22, "a0", {
      customData: { a: true, z: [1, 2] },
    });

    const leftFirst = reconcileElements([left], [right]);
    const rightFirst = reconcileElements([right], [left]);

    expect(rightFirst.elements).toEqual(leftFirst.elements);
  });

  it("retains tombstones and rejects resurrection by a stale element", () => {
    const tombstone = element("deleted", 8, 10, "a0", {
      isDeleted: true,
      customData: { retained: true },
    });
    const staleLive = element("deleted", 7, 1, "a0", { x: 999 });

    const result = reconcileElements([tombstone], [staleLive]);

    expect(result.elements).toEqual([tombstone]);
    expect(result.changedElementIds).toEqual([]);
  });

  it("prefers a tombstone when version and nonce are illegally reused", () => {
    const live = element("same-tuple", 3, 17, "a0");
    const tombstone = { ...live, isDeleted: true };

    expect(reconcileElements([live], [tombstone]).elements).toEqual([
      tombstone,
    ]);
    expect(reconcileElements([tombstone], [live]).elements).toEqual([
      tombstone,
    ]);
  });

  it("rejects maliciously deep metadata without recursive stack exhaustion", () => {
    let customData: Record<string, unknown> = { leaf: true };
    for (let depth = 0; depth < 20_000; depth += 1) {
      customData = { next: customData };
    }
    const base = element("deep", 1, 1, "a0", {
      customData: { safe: true },
    });
    const malicious = element("deep", 1, 1, "a0", { customData });

    expect(() => reconcileElements([base], [malicious])).toThrowError(
      ReconciliationLimitError,
    );
  });

  it("validates structural limits for a brand-new element id", () => {
    let customData: Record<string, unknown> = { leaf: true };
    for (let depth = 0; depth < 20_000; depth += 1) {
      customData = { next: customData };
    }
    const malicious = element("brand-new-deep-id", 1, 1, "a0", {
      customData,
    });

    expect(() => reconcileElements([], [malicious])).toThrowError(
      ReconciliationLimitError,
    );
  });

  it("runs in Node and the merge module contains no browser-global access", async () => {
    expect("window" in globalThis).toBe(false);
    expect("document" in globalThis).toBe(false);

    expect(
      reconcileElements([], [element("node", 1, 1, null)]).elements,
    ).toHaveLength(1);

    const source = await readFile(
      new URL(
        "../src/modules/collaboration/core/reconcile.ts",
        import.meta.url,
      ),
      "utf8",
    );
    expect(source).not.toMatch(
      /\b(?:window|document|navigator|localStorage)\b/,
    );
  });
});

describe("collaboration rate limiters", () => {
  it("throttles previews per connection at 100ms", () => {
    const clock = new TestClock();
    const { preview } = createRealtimeRateLimiters(clock);

    expect(preview.tryConsume("socket-a")).toBe(true);
    expect(preview.tryConsume("socket-a")).toBe(false);
    expect(preview.tryConsume("socket-b")).toBe(true);
    clock.advance(99);
    expect(preview.tryConsume("socket-a")).toBe(false);
    clock.advance(1);
    expect(preview.tryConsume("socket-a")).toBe(true);
  });

  it("allows bounded presence bursts and refills deterministically", () => {
    const clock = new TestClock();
    const { presence } = createRealtimeRateLimiters(clock);

    for (let index = 0; index < 30; index += 1) {
      expect(presence.tryConsume("socket-a")).toBe(true);
    }
    expect(presence.tryConsume("socket-a")).toBe(false);
    expect(presence.tryConsume("socket-b")).toBe(true);

    clock.advance(1_000);
    for (let index = 0; index < 15; index += 1) {
      expect(presence.tryConsume("socket-a")).toBe(true);
    }
    expect(presence.tryConsume("socket-a")).toBe(false);
  });
});

class TestClock implements Clock {
  #time = 0;

  public now(): number {
    return this.#time;
  }

  public advance(milliseconds: number): void {
    this.#time += milliseconds;
  }
}
