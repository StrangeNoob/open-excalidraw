import {
  chatHistoryResponseSchema,
  chatParticipantsResponseSchema,
  type ChatHistoryResponse,
  type ChatParticipantsResponse,
} from "@open-excalidraw/contracts";

import { HttpApiClient } from "../../shared/api";

export interface ChatSource {
  history(
    drawingId: string,
    before: string | null,
  ): Promise<ChatHistoryResponse>;
  participants(drawingId: string): Promise<ChatParticipantsResponse>;
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

  // The sharing member list is owner-only; this roster is what lets an editor
  // or viewer mention anybody.
  participants(drawingId: string): Promise<ChatParticipantsResponse> {
    return this.api.request(
      `/v1/drawings/${encodeURIComponent(drawingId)}/chat/participants`,
      { method: "GET" },
      chatParticipantsResponseSchema,
    );
  }
}
