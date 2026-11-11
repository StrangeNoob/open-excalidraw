import type { ExcalidrawElementDTO } from "@open-excalidraw/contracts";

export const reconcileClientElements = (
  canonical: readonly ExcalidrawElementDTO[],
  incoming: readonly ExcalidrawElementDTO[],
): ExcalidrawElementDTO[] => {
  const merged = new Map(canonical.map((element) => [element.id, element]));
  for (const candidate of incoming) {
    const current = merged.get(candidate.id);
    if (!current || comparePriority(candidate, current) > 0) {
      merged.set(candidate.id, candidate);
    }
  }
  return [...merged.values()].sort(compareOrder);
};

export const changedAfterRebase = (
  canonical: readonly ExcalidrawElementDTO[],
  incoming: readonly ExcalidrawElementDTO[],
): ExcalidrawElementDTO[] => {
  const before = new Map(canonical.map((element) => [element.id, element]));
  return reconcileClientElements(canonical, incoming).filter((element) => {
    const current = before.get(element.id);
    return !current || stable(element) !== stable(current);
  });
};

const comparePriority = (
  candidate: ExcalidrawElementDTO,
  current: ExcalidrawElementDTO,
) => {
  if (candidate.version !== current.version) {
    return candidate.version > current.version ? 1 : -1;
  }
  if (candidate.versionNonce !== current.versionNonce) {
    return candidate.versionNonce < current.versionNonce ? 1 : -1;
  }
  if (candidate.isDeleted !== current.isDeleted) {
    return candidate.isDeleted ? 1 : -1;
  }
  const candidateStable = stable(candidate);
  const currentStable = stable(current);
  return candidateStable === currentStable
    ? 0
    : candidateStable < currentStable
      ? 1
      : -1;
};

const compareOrder = (
  left: ExcalidrawElementDTO,
  right: ExcalidrawElementDTO,
) => {
  const leftIndex = left.index ?? null;
  const rightIndex = right.index ?? null;
  if (leftIndex !== rightIndex) {
    if (leftIndex === null) return 1;
    if (rightIndex === null) return -1;
    if (leftIndex !== rightIndex) return leftIndex < rightIndex ? -1 : 1;
  }
  return left.id.localeCompare(right.id);
};

const stable = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stable).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
    .join(",")}}`;
};
