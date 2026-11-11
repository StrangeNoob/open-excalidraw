import {
  uuidSchema,
  type ChatHistoryResponse,
  type ChatMessage,
  type ChatSendEvent,
} from "@open-excalidraw/contracts";

import { TokenBucketRateLimiter } from "../collaboration/core/rate-limit.js";
import type {
  DrawingMembershipResolver,
  SocketAuthorizationBinding,
} from "../collaboration/security/index.js";
import { ChatDomainError, ChatRateLimitError } from "./errors.js";
import { toChatMessage, type ChatRepository } from "./types.js";

const HISTORY_PAGE_SIZE = 50;

export class ChatService {
  readonly #rateLimiter: TokenBucketRateLimiter;

  public constructor(
    private readonly options: {
      repository: ChatRepository;
      membershipResolver: DrawingMembershipResolver;
      rateLimiter?: TokenBucketRateLimiter;
    },
  ) {
    this.#rateLimiter =
      options.rateLimiter ??
      new TokenBucketRateLimiter({ capacity: 5, refillTokensPerSecond: 1 });
  }

  /**
   * Authorization is the gateway's job: authorizeCurrent revalidates the
   * session and role on every event before this method is called.
   */
  public async send(
    binding: SocketAuthorizationBinding,
    event: ChatSendEvent,
  ): Promise<ChatMessage | null> {
    if (!this.#rateLimiter.tryConsume(binding.userId)) {
      throw new ChatRateLimitError();
    }
    const record = await this.options.repository.insert({
      id: event.messageId,
      drawingId: binding.drawingId,
      userId: binding.userId,
      body: event.body,
    });
    return record ? toChatMessage(record) : null;
  }

  public async history(
    userId: string,
    drawingId: string,
    before?: string,
  ): Promise<ChatHistoryResponse> {
    const role = await this.options.membershipResolver.getRole(
      drawingId,
      userId,
    );
    if (!role) {
      throw new ChatDomainError(
        "DRAWING_NOT_FOUND",
        404,
        "The drawing does not exist or is not accessible",
      );
    }
    // The cursor is simply the oldest already-loaded message id; the
    // repository resolves its exact position database-side.
    const records = await this.options.repository.listBefore(
      drawingId,
      before === undefined ? null : uuidSchema.parse(before),
      HISTORY_PAGE_SIZE + 1,
    );
    const page = records.slice(0, HISTORY_PAGE_SIZE);
    const oldest = page.at(-1);
    return {
      messages: page.map(toChatMessage),
      nextCursor:
        records.length > HISTORY_PAGE_SIZE && oldest ? oldest.id : null,
    };
  }
}
