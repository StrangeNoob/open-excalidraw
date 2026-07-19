import {
  drawingListResponseSchema,
  drawingSummarySchema,
  trashListResponseSchema,
  type DrawingListResponse,
  type DrawingSummary,
  type TrashedDrawing,
  type TrashListResponse,
} from "@open-excalidraw/contracts";
import { z } from "zod";

import { HttpApiClient } from "../../shared/api";

// Shared here so DashboardPage and TrashPage agree on the cache entries
// without importing each other.
export const DASHBOARD_QUERY_KEY = ["drawings", "dashboard"] as const;
export const TRASH_QUERY_KEY = ["drawings", "trash"] as const;

const drawingMutationResponseSchema = z.union([
  drawingSummarySchema,
  z.object({ drawing: drawingSummarySchema }).strict(),
]);

const unwrapDrawing = (
  response: z.infer<typeof drawingMutationResponseSchema>,
): DrawingSummary => ("drawing" in response ? response.drawing : response);

export interface DashboardApi {
  // An explicit id replays an offline-created drawing (retry-safe); omit it and
  // the server mints one under an idempotency key.
  createDrawing(title: string, id?: string): Promise<DrawingSummary>;
  deleteDrawing(drawing: DrawingSummary): Promise<void>;
  duplicateDrawing(drawing: DrawingSummary): Promise<DrawingSummary>;
  listDrawings(): Promise<DrawingListResponse>;
  listTrash(): Promise<TrashListResponse>;
  purgeDrawing(drawing: TrashedDrawing): Promise<void>;
  restoreDrawing(drawing: TrashedDrawing): Promise<DrawingSummary>;
  renameDrawing(
    drawing: DrawingSummary,
    title: string,
  ): Promise<DrawingSummary>;
  setTags(drawing: DrawingSummary, tags: string[]): Promise<DrawingSummary>;
  setTemplate(
    drawing: DrawingSummary,
    isTemplate: boolean,
  ): Promise<DrawingSummary>;
}

export class DashboardApiClient implements DashboardApi {
  readonly #api: HttpApiClient;

  constructor(api = new HttpApiClient()) {
    this.#api = api;
  }

  async createDrawing(title: string, id?: string): Promise<DrawingSummary> {
    const response = await this.#api.request(
      "/v1/drawings",
      {
        // A supplied id is idempotent on its own; the random idempotency key is
        // only for server-assigned ids.
        body: JSON.stringify(
          id ? { id, title } : { idempotencyKey: crypto.randomUUID(), title },
        ),
        method: "POST",
      },
      drawingMutationResponseSchema,
    );

    return unwrapDrawing(response);
  }

  async duplicateDrawing(drawing: DrawingSummary): Promise<DrawingSummary> {
    const response = await this.#api.request(
      `/v1/drawings/${drawing.id}/duplicate`,
      {
        body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
        method: "POST",
      },
      drawingMutationResponseSchema,
    );

    return unwrapDrawing(response);
  }

  listDrawings(): Promise<DrawingListResponse> {
    return this.#api.request(
      "/v1/drawings",
      { method: "GET" },
      drawingListResponseSchema,
    );
  }

  async renameDrawing(
    drawing: DrawingSummary,
    title: string,
  ): Promise<DrawingSummary> {
    const response = await this.#api.request(
      `/v1/drawings/${drawing.id}`,
      {
        body: JSON.stringify({
          metadataRevision: drawing.metadataRevision,
          title,
        }),
        method: "PATCH",
      },
      drawingMutationResponseSchema,
    );

    return unwrapDrawing(response);
  }

  async setTags(
    drawing: DrawingSummary,
    tags: string[],
  ): Promise<DrawingSummary> {
    const response = await this.#api.request(
      `/v1/drawings/${drawing.id}/tags`,
      {
        body: JSON.stringify({ tags }),
        method: "PUT",
      },
      drawingMutationResponseSchema,
    );

    return unwrapDrawing(response);
  }

  async setTemplate(
    drawing: DrawingSummary,
    isTemplate: boolean,
  ): Promise<DrawingSummary> {
    const response = await this.#api.request(
      `/v1/drawings/${drawing.id}`,
      {
        body: JSON.stringify({
          isTemplate,
          metadataRevision: drawing.metadataRevision,
          title: drawing.title,
        }),
        method: "PATCH",
      },
      drawingMutationResponseSchema,
    );

    return unwrapDrawing(response);
  }

  async deleteDrawing(drawing: DrawingSummary): Promise<void> {
    await this.#api.request<void>(`/v1/drawings/${drawing.id}`, {
      method: "DELETE",
    });
  }

  listTrash(): Promise<TrashListResponse> {
    return this.#api.request(
      "/v1/drawings/trash",
      { method: "GET" },
      trashListResponseSchema,
    );
  }

  async restoreDrawing(drawing: TrashedDrawing): Promise<DrawingSummary> {
    const response = await this.#api.request(
      `/v1/drawings/${drawing.id}/restore`,
      { method: "POST" },
      drawingMutationResponseSchema,
    );

    return unwrapDrawing(response);
  }

  async purgeDrawing(drawing: TrashedDrawing): Promise<void> {
    await this.#api.request<void>(`/v1/drawings/${drawing.id}/permanent`, {
      method: "DELETE",
    });
  }
}
