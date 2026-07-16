import { exportToBlob as exportToBlobUntyped } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { digestSha256, type AssetClient } from "../assets";

type ThumbnailEditor = Pick<
  ExcalidrawImperativeAPI,
  "getAppState" | "getFiles" | "getSceneElements"
>;

// The package's own declaration re-exports exportToBlob from
// "@excalidraw/utils", which is not installed, leaving the symbol untyped.
const exportToBlob = exportToBlobUntyped as (options: {
  elements: ReturnType<ThumbnailEditor["getSceneElements"]>;
  appState: ReturnType<ThumbnailEditor["getAppState"]>;
  files: ReturnType<ThumbnailEditor["getFiles"]>;
  maxWidthOrHeight: number;
  mimeType: string;
}) => Promise<Blob>;

export const THUMBNAIL_MAX_DIMENSION = 640;

export type ThumbnailClient = Pick<
  AssetClient,
  "deleteThumbnail" | "uploadThumbnail"
>;

/**
 * Renders and stores the dashboard thumbnail; callers swallow failures.
 *
 * Returns the pushed state for the caller to thread into the next capture:
 * the uploaded PNG's sha256, or null once cleared. Collaboration keeps
 * `onChange` firing while a drawing sits idle, so captures without this
 * dedupe re-upload an identical image every window.
 */
export async function captureThumbnail(
  api: ThumbnailEditor,
  drawingId: string,
  client: ThumbnailClient,
  previousSha256?: string | null,
): Promise<string | null> {
  const elements = api.getSceneElements();
  if (elements.length === 0) {
    if (previousSha256 !== null) {
      // A wiped drawing must not keep a stale preview; the card falls back
      // to its text-only layout.
      await client.deleteThumbnail(drawingId);
    }
    return null;
  }

  const blob = await exportToBlob({
    elements,
    // Always export light with background: one canonical stored image that
    // reads fine on both dashboard themes.
    appState: {
      ...api.getAppState(),
      exportBackground: true,
      exportWithDarkMode: false,
    },
    files: api.getFiles(),
    maxWidthOrHeight: THUMBNAIL_MAX_DIMENSION,
    mimeType: "image/png",
  });
  const sha256 = await digestSha256(new Uint8Array(await blob.arrayBuffer()));
  if (sha256 !== previousSha256) {
    await client.uploadThumbnail(drawingId, blob);
  }
  return sha256;
}
