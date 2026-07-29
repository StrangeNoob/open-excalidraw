import { randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  drawingTitleSchema,
  uuidSchema,
  type DrawingSummary,
  type ExcalidrawElementDTO,
} from "@open-excalidraw/contracts";
import { z } from "zod";

import { ContentDomainError } from "../content/errors.js";
import type { ContentService } from "../content/service.js";
import { DrawingDomainError } from "../drawings/errors.js";
import type { DrawingService } from "../drawings/service.js";
import { SharingDomainError } from "../sharing/errors.js";
import type { SharingService } from "../sharing/service.js";
import { applyEdit, SceneEditError } from "./scene-edit.js";

export interface McpServices {
  drawings: DrawingService;
  content: ContentService;
  sharing: SharingService;
  publicBaseUrl: string;
  /** Receives errors the tool layer cannot describe to the caller. */
  logError?: (
    event: string,
    error: unknown,
    context?: Record<string, unknown>,
  ) => void;
}

// One re-read plus three retries: past that the drawing is being edited faster
// than an agent can rebase, and saying so beats looping.
const MAX_SAVE_ATTEMPTS = 4;

const elementSchema = z.record(z.string(), z.unknown());

export function createMcpServer(
  services: McpServices,
  userId: string,
  auditRequestId?: string,
): McpServer {
  const server = new McpServer({
    name: "open-excalidraw",
    title: "Open Excalidraw",
    version: "1.1.0",
  });
  const url = (drawingId: string) =>
    `${services.publicBaseUrl}/drawings/${drawingId}`;
  const run = async (
    action: () => Promise<unknown>,
  ): Promise<CallToolResult> => {
    try {
      return text(JSON.stringify(await action()));
    } catch (error) {
      if (!isDescribable(error)) {
        services.logError?.("mcp.tool_failed", error, {
          requestId: auditRequestId,
        });
      }
      return { ...text(describe(error)), isError: true };
    }
  };

  server.registerTool(
    "read_format",
    {
      title: "Element format reference",
      description:
        "The Excalidraw element-JSON rules for authoring elements: shapes, " +
        "labels, arrow bindings, z-order and versioning. Read this before the " +
        "first edit_scene call in a session.",
    },
    () => text(ELEMENT_FORMAT),
  );

  server.registerTool(
    "list_drawings",
    {
      title: "List drawings",
      description:
        "Drawings the user can open. With `search`, only those whose canvas " +
        "text matches, most relevant first (titles are not searched).",
      inputSchema: { search: z.string().trim().min(1).max(200).optional() },
    },
    ({ search }) =>
      run(async () => {
        // nextCursor is always null today; page through it here if list
        // pagination ever activates.
        const { owned, shared } = await services.drawings.list(userId);
        const accessible = [...owned, ...shared];
        if (!search) return accessible.map(toListEntry);
        const { drawingIds } = await services.drawings.search(userId, search);
        const byId = new Map(accessible.map((entry) => [entry.id, entry]));
        return drawingIds.flatMap((drawingId) => {
          const entry = byId.get(drawingId);
          return entry ? [toListEntry(entry)] : [];
        });
      }),
  );

  server.registerTool(
    "create_drawing",
    {
      title: "Create a drawing",
      description: "Creates an empty drawing owned by the user.",
      inputSchema: { title: drawingTitleSchema },
    },
    ({ title }) =>
      run(async () => {
        const drawing = await services.drawings.create(userId, {
          id: randomUUID(),
          title,
          idempotencyKey: randomUUID(),
        });
        return { drawingId: drawing.id, url: url(drawing.id) };
      }),
  );

  server.registerTool(
    "get_scene",
    {
      title: "Read a scene",
      description:
        "Every element of a drawing, including tombstones (isDeleted: true).",
      inputSchema: { drawingId: uuidSchema },
    },
    ({ drawingId }) =>
      run(async () => {
        const content = await services.content.load(userId, drawingId);
        return {
          revision: content.revision,
          elements: content.scene.elements,
          url: url(drawingId),
        };
      }),
  );

  server.registerTool(
    "edit_scene",
    {
      title: "Edit a scene",
      description:
        "Adds or replaces the elements in `upsert` and tombstones the ids in " +
        "`deleteIds`, leaving the rest of the scene untouched. Element " +
        "versions, nonces and missing z-order indices are filled in for you, " +
        "and a concurrent save is rebased on automatically. Send one call per " +
        "logical change, not one per element. `elementCount` counts the live " +
        "elements left in the scene.",
      inputSchema: {
        drawingId: uuidSchema,
        upsert: z.array(elementSchema).optional(),
        deleteIds: z.array(z.string().min(1)).optional(),
      },
    },
    ({ drawingId, upsert, deleteIds }) =>
      run(async () => {
        for (let attempt = 1; ; attempt += 1) {
          const content = await services.content.load(userId, drawingId);
          const applied = applyEdit(content.scene.elements, {
            ...(upsert ? { upsert } : {}),
            ...(deleteIds ? { deleteIds } : {}),
          });
          try {
            // A fresh mutation id per attempt: the rebased payload differs, and
            // replaying the previous key would be an idempotency mismatch.
            const saved = await services.content.save(
              userId,
              drawingId,
              BigInt(content.revision),
              randomUUID(),
              {
                scene: { ...content.scene, elements: applied.elements },
                assetIds: referencedAssetIds(applied.elements),
              },
              auditRequestId,
            );
            return {
              revision: saved.revision,
              elementCount: applied.elements.filter(
                (element) => !element.isDeleted,
              ).length,
              unknownDeleteIds: applied.unknownDeleteIds,
              url: url(drawingId),
            };
          } catch (error) {
            if (
              attempt >= MAX_SAVE_ATTEMPTS ||
              !(error instanceof ContentDomainError) ||
              error.code !== "VERSION_CONFLICT"
            ) {
              throw error;
            }
          }
        }
      }),
  );

  server.registerTool(
    "share_drawing",
    {
      title: "Share a drawing",
      description:
        "Mints a public read-only link. Every call rotates the token, so any " +
        "link handed out earlier stops working.",
      inputSchema: { drawingId: uuidSchema },
    },
    ({ drawingId }) =>
      run(async () => ({
        url: (await services.sharing.createShareLink(userId, drawingId)).url,
      })),
  );

  return server;
}

const toListEntry = (drawing: DrawingSummary) => ({
  drawingId: drawing.id,
  title: drawing.title,
  updatedAt: drawing.updatedAt,
});

function referencedAssetIds(elements: readonly ExcalidrawElementDTO[]) {
  const fileIds = new Set<string>();
  for (const element of elements) {
    if (typeof element.fileId === "string" && element.fileId.length > 0) {
      fileIds.add(element.fileId);
    }
  }
  return [...fileIds].sort();
}

const text = (value: string): CallToolResult => ({
  content: [{ type: "text", text: value }],
});

function isDescribable(error: unknown): boolean {
  return (
    error instanceof ContentDomainError ||
    error instanceof DrawingDomainError ||
    error instanceof SharingDomainError ||
    error instanceof SceneEditError ||
    error instanceof z.ZodError
  );
}

function describe(error: unknown): string {
  if (
    error instanceof ContentDomainError ||
    error instanceof DrawingDomainError ||
    error instanceof SharingDomainError
  ) {
    return `${error.code}: ${error.message}${error.detail ? ` ${error.detail}` : ""}`;
  }
  if (error instanceof SceneEditError) {
    return `${error.code}: ${error.message}`;
  }
  if (error instanceof z.ZodError) {
    const issue = error.issues[0];
    const path = issue?.path.join(".") || "scene";
    return `INVALID_ELEMENTS: ${path}: ${issue?.message ?? "invalid"}`;
  }
  return "INTERNAL_ERROR: The request could not be completed";
}

const ELEMENT_FORMAT = `Elements are plain Excalidraw JSON. edit_scene handles versions,
version nonces, z-order indices, tombstones and concurrent saves — send the
elements you want and nothing else.

Required on every element: id (any stable string), type, x, y. Everything else
Excalidraw expects passes through unvalidated, and omitting it renders wrong:
width, height, angle, strokeColor, backgroundColor, fillStyle, strokeWidth,
strokeStyle, roughness, opacity, seed, groupIds, boundElements, link, locked.

Z-order: elements sort by the string field "index", not by array order, and
missing indices sort last. Omit index and new elements are appended after
everything currently in the scene, in the order you listed them. Supply index
yourself only to interleave with existing elements: any string that has an
existing index as its prefix sorts directly after it ("a5" < "a51" < "a52").

Versioning: omit version and versionNonce. Both are rewritten so the edit wins
over the stored element. Two writers changing the same element is
last-write-wins, so leave alone anything the user may be dragging right now.

Deleting: pass ids to deleteIds. They stay in the scene as tombstones — never
drop an element by omitting it, a live editor's pending copy would re-add it.
Ids that are not in the scene come back in unknownDeleteIds.

Arrows: bind both ends and mirror the binding on the shapes.
  "startBinding": {"elementId": "boxA", "focus": 0, "gap": 4}
  "endBinding":   {"elementId": "boxB", "focus": 0, "gap": 4}
and on each shape: "boundElements": [{"id": "arrow1", "type": "arrow"}].
Set "startArrowhead": null and "endArrowhead": "arrow" on the arrow element,
or it renders as a bare line.
Bindings do not move geometry: x, y and points must already reach from one
shape's edge to the other's. Referencing an id that is not in the scene is
rejected.

Labels are separate centred text elements, not container text:
  width  ~ 0.6 * fontSize * characters      height ~ 1.25 * fontSize
  x = shape.x + (shape.width  - width)  / 2
  y = shape.y + (shape.height - height) / 2
with textAlign "center", verticalAlign "middle", containerId null,
fontFamily 3, fontSize 16, lineHeight 1.25, and originalText equal to text.
List labels after their shapes so they draw on top.

Defaults that read well: roughness 0, opacity 100, strokeWidth 2, rounded
boxes ("roundness": {"type": 3}), boxes near 180x90 with 80-120px gaps, flow
left to right or top to bottom, small consistent palette.

Limits: 50,000 elements and 10 MiB of scene JSON per drawing.`;
