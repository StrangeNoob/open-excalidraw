import {
  drawingListResponseSchema,
  drawingSummarySchema,
  type DrawingListResponse,
  type DrawingSummary,
} from "@open-excalidraw/contracts";
import { z } from "zod";

import { HttpApiClient } from "../../shared/api";

const drawingMutationResponseSchema = z.union([
  drawingSummarySchema,
  z.object({ drawing: drawingSummarySchema }).strict(),
]);

const unwrapDrawing = (
  response: z.infer<typeof drawingMutationResponseSchema>,
): DrawingSummary => ("drawing" in response ? response.drawing : response);

export interface DashboardApi {
  createDrawing(title: string): Promise<DrawingSummary>;
  deleteDrawing(drawing: DrawingSummary): Promise<void>;
  listDrawings(): Promise<DrawingListResponse>;
  renameDrawing(
    drawing: DrawingSummary,
    title: string,
  ): Promise<DrawingSummary>;
  setTags(drawing: DrawingSummary, tags: string[]): Promise<DrawingSummary>;
}

export class DashboardApiClient implements DashboardApi {
  readonly #api: HttpApiClient;

  constructor(api = new HttpApiClient()) {
    this.#api = api;
  }

  async createDrawing(title: string): Promise<DrawingSummary> {
    const response = await this.#api.request(
      "/v1/drawings",
      {
        body: JSON.stringify({
          idempotencyKey: crypto.randomUUID(),
          title,
        }),
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

  async deleteDrawing(drawing: DrawingSummary): Promise<void> {
    await this.#api.request<void>(`/v1/drawings/${drawing.id}`, {
      method: "DELETE",
    });
  }
}
