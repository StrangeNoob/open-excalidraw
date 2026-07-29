import { randomInt } from "node:crypto";

import type { ExcalidrawElementDTO } from "@open-excalidraw/contracts";

/** Raised before anything is saved; the message names the offending elements. */
export class SceneEditError extends Error {
  public readonly code = "INVALID_ELEMENTS";

  public constructor(message: string) {
    super(message);
    this.name = "SceneEditError";
  }
}

export interface SceneEdit {
  upsert?: readonly Record<string, unknown>[];
  deleteIds?: readonly string[];
}

export interface AppliedSceneEdit {
  elements: ExcalidrawElementDTO[];
  unknownDeleteIds: string[];
}

/**
 * Merges caller-supplied elements into a scene the way the reconciler expects:
 * every touched element gets a version above the one already stored, deletes
 * become tombstones rather than omissions, and anything without a fractional
 * index is placed after the current maximum (a missing index sorts last, so
 * leaving it unset would silently reorder the scene).
 */
export function applyEdit(
  current: readonly ExcalidrawElementDTO[],
  edit: SceneEdit,
): AppliedSceneEdit {
  const upsert = edit.upsert ?? [];
  assertRequiredFields(upsert);

  const elements = new Map(current.map((element) => [element.id, element]));
  const touched: ExcalidrawElementDTO[] = [];
  const awaitingIndex: ExcalidrawElementDTO[] = [];

  for (const raw of upsert) {
    const id = raw.id as string;
    const existing = elements.get(id);
    const element: ExcalidrawElementDTO = {
      ...raw,
      id,
      type: raw.type as string,
      version: existing
        ? Math.max(existing.version, integerOr(raw.version, 0)) + 1
        : integerOr(raw.version, 1),
      versionNonce: randomNonce(),
      isDeleted: raw.isDeleted === true,
      index:
        typeof raw.index === "string" ? raw.index : (existing?.index ?? null),
    };
    elements.set(id, element);
    touched.push(element);
    if (element.index === null) awaitingIndex.push(element);
  }

  assignIndicesAfterMaximum(awaitingIndex, elements.values());

  const unknownDeleteIds: string[] = [];
  for (const id of new Set(edit.deleteIds ?? [])) {
    const element = elements.get(id);
    if (!element) {
      unknownDeleteIds.push(id);
      continue;
    }
    elements.set(id, {
      ...element,
      isDeleted: true,
      version: element.version + 1,
      versionNonce: randomNonce(),
    });
  }

  assertReferencesResolve(touched, elements);
  return { elements: [...elements.values()], unknownDeleteIds };
}

/**
 * Appends to the largest existing index: a string with another as its prefix
 * always sorts after it, and the fixed, zero-padded width keeps the new
 * elements in order among themselves ("a99" + "10" would otherwise precede
 * "a99" + "9").
 */
function assignIndicesAfterMaximum(
  pending: readonly ExcalidrawElementDTO[],
  scene: Iterable<ExcalidrawElementDTO>,
): void {
  if (pending.length === 0) return;
  let base = "a";
  for (const element of scene) {
    if (typeof element.index === "string" && element.index > base) {
      base = element.index;
    }
  }
  const width = String(pending.length).length;
  pending.forEach((element, position) => {
    element.index = `${base}${String(position + 1).padStart(width, "0")}`;
  });
}

function assertRequiredFields(
  upsert: readonly Record<string, unknown>[],
): void {
  const problems: string[] = [];
  upsert.forEach((raw, position) => {
    const missing = (["id", "type", "x", "y"] as const).filter((field) =>
      field === "id" || field === "type"
        ? typeof raw[field] !== "string" || raw[field].length === 0
        : !Number.isFinite(raw[field]),
    );
    if (missing.length > 0) {
      const label =
        typeof raw.id === "string" && raw.id.length > 0
          ? raw.id
          : `upsert[${position}]`;
      problems.push(`${label} is missing ${missing.join(", ")}`);
    }
  });
  if (problems.length > 0) {
    throw new SceneEditError(`Invalid elements: ${problems.join("; ")}`);
  }
}

function assertReferencesResolve(
  touched: readonly ExcalidrawElementDTO[],
  scene: ReadonlyMap<string, ExcalidrawElementDTO>,
): void {
  const problems: string[] = [];
  const live = (id: string) => scene.get(id)?.isDeleted === false;
  for (const element of touched) {
    // A tombstone's references are dead weight, not constraints.
    if (element.isDeleted) continue;
    for (const field of ["startBinding", "endBinding"] as const) {
      const target = (element[field] as { elementId?: unknown } | null)
        ?.elementId;
      if (typeof target === "string" && !live(target)) {
        problems.push(`${element.id}.${field} -> ${target}`);
      }
    }
    if (typeof element.containerId === "string" && !live(element.containerId)) {
      problems.push(`${element.id}.containerId -> ${element.containerId}`);
    }
  }
  if (problems.length > 0) {
    throw new SceneEditError(
      `Elements reference ids that are missing or deleted: ${problems.join("; ")}`,
    );
  }
}

function integerOr(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : fallback;
}

const randomNonce = () => randomInt(2 ** 31);
