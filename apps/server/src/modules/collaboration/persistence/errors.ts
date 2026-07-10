export type MutationPersistenceErrorCode =
  | "FUTURE_REVISION"
  | "MUTATION_ID_MISMATCH"
  | "MISSING_ASSET"
  | "ELEMENT_LIMIT_EXCEEDED"
  | "ASSET_LIMIT_EXCEEDED"
  | "SCENE_TOO_LARGE";

export class MutationPersistenceError extends Error {
  public constructor(
    public readonly code: MutationPersistenceErrorCode,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "MutationPersistenceError";
  }
}
