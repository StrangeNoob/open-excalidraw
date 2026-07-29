import type { ExcalidrawElementDTO } from "@open-excalidraw/contracts";

import { applyEdit, SceneEditError } from "./scene-edit.js";

const stored = (
  overrides: Partial<ExcalidrawElementDTO> & { id: string },
): ExcalidrawElementDTO => ({
  type: "rectangle",
  version: 3,
  versionNonce: 111,
  isDeleted: false,
  index: "a0",
  x: 0,
  y: 0,
  ...overrides,
});

const draft = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  type: "rectangle",
  x: 10,
  y: 20,
  ...overrides,
});

describe("applyEdit indices", () => {
  it("appends new elements after the largest existing index", () => {
    const { elements } = applyEdit(
      [
        stored({ id: "old", index: "a5" }),
        stored({ id: "older", index: "a2" }),
      ],
      { upsert: [draft("one"), draft("two")] },
    );

    expect(elements.map((element) => element.index)).toEqual([
      "a5",
      "a2",
      "a51",
      "a52",
    ]);
  });

  it("pads the suffix so more than nine new elements stay ordered", () => {
    const { elements } = applyEdit([stored({ id: "old", index: "a99" })], {
      upsert: Array.from({ length: 12 }, (_, position) =>
        draft(`new-${position}`),
      ),
    });

    const added = elements.slice(1).map((element) => element.index as string);
    expect(added[0]).toBe("a9901");
    expect(added.at(-1)).toBe("a9912");
    expect([...added].sort()).toEqual(added);
    expect(added.every((index) => index > "a99")).toBe(true);
  });

  it("starts at 'a' when nothing in the scene is indexed", () => {
    const { elements } = applyEdit([stored({ id: "old", index: null })], {
      upsert: [draft("one")],
    });

    expect(elements[1]?.index).toBe("a1");
  });

  it("keeps the stored index of an element it rewrites", () => {
    const { elements } = applyEdit([stored({ id: "box", index: "a7" })], {
      upsert: [draft("box"), draft("pinned", { index: "b0" })],
    });

    expect(elements.map((element) => element.index)).toEqual(["a7", "b0"]);
  });
});

describe("applyEdit versions", () => {
  it("bumps above both the stored and the supplied version", () => {
    const { elements } = applyEdit([stored({ id: "box", version: 9 })], {
      upsert: [draft("box", { version: 2 }), draft("other", { version: 40 })],
    });

    expect(elements[0]?.version).toBe(10);
    expect(elements[1]?.version).toBe(40);
    expect(elements[0]?.versionNonce).not.toBe(111);
    expect(Number.isInteger(elements[0]?.versionNonce)).toBe(true);
  });

  it("starts new elements at version 1", () => {
    const { elements } = applyEdit([], { upsert: [draft("box")] });

    expect(elements[0]?.version).toBe(1);
    expect(elements[0]?.isDeleted).toBe(false);
  });
});

describe("applyEdit deletes", () => {
  it("tombstones rather than dropping, and bumps the version", () => {
    const { elements, unknownDeleteIds } = applyEdit(
      [stored({ id: "box", version: 4 }), stored({ id: "keep" })],
      { deleteIds: ["box"] },
    );

    expect(elements).toHaveLength(2);
    expect(elements[0]).toMatchObject({
      id: "box",
      isDeleted: true,
      version: 5,
    });
    expect(elements[1]?.isDeleted).toBe(false);
    expect(unknownDeleteIds).toEqual([]);
  });

  it("reports unknown ids instead of failing", () => {
    const { elements, unknownDeleteIds } = applyEdit([stored({ id: "box" })], {
      deleteIds: ["ghost", "box", "ghost"],
    });

    expect(unknownDeleteIds).toEqual(["ghost"]);
    expect(elements[0]?.isDeleted).toBe(true);
  });
});

describe("applyEdit validation", () => {
  it("names elements that are missing required fields", () => {
    expect(() =>
      applyEdit([], {
        upsert: [
          { id: "box", type: "rectangle" },
          { type: "ellipse", x: 1 },
        ],
      }),
    ).toThrow(/box is missing x, y; upsert\[1\] is missing id, y/);
  });

  it("rejects a binding to an element that is not in the scene", () => {
    expect(() =>
      applyEdit([stored({ id: "boxA" })], {
        upsert: [
          draft("arrow", {
            type: "arrow",
            startBinding: { elementId: "boxA", focus: 0, gap: 4 },
            endBinding: { elementId: "boxZ", focus: 0, gap: 4 },
          }),
        ],
      }),
    ).toThrow(/arrow\.endBinding -> boxZ/);
  });

  it("rejects a label bound to a missing container", () => {
    expect(() =>
      applyEdit([], { upsert: [draft("label", { containerId: "gone" })] }),
    ).toThrow(SceneEditError);
  });
});
