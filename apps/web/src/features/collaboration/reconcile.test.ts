import type { ExcalidrawElementDTO } from "@open-excalidraw/contracts";

import { reconcileClientElements } from "./reconcile";

const element = (
  customData: Record<string, unknown>,
): ExcalidrawElementDTO => ({
  customData,
  id: "element",
  isDeleted: false,
  type: "rectangle",
  version: 2,
  versionNonce: 10,
});

describe("reconcileClientElements", () => {
  it("uses deeply sorted nested custom data for deterministic equal-version ties", () => {
    const first = element({
      nested: { alpha: 1, winner: "first" },
      zeta: true,
    });
    const second = element({
      nested: { alpha: 1, winner: "second" },
      zeta: true,
    });

    const forward = reconcileClientElements([first], [second]);
    const reverse = reconcileClientElements([second], [first]);

    expect(forward).toEqual(reverse);
    expect(forward[0]?.customData).toHaveProperty("nested.winner");
  });
});
