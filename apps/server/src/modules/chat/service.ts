import {
  uuidSchema,
  type ChatHistoryResponse,
  type ChatMessage,
  type ChatParticipantsResponse,
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
      mentions: await this.#resolveMentions(binding.drawingId, event.mentions),
      // Anchored element ids are stored verbatim: the scene moves on, so they
      // can only be resolved against the client's live scene.
      anchor: event.anchor,
    });
    return record ? toChatMessage(record) : null;
  }

  /**
   * Mentions of users who are not members of the drawing are dropped silently
   * rather than rejected: the message itself is still valid, and a stale
   * mention is no reason to lose it. The filtered set is echoed back to the
   * sender as the delivery ack, which tells them no more about who belongs to
   * the drawing than the participant roster every member may read.
   */
  async #resolveMentions(
    drawingId: string,
    mentions: string[] | undefined,
  ): Promise<string[] | undefined> {
    if (!mentions || mentions.length === 0) {
      return undefined;
    }
    const unique = [...new Set(mentions)];
    const roles = await Promise.all(
      unique.map((userId) =>
        this.options.membershipResolver.getRole(drawingId, userId),
      ),
    );
    const members = unique.filter((_, index) => roles[index] != null);
    return members.length > 0 ? members : undefined;
  }

  /**
   * The roster behind the mention picker. Every member may read it, unlike the
   * owner-only sharing list, so it carries names and ids and nothing else.
   */
  public async participants(
    userId: string,
    drawingId: string,
  ): Promise<ChatParticipantsResponse> {
    await this.#assertMember(userId, drawingId);
    return {
      participants: await this.options.repository.listParticipants(drawingId),
    };
  }

  async #assertMember(userId: string, drawingId: string): Promise<void> {
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
  }

  public async history(
    userId: string,
    drawingId: string,
    before?: string,
  ): Promise<ChatHistoryResponse> {
    await this.#assertMember(userId, drawingId);
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
