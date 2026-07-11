import { pipeline } from "node:stream/promises";

import express, {
  type ErrorRequestHandler,
  type Request,
  type Response,
  type Router,
} from "express";

import { requestIdFor } from "../../http/request-context.js";

import { AssetError, assetError } from "./errors.js";
import { ASSET_CHECKSUM_HEADER, DEFAULT_MAX_ASSET_BYTES } from "./service.js";
import type { AssetService } from "./service.js";
import type { AssetIdentityResolver, AssetRecord } from "./types.js";

export interface CreateAssetRouterOptions {
  service: AssetService;
  resolveIdentity: AssetIdentityResolver;
  onError?: (error: unknown, request: Request) => void;
}

export function createAssetRouter(options: CreateAssetRouterOptions): Router {
  const router = express.Router();
  const rawBody = express.raw({
    limit: options.service.maxAssetBytes,
    type: () => true,
  });

  router.put(
    "/drawings/:drawingId/assets/:fileId",
    rawBody,
    async (request, response) => {
      const identity = await requireIdentity(request, options.resolveIdentity);
      const bytes = request.body as unknown;
      if (!Buffer.isBuffer(bytes)) {
        throw assetError(
          400,
          "INVALID_ASSET_BODY",
          "Invalid asset body",
          "The request body must contain raw binary asset bytes.",
        );
      }

      const checksum = request.get(ASSET_CHECKSUM_HEADER) ?? "";
      const fileVersion = parseFileVersion(
        request.get("x-excalidraw-file-version"),
      );
      const result = await options.service.upload({
        identity,
        drawingId: request.params.drawingId ?? "",
        fileId: request.params.fileId ?? "",
        declaredMimeType: request.get("content-type") ?? "",
        expectedSha256: checksum,
        fileVersion,
        bytes,
      });

      response
        .status(result.created ? 201 : 200)
        .json(toAssetResponse(result.asset));
    },
  );

  router.get(
    "/drawings/:drawingId/assets/:fileId",
    async (request, response) => {
      const identity = await requireIdentity(request, options.resolveIdentity);
      const result = await options.service.download({
        identity,
        drawingId: request.params.drawingId ?? "",
        fileId: request.params.fileId ?? "",
      });

      setDownloadHeaders(response, result.asset);
      await pipeline(result.body, response);
    },
  );

  const errorHandler: ErrorRequestHandler = (
    error,
    request,
    response,
    _next,
  ) => {
    void _next;
    options.onError?.(error, request);
    const normalized = normalizeRouteError(
      error,
      options.service.maxAssetBytes,
    );
    const requestId = requestIdFor(request, response);
    response.set("x-request-id", requestId);
    if (normalized.status === 401) {
      response.set("www-authenticate", "Session");
    }
    response.status(normalized.status).type("application/problem+json").json({
      code: normalized.code,
      status: normalized.status,
      title: normalized.title,
      detail: normalized.message,
      requestId,
    });
  };
  router.use(errorHandler);

  return router;
}

async function requireIdentity(
  request: Request,
  resolver: AssetIdentityResolver,
) {
  const identity = await resolver(request);
  if (!identity) {
    throw assetError(
      401,
      "AUTHENTICATION_REQUIRED",
      "Authentication required",
      "Sign in to access drawing assets.",
    );
  }
  return identity;
}

function parseFileVersion(value: string | undefined) {
  if (value === undefined) {
    return null;
  }
  if (!/^[1-9]\d*$/.test(value)) {
    throw assetError(
      400,
      "INVALID_FILE_VERSION",
      "Invalid file version",
      "x-excalidraw-file-version must be a positive integer.",
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw assetError(
      400,
      "INVALID_FILE_VERSION",
      "Invalid file version",
      "x-excalidraw-file-version must be a safe positive integer.",
    );
  }
  return parsed;
}

function toAssetResponse(asset: AssetRecord) {
  return {
    id: asset.id,
    drawingId: asset.drawingId,
    fileId: asset.fileId,
    mimeType: asset.mimeType,
    byteSize: asset.byteSize,
    sha256: asset.sha256,
    fileVersion: asset.fileVersion,
    createdAt: asset.createdAt.toISOString(),
  };
}

function setDownloadHeaders(response: Response, asset: AssetRecord) {
  const extension = extensionForMimeType(asset.mimeType);
  const filename = `${asset.fileId}.${extension}`;

  response.status(200);
  response.set({
    "cache-control": "private, max-age=31536000, immutable",
    "content-disposition": `attachment; filename="${filename}"`,
    "content-length": String(asset.byteSize),
    "content-security-policy": "sandbox",
    "content-type": asset.mimeType,
    "cross-origin-resource-policy": "same-origin",
    etag: `"${asset.sha256}"`,
    "x-content-type-options": "nosniff",
  });
}

function extensionForMimeType(mimeType: string) {
  switch (mimeType) {
    case "image/avif":
      return "avif";
    case "image/bmp":
      return "bmp";
    case "image/gif":
      return "gif";
    case "image/jfif":
      return "jfif";
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/svg+xml":
      return "svg";
    case "image/webp":
      return "webp";
    case "image/x-icon":
      return "ico";
    default:
      return "bin";
  }
}

function normalizeRouteError(error: unknown, maxAssetBytes: number) {
  if (error instanceof AssetError) {
    return error;
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "type" in error &&
    error.type === "entity.too.large"
  ) {
    return assetError(
      413,
      "ASSET_TOO_LARGE",
      "Asset too large",
      `Assets may not exceed ${maxAssetBytes || DEFAULT_MAX_ASSET_BYTES} bytes.`,
    );
  }

  return assetError(
    500,
    "INTERNAL_ERROR",
    "Internal server error",
    "The request could not be completed.",
    { cause: error },
  );
}
