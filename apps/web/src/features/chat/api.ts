import {
  chatHistoryResponseSchema,
  type ChatHistoryResponse,
} from "@open-excalidraw/contracts";

import { HttpApiClient } from "../../shared/api";

export interface ChatSource {
  history(
    drawingId: string,
    before: string | null,
  ): Promise<ChatHistoryResponse>;
}

export class ChatClient implements ChatSource {
  constructor(private readonly api = new HttpApiClient()) {}

  history(
    drawingId: string,
    before: string | null,
  ): Promise<ChatHistoryResponse> {
    const query = before ? `?before=${encodeURIComponent(before)}` : "";
    return this.api.request(
      `/v1/drawings/${encodeURIComponent(drawingId)}/messages${query}`,
      { method: "GET" },
      chatHistoryResponseSchema,
    );
  }
}
