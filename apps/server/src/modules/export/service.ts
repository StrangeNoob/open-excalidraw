import { createHash } from "node:crypto";

import type { AssetService } from "../assets/service.js";
import { MAX_THUMBNAIL_BYTES } from "../assets/service.js";
import type { ContentService } from "../content/service.js";
import type { DrawingService } from "../drawings/service.js";
import { ExportDomainError } from "./errors.js";
import type { SceneRenderer } from "./renderer.js";

export type ExportFormat = "svg" | "png";

/** Refuse rather than stream an unbounded body out of a single render. */
export const MAX_EXPORT_BYTES = 8 * 1024 * 1024;

/**
 * Checked before rendering: a scene at the contract maximum costs well over a
 * gigabyte of resident memory to render and then fails the byte cap anyway,
 * so the whole cost would be paid and discarded.
 */
export const MAX_EXPORT_ELEMENTS = 10_000;

/** Mirrors the browser's dashboard capture (`apps/web` thumbnail.ts). */
export const THUMBNAIL_MAX_DIMENSION = 640;

export interface ExportResult {
  revision: string;
  contentType: string;
  body: Buffer;
}

export interface ExportServiceDependencies {
  content: Pick<ContentService, "load">;
  drawings: Pick<DrawingService, "get">;
  assets: Pick<AssetService, "uploadThumbnail">;
  renderer: SceneRenderer;
}

export class ExportService {
  public constructor(
    private readonly dependencies: ExportServiceDependencies,
  ) {}

  /**
   * Renders a drawing the caller can already read. Access, and therefore the
   * 404 for anything else, comes from the content load.
   */
  public async render(
    userId: string,
    drawingId: string,
    options: {
      format: ExportFormat;
      scale?: number;
      maxWidthOrHeight?: number;
    },
  ): Promise<ExportResult> {
    const content = await this.dependencies.content.load(userId, drawingId);
    if (content.scene.elements.length > MAX_EXPORT_ELEMENTS) {
      throw new ExportDomainError(
        "EXPORT_TOO_LARGE",
        413,
        "The scene has too many elements to export",
        `Exports are limited to ${MAX_EXPORT_ELEMENTS} elements.`,
      );
    }
    const request = {
      elements: content.scene.elements,
      appState: exportAppState(content.scene.appState),
    };
    const body = await this.run(async () =>
      options.format === "svg"
        ? Buffer.from(await this.dependencies.renderer.svg(request), "utf8")
        : await this.dependencies.renderer.png({
            ...request,
            scale: options.scale ?? 1,
            ...(options.maxWidthOrHeight
              ? { maxWidthOrHeight: options.maxWidthOrHeight }
              : {}),
          }),
    );
    if (body.byteLength > MAX_EXPORT_BYTES) {
      throw new ExportDomainError(
        "EXPORT_TOO_LARGE",
        413,
        "The rendered export is too large",
        `Exports may not exceed ${MAX_EXPORT_BYTES} bytes. Export fewer elements or a smaller scale.`,
      );
    }
    return {
      revision: content.revision,
      contentType: options.format === "svg" ? "image/svg+xml" : "image/png",
      body,
    };
  }

  /**
   * The content revision alone, for answering a conditional request without
   * paying for a render the caller is about to discard.
   */
  public async revision(userId: string, drawingId: string): Promise<string> {
    const drawing = await this.dependencies.drawings.get(userId, drawingId);
    return drawing.contentRevision;
  }

  /**
   * Gives a drawing the dashboard thumbnail an editor would have produced, so
   * a drawing only ever written through the API is not a blank card. Returns
   * false when one already exists or the render is unusable; the caller keeps
   * going either way.
   */
  public async ensureThumbnail(
    userId: string,
    drawingId: string,
  ): Promise<boolean> {
    const drawing = await this.dependencies.drawings.get(userId, drawingId);
    if (drawing.thumbnailUpdatedAt !== null) return false;

    const { body } = await this.render(userId, drawingId, {
      format: "png",
      maxWidthOrHeight: THUMBNAIL_MAX_DIMENSION,
    });
    // ponytail: a dense scene can exceed the thumbnail cap even at 640px; the
    // card stays blank until a browser opens the drawing. Re-render smaller if
    // that shows up in practice.
    if (body.byteLength > MAX_THUMBNAIL_BYTES) return false;

    await this.dependencies.assets.uploadThumbnail({
      identity: { userId },
      drawingId,
      declaredMimeType: "image/png",
      expectedSha256: createHash("sha256").update(body).digest("hex"),
      bytes: body,
    });
    return true;
  }

  private async run<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      throw new ExportDomainError(
        "EXPORT_UNAVAILABLE",
        503,
        "Rendering is unavailable",
        "The server could not render this drawing.",
        { cause: error },
      );
    }
  }
}

/**
 * One canonical rendering whatever the viewer's theme: light, with the
 * scene's own background, exactly like the browser's thumbnail capture.
 */
function exportAppState(appState: Record<string, unknown>) {
  return {
    ...appState,
    exportBackground: true,
    exportWithDarkMode: false,
    viewBackgroundColor:
      typeof appState.viewBackgroundColor === "string"
        ? appState.viewBackgroundColor
        : "#ffffff",
  };
}
