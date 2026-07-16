import type {
  BinaryFileData,
  BinaryFiles,
  DataURL,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import {
  assetMetadataSchema,
  type AssetMetadata,
} from "@open-excalidraw/contracts";

export interface AssetClientOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  sha256?: (bytes: Uint8Array) => Promise<string>;
}

export class AssetRequestError extends Error {
  constructor(
    readonly status: number,
    readonly fileId: string,
    operation: "delete" | "download" | "upload",
  ) {
    super(`Asset ${fileId} ${operation} failed (${status})`);
    this.name = "AssetRequestError";
  }
}

export class AssetClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #sha256: (bytes: Uint8Array) => Promise<string>;

  constructor({
    baseUrl = "/api/v1",
    fetch = globalThis.fetch.bind(globalThis),
    sha256 = digestSha256,
  }: AssetClientOptions = {}) {
    this.#baseUrl = baseUrl.replace(/\/$/, "");
    this.#fetch = fetch;
    this.#sha256 = sha256;
  }

  async upload(
    drawingId: string,
    file: BinaryFileData,
    signal?: AbortSignal,
  ): Promise<AssetMetadata> {
    const bytes = dataUrlBytes(file.dataURL);
    const response = await this.#fetch(this.#url(drawingId, file.id), {
      body: bytes.slice().buffer,
      credentials: "include",
      headers: {
        "content-type": file.mimeType,
        "x-content-sha256": await this.#sha256(bytes),
        ...(file.version === undefined
          ? {}
          : { "x-excalidraw-file-version": String(file.version) }),
      },
      method: "PUT",
      signal,
    });
    if (!response.ok) {
      throw new AssetRequestError(response.status, file.id, "upload");
    }
    return assetMetadataSchema.parse(await response.json());
  }

  async download(
    drawingId: string,
    fileId: string,
    signal?: AbortSignal,
  ): Promise<BinaryFileData> {
    const response = await this.#fetch(this.#url(drawingId, fileId), {
      credentials: "include",
      headers: { accept: "image/*" },
      signal,
    });
    if (!response.ok) {
      throw new AssetRequestError(response.status, fileId, "download");
    }
    const blob = await response.blob();
    return {
      created: Date.now(),
      dataURL: await blobToDataUrl(blob),
      id: fileId as BinaryFileData["id"],
      mimeType: (blob.type ||
        response.headers.get("content-type") ||
        "application/octet-stream") as BinaryFileData["mimeType"],
    };
  }

  async uploadThumbnail(
    drawingId: string,
    blob: Blob,
    signal?: AbortSignal,
  ): Promise<void> {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const response = await this.#fetch(this.#thumbnailUrl(drawingId), {
      body: bytes.slice().buffer,
      credentials: "include",
      headers: {
        "content-type": "image/png",
        "x-content-sha256": await this.#sha256(bytes),
      },
      method: "PUT",
      signal,
    });
    if (!response.ok) {
      throw new AssetRequestError(response.status, "thumbnail", "upload");
    }
  }

  async deleteThumbnail(
    drawingId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await this.#fetch(this.#thumbnailUrl(drawingId), {
      credentials: "include",
      method: "DELETE",
      signal,
    });
    if (!response.ok) {
      throw new AssetRequestError(response.status, "thumbnail", "delete");
    }
  }

  #url(drawingId: string, fileId: string) {
    return `${this.#baseUrl}/drawings/${encodeURIComponent(
      drawingId,
    )}/assets/${encodeURIComponent(fileId)}`;
  }

  #thumbnailUrl(drawingId: string) {
    return `${this.#baseUrl}/drawings/${encodeURIComponent(
      drawingId,
    )}/thumbnail`;
  }
}

/** Downloads assets of a publicly shared drawing via its share token. */
export class ShareAssetClient implements Pick<AssetClient, "download"> {
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #token: string;

  constructor(
    token: string,
    {
      baseUrl = "/api/v1",
      fetch = globalThis.fetch.bind(globalThis),
    }: Pick<AssetClientOptions, "baseUrl" | "fetch"> = {},
  ) {
    this.#baseUrl = baseUrl.replace(/\/$/, "");
    this.#fetch = fetch;
    this.#token = token;
  }

  async download(
    _drawingId: string,
    fileId: string,
    signal?: AbortSignal,
  ): Promise<BinaryFileData> {
    const response = await this.#fetch(
      `${this.#baseUrl}/share/${encodeURIComponent(
        this.#token,
      )}/assets/${encodeURIComponent(fileId)}`,
      { headers: { accept: "image/*" }, signal },
    );
    if (!response.ok) {
      throw new AssetRequestError(response.status, fileId, "download");
    }
    const blob = await response.blob();
    return {
      created: Date.now(),
      dataURL: await blobToDataUrl(blob),
      id: fileId as BinaryFileData["id"],
      mimeType: (blob.type ||
        response.headers.get("content-type") ||
        "application/octet-stream") as BinaryFileData["mimeType"],
    };
  }
}

export interface AssetUploadManagerOptions {
  client: Pick<AssetClient, "upload">;
}

/** Deduplicates successful and concurrent uploads by drawing, file ID and data. */
export class AssetUploadManager {
  readonly #client: Pick<AssetClient, "upload">;
  readonly #uploads = new Map<string, Promise<AssetMetadata>>();

  constructor({ client }: AssetUploadManagerOptions) {
    this.#client = client;
  }

  async uploadReferenced(
    drawingId: string,
    files: BinaryFiles,
    fileIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<AssetMetadata[]> {
    return Promise.all(
      [...new Set(fileIds)].map((fileId) => {
        const file = files[fileId];
        if (!file) {
          throw new Error(`Referenced asset ${fileId} is unavailable locally`);
        }
        const key = `${drawingId}\u0000${fileId}\u0000${file.dataURL}`;
        let upload = this.#uploads.get(key);
        if (!upload) {
          upload = this.#client.upload(drawingId, file, signal);
          this.#uploads.set(key, upload);
          void upload.catch(() => this.#uploads.delete(key));
        }
        return upload;
      }),
    );
  }
}

export interface HydrationResult {
  cancelled: boolean;
  failed: ReadonlyMap<string, Error>;
  loaded: string[];
}

/** Adds each available asset immediately instead of waiting for the whole set. */
export const hydrateAssets = async (
  api: Pick<ExcalidrawImperativeAPI, "addFiles">,
  client: Pick<AssetClient, "download">,
  drawingId: string,
  fileIds: readonly string[],
  signal?: AbortSignal,
): Promise<HydrationResult> => {
  const loaded: string[] = [];
  const failed = new Map<string, Error>();

  await Promise.all(
    [...new Set(fileIds)].map(async (fileId) => {
      try {
        if (signal?.aborted) {
          return;
        }
        const file = await client.download(drawingId, fileId, signal);
        if (signal?.aborted) {
          return;
        }
        api.addFiles([file]);
        loaded.push(fileId);
      } catch (caught) {
        if (signal?.aborted || isAbortError(caught)) {
          return;
        }
        failed.set(
          fileId,
          caught instanceof Error
            ? caught
            : new Error(`Asset ${fileId} failed`),
        );
      }
    }),
  );

  return { cancelled: signal?.aborted ?? false, failed, loaded };
};

export const collectAssetReferences = (
  elements: readonly { fileId?: string | null; isDeleted?: boolean }[],
): string[] =>
  [
    ...new Set(
      elements.flatMap((element) => (element.fileId ? [element.fileId] : [])),
    ),
  ].sort();

export const dataUrlBytes = (dataUrl: string): Uint8Array => {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) {
    throw new Error("Invalid asset data URL");
  }
  const metadata = dataUrl.slice(0, comma);
  const payload = dataUrl.slice(comma + 1);
  if (metadata.endsWith(";base64")) {
    const binary = atob(payload);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }
  return new TextEncoder().encode(decodeURIComponent(payload));
};

export const digestSha256 = async (bytes: Uint8Array): Promise<string> => {
  const hash = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(hash)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
};

const blobToDataUrl = (blob: Blob): Promise<DataURL> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(reader.error ?? new Error("Could not read asset"));
    reader.onload = () => resolve(reader.result as DataURL);
    reader.readAsDataURL(blob);
  });

const isAbortError = (error: unknown) =>
  error instanceof DOMException && error.name === "AbortError";
