import { describe, expect, it } from "vitest";

import {
  clientRealtimeEventSchema,
  createDrawingRequestSchema,
  createInvitationRequestSchema,
  problemDetailsSchema,
  revisionSchema,
  roleSchema,
  sceneEnvelopeSchema,
  serverRealtimeEventSchema,
} from "../src";

const drawingId = "a0d1c2e3-f456-4789-a012-3456789abcde";
const clientInstanceId = "b0d1c2e3-f456-4789-a012-3456789abcde";
const mutationId = "c0d1c2e3-f456-4789-a012-3456789abcde";

const element = {
  id: "element-1",
  type: "rectangle",
  version: 1,
  versionNonce: 42,
  isDeleted: false,
  index: "a0",
  customData: { preserved: true },
};

const scene = {
  type: "excalidraw" as const,
  version: 2,
  source: "https://example.com",
  elements: [element],
  appState: { viewBackgroundColor: "#ffffff" },
};

describe("common contracts", () => {
  it("accepts roles and decimal revisions", () => {
    expect(roleSchema.parse("owner")).toBe("owner");
    expect(revisionSchema.parse("9007199254740993")).toBe("9007199254740993");
  });

  it("rejects invalid roles and unsafe revision representations", () => {
    expect(roleSchema.safeParse("admin").success).toBe(false);
    expect(revisionSchema.safeParse(1).success).toBe(false);
    expect(revisionSchema.safeParse("01").success).toBe(false);
  });

  it("requires stable problem detail fields", () => {
    expect(
      problemDetailsSchema.parse({
        code: "VERSION_CONFLICT",
        status: 412,
        title: "The drawing changed",
        requestId: "request-1",
      }),
    ).toMatchObject({ code: "VERSION_CONFLICT", status: 412 });
  });
});

describe("scene contracts", () => {
  it("preserves unknown element fields", () => {
    const parsed = sceneEnvelopeSchema.parse(scene);

    expect(parsed.elements[0]?.customData).toEqual({ preserved: true });
  });

  it("rejects embedded binary files", () => {
    expect(
      sceneEnvelopeSchema.safeParse({ ...scene, files: { file: "data" } })
        .success,
    ).toBe(false);
  });
});

describe("drawing and sharing contracts", () => {
  it("normalizes a drawing title and validates invitations", () => {
    expect(
      createDrawingRequestSchema.parse({ title: "  Architecture  " }).title,
    ).toBe("Architecture");
    expect(
      createInvitationRequestSchema.parse({
        email: "person@example.com",
        role: "editor",
      }),
    ).toEqual({ email: "person@example.com", role: "editor" });
  });
});

describe("realtime contracts", () => {
  it("parses client join and mutation events", () => {
    expect(
      clientRealtimeEventSchema.parse({
        type: "room.join",
        protocolVersion: 1,
        drawingId,
        clientInstanceId,
        lastRevision: "0",
      }).type,
    ).toBe("room.join");

    expect(
      clientRealtimeEventSchema.parse({
        type: "scene.mutate",
        mutationId,
        baseRevision: "1",
        elements: [element],
      }).type,
    ).toBe("scene.mutate");
  });

  it("parses a canonical committed event", () => {
    expect(
      serverRealtimeEventSchema.parse({
        type: "scene.committed",
        mutationId,
        revision: "2",
        elements: [element],
      }).type,
    ).toBe("scene.committed");
  });

  it("rejects unknown event types and numeric revisions", () => {
    expect(
      clientRealtimeEventSchema.safeParse({ type: "scene.unknown" }).success,
    ).toBe(false);
    expect(
      clientRealtimeEventSchema.safeParse({
        type: "scene.mutate",
        mutationId,
        baseRevision: 1,
        elements: [element],
      }).success,
    ).toBe(false);
  });
});
