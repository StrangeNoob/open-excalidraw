import {
  drawingSummarySchema,
  type DrawingSummary,
} from "@open-excalidraw/contracts";

import { HttpApiClient } from "../../shared/api";

export interface DrawingMetadataSource {
  load(drawingId: string): Promise<DrawingSummary>;
}

export class DrawingMetadataClient implements DrawingMetadataSource {
  constructor(private readonly api = new HttpApiClient()) {}

  load(drawingId: string): Promise<DrawingSummary> {
    return this.api.request(
      `/v1/drawings/${encodeURIComponent(drawingId)}`,
      { method: "GET" },
      drawingSummarySchema,
    );
  }
}
