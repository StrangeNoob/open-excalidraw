import type { ExcalidrawElementDTO } from "@open-excalidraw/contracts";

const signature = (element: ExcalidrawElementDTO) =>
  `${element.version}:${element.versionNonce}:${element.isDeleted ? 1 : 0}`;

/** Tracks public element versions without relying on undocumented editor deltas. */
export class ElementVersionFilter {
  readonly #observed = new Map<string, string>();
  readonly #remote = new Map<string, string>();

  seed(elements: readonly ExcalidrawElementDTO[]): void {
    this.#observed.clear();
    this.#remote.clear();
    for (const element of elements) {
      this.#observed.set(element.id, signature(element));
    }
  }

  markRemote(elements: readonly ExcalidrawElementDTO[]): void {
    for (const element of elements) {
      const next = signature(element);
      this.#observed.set(element.id, next);
      this.#remote.set(element.id, next);
    }
  }

  takeLocalChanges(
    elements: readonly ExcalidrawElementDTO[],
  ): ExcalidrawElementDTO[] {
    const changed: ExcalidrawElementDTO[] = [];
    for (const element of elements) {
      const next = signature(element);
      if (this.#observed.get(element.id) === next) {
        continue;
      }
      this.#observed.set(element.id, next);
      const remote = this.#remote.get(element.id);
      this.#remote.delete(element.id);
      if (remote === next) {
        continue;
      }
      changed.push(element);
    }
    return changed;
  }
}
