export class AssetError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly title: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AssetError";
  }
}

export class AssetTombstoneConflictError extends Error {
  public constructor() {
    super("The asset file ID belongs to a deleted asset");
    this.name = "AssetTombstoneConflictError";
  }
}

export function assetError(
  status: number,
  code: string,
  title: string,
  detail: string,
  options?: ErrorOptions,
) {
  return new AssetError(status, code, title, detail, options);
}
