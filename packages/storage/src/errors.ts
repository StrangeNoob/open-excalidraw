export type StorageErrorCode =
  | "INVALID_STORAGE_KEY"
  | "STORAGE_NOT_FOUND"
  | "STORAGE_CONFLICT"
  | "STORAGE_INTEGRITY_ERROR"
  | "STORAGE_SIZE_LIMIT"
  | "STORAGE_IO_ERROR";

export class StorageError extends Error {
  public readonly code: StorageErrorCode;

  public constructor(
    code: StorageErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "StorageError";
    this.code = code;
  }
}

export class InvalidStorageKeyError extends StorageError {
  public constructor(message = "The storage key is invalid") {
    super("INVALID_STORAGE_KEY", message);
    this.name = "InvalidStorageKeyError";
  }
}

export class StorageNotFoundError extends StorageError {
  public readonly key: string;

  public constructor(key: string) {
    super("STORAGE_NOT_FOUND", `Storage object not found: ${key}`);
    this.name = "StorageNotFoundError";
    this.key = key;
  }
}

export class StorageConflictError extends StorageError {
  public readonly key: string;

  public constructor(key: string) {
    super(
      "STORAGE_CONFLICT",
      `A different object already exists at storage key: ${key}`,
    );
    this.name = "StorageConflictError";
    this.key = key;
  }
}

export class StorageIntegrityError extends StorageError {
  public constructor() {
    super(
      "STORAGE_INTEGRITY_ERROR",
      "The stored object does not match the expected SHA-256 digest",
    );
    this.name = "StorageIntegrityError";
  }
}

export class StorageSizeLimitError extends StorageError {
  public readonly limit: number;

  public constructor(limit: number) {
    super(
      "STORAGE_SIZE_LIMIT",
      `The storage object exceeds the ${limit}-byte limit`,
    );
    this.name = "StorageSizeLimitError";
    this.limit = limit;
  }
}

export class StorageIoError extends StorageError {
  public constructor(operation: string, options?: ErrorOptions) {
    super(
      "STORAGE_IO_ERROR",
      `The storage ${operation} operation failed`,
      options,
    );
    this.name = "StorageIoError";
  }
}
