import type { ExcalidrawElementDTO } from "@open-excalidraw/contracts";

export interface ReconciliationResult {
  /** Canonical elements ordered by their preserved fractional index. */
  elements: ExcalidrawElementDTO[];
  /** Element ids whose canonical value changed. */
  changedElementIds: string[];
}

const MAX_CANONICAL_DEPTH = 512;
const MAX_CANONICAL_NODES = 100_000;
const MAX_CANONICAL_CHARACTERS = 16 * 1_024 * 1_024;

export class ReconciliationLimitError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ReconciliationLimitError";
  }
}

/**
 * Reconciles complete Excalidraw element objects without importing editor or
 * browser code. Element versions are authoritative; version nonces provide a
 * deterministic tie-breaker for concurrent writes of the same version.
 */
export function reconcileElements(
  canonical: readonly ExcalidrawElementDTO[],
  incoming: readonly ExcalidrawElementDTO[],
): ReconciliationResult {
  const before = collapseById(canonical);
  const merged = new Map(before);

  for (const candidate of incoming) {
    const current = merged.get(candidate.id);
    if (!current) {
      assertElementWithinStructuralLimits(candidate);
      merged.set(candidate.id, candidate);
      continue;
    }
    if (compareElementPriority(candidate, current) > 0) {
      assertElementWithinStructuralLimits(candidate);
      merged.set(candidate.id, candidate);
    }
  }

  const changedElementIds = [...merged]
    .filter(([id, element]) => !elementsEqual(before.get(id), element))
    .map(([id]) => id)
    .sort(compareText);

  return {
    elements: [...merged.values()].sort(compareElementOrder),
    changedElementIds,
  };
}

/**
 * Returns a positive value when `candidate` wins over `current`.
 *
 * If a malformed/concurrent client reuses both version and nonce for distinct
 * payloads, a tombstone wins first and a canonical JSON fingerprint settles
 * the remaining tie. That last fallback makes the function commutative while
 * preserving the documented version/nonce rules.
 */
export function compareElementPriority(
  candidate: ExcalidrawElementDTO,
  current: ExcalidrawElementDTO,
): number {
  if (candidate.version !== current.version) {
    return candidate.version > current.version ? 1 : -1;
  }

  if (candidate.versionNonce !== current.versionNonce) {
    return candidate.versionNonce < current.versionNonce ? 1 : -1;
  }

  if (candidate.isDeleted !== current.isDeleted) {
    return candidate.isDeleted ? 1 : -1;
  }

  const candidateFingerprint = stableJson(candidate);
  const currentFingerprint = stableJson(current);
  if (candidateFingerprint === currentFingerprint) {
    return 0;
  }
  return candidateFingerprint < currentFingerprint ? 1 : -1;
}

/** Fractional indices are already lexically sortable; they are never rebuilt. */
export function compareElementOrder(
  left: ExcalidrawElementDTO,
  right: ExcalidrawElementDTO,
): number {
  const leftIndex = left.index ?? null;
  const rightIndex = right.index ?? null;

  if (leftIndex !== rightIndex) {
    if (leftIndex === null) {
      return 1;
    }
    if (rightIndex === null) {
      return -1;
    }
    const indexOrder = compareText(leftIndex, rightIndex);
    if (indexOrder !== 0) {
      return indexOrder;
    }
  }

  return compareText(left.id, right.id);
}

function collapseById(
  elements: readonly ExcalidrawElementDTO[],
): Map<string, ExcalidrawElementDTO> {
  const result = new Map<string, ExcalidrawElementDTO>();
  for (const element of elements) {
    assertElementWithinStructuralLimits(element);
    const current = result.get(element.id);
    if (!current || compareElementPriority(element, current) > 0) {
      result.set(element.id, element);
    }
  }
  return result;
}

function assertElementWithinStructuralLimits(
  element: ExcalidrawElementDTO,
): void {
  stableJson(element);
}

function elementsEqual(
  left: ExcalidrawElementDTO | undefined,
  right: ExcalidrawElementDTO,
): boolean {
  return left !== undefined && stableJson(left) === stableJson(right);
}

function stableJson(value: unknown): string {
  const output: string[] = [];
  const activeObjects = new WeakSet<object>();
  const work: CanonicalTask[] = [{ kind: "value", value, depth: 0 }];
  let characterCount = 0;
  let nodeCount = 0;
  let scheduledNodeCount = 1;

  const append = (text: string) => {
    characterCount += text.length;
    if (characterCount > MAX_CANONICAL_CHARACTERS) {
      throw new ReconciliationLimitError(
        "Element metadata exceeds the canonicalization size limit",
      );
    }
    output.push(text);
  };

  while (work.length > 0) {
    const task = work.pop();
    if (!task) {
      break;
    }
    if (task.kind === "text") {
      append(task.text);
      continue;
    }
    if (task.kind === "exit") {
      activeObjects.delete(task.value);
      continue;
    }

    nodeCount += 1;
    if (nodeCount > MAX_CANONICAL_NODES) {
      throw new ReconciliationLimitError(
        "Element metadata exceeds the canonicalization node limit",
      );
    }
    if (task.depth > MAX_CANONICAL_DEPTH) {
      throw new ReconciliationLimitError(
        "Element metadata exceeds the canonicalization depth limit",
      );
    }

    const current = task.value;
    if (current === null || typeof current !== "object") {
      append(JSON.stringify(current) ?? "null");
      continue;
    }
    if (activeObjects.has(current)) {
      throw new ReconciliationLimitError(
        "Element metadata must not contain circular references",
      );
    }
    activeObjects.add(current);
    work.push({ kind: "exit", value: current });

    if (Array.isArray(current)) {
      scheduledNodeCount += current.length;
      assertCanonicalNodeLimit(scheduledNodeCount);
      append("[");
      work.push({ kind: "text", text: "]" });
      for (let index = current.length - 1; index >= 0; index -= 1) {
        work.push({
          kind: "value",
          value: current[index],
          depth: task.depth + 1,
        });
        if (index > 0) {
          work.push({ kind: "text", text: "," });
        }
      }
      continue;
    }

    append("{");
    work.push({ kind: "text", text: "}" });
    const record = current as Record<string, unknown>;
    const entries = Object.keys(record)
      .map((key) => [key, record[key]] as const)
      .filter(([, child]) => isJsonObjectValue(child))
      .sort(([left], [right]) => compareText(left, right));
    scheduledNodeCount += entries.length;
    assertCanonicalNodeLimit(scheduledNodeCount);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (!entry) {
        continue;
      }
      const [key, child] = entry;
      work.push({ kind: "value", value: child, depth: task.depth + 1 });
      work.push({ kind: "text", text: ":" });
      work.push({ kind: "text", text: JSON.stringify(key) });
      if (index > 0) {
        work.push({ kind: "text", text: "," });
      }
    }
  }

  return output.join("");
}

type CanonicalTask =
  | { kind: "value"; value: unknown; depth: number }
  | { kind: "text"; text: string }
  | { kind: "exit"; value: object };

function isJsonObjectValue(value: unknown): boolean {
  return (
    value !== undefined &&
    typeof value !== "function" &&
    typeof value !== "symbol"
  );
}

function assertCanonicalNodeLimit(nodeCount: number): void {
  if (nodeCount > MAX_CANONICAL_NODES) {
    throw new ReconciliationLimitError(
      "Element metadata exceeds the canonicalization node limit",
    );
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
