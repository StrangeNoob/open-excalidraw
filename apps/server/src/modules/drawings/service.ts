import type {
  CreateDrawingRequest,
  DrawingListResponse,
  DrawingSummary,
} from "@open-excalidraw/contracts";

import { DrawingDomainError } from "./errors.js";
import { can, type DrawingCapability } from "./policy.js";
import {
  toDrawingListResponse,
  toDrawingSummary,
  type AccessibleDrawing,
  type DrawingRepository,
} from "./types.js";

export class DrawingService {
  public constructor(private readonly repository: DrawingRepository) {}

  public async list(userId: string): Promise<DrawingListResponse> {
    return toDrawingListResponse(await this.repository.listForUser(userId));
  }

  public async create(
    userId: string,
    input: CreateDrawingRequest,
  ): Promise<DrawingSummary> {
    return toDrawingSummary(
      await this.repository.create({
        ownerUserId: userId,
        title: input.title,
        ...(input.idempotencyKey
          ? { idempotencyKey: input.idempotencyKey }
          : {}),
      }),
    );
  }

  public async get(userId: string, drawingId: string): Promise<DrawingSummary> {
    return toDrawingSummary(
      await this.requireAccess(userId, drawingId, "read"),
    );
  }

  public async getAccess(
    userId: string,
    drawingId: string,
  ): Promise<AccessibleDrawing> {
    return this.requireAccess(userId, drawingId, "read");
  }

  public async rename(
    userId: string,
    drawingId: string,
    input: { title: string; metadataRevision: string },
  ): Promise<DrawingSummary> {
    await this.requireAccess(userId, drawingId, "rename");
    const result = await this.repository.rename({
      drawingId,
      actorUserId: userId,
      title: input.title,
      expectedMetadataRevision: BigInt(input.metadataRevision),
    });

    if (result.status === "not-found") {
      throw notFound();
    }
    if (result.status === "forbidden") {
      throw forbidden();
    }
    if (result.status === "conflict") {
      throw new DrawingDomainError(
        "METADATA_VERSION_CONFLICT",
        412,
        "Drawing metadata changed",
        `The current metadata revision is ${result.currentRevision.toString()}.`,
      );
    }
    return toDrawingSummary(result.drawing);
  }

  public async delete(
    userId: string,
    drawingId: string,
    auditRequestId?: string,
  ): Promise<void> {
    await this.requireAccess(userId, drawingId, "delete");
    const result = await this.repository.softDelete({
      drawingId,
      ownerUserId: userId,
      ...(auditRequestId ? { auditRequestId } : {}),
    });
    if (result === "not-found") {
      throw notFound();
    }
  }

  public async setTags(
    userId: string,
    drawingId: string,
    tags: string[],
  ): Promise<DrawingSummary> {
    // Tags are private to the requesting user, so viewers may tag too.
    await this.requireAccess(userId, drawingId, "read");
    await this.repository.replaceTags({
      drawingId,
      userId,
      tags: [...new Set(tags)],
    });
    const drawing = await this.repository.findAccessible(drawingId, userId);
    if (!drawing) {
      throw notFound();
    }
    return toDrawingSummary(drawing);
  }

  public async leave(userId: string, drawingId: string): Promise<void> {
    const drawing = await this.requireAccess(userId, drawingId, "read");
    if (drawing.role === "owner") {
      throw new DrawingDomainError(
        "OWNER_CANNOT_LEAVE",
        409,
        "Owners cannot leave their drawing",
        "Transfer ownership before leaving.",
      );
    }
    if (!can(drawing.role, "leave")) {
      throw forbidden();
    }
    const result = await this.repository.leave({ drawingId, userId });
    if (result === "not-found") {
      throw notFound();
    }
  }

  public async transferOwnership(
    userId: string,
    drawingId: string,
    newOwnerUserId: string,
    auditRequestId?: string,
  ): Promise<DrawingSummary> {
    await this.requireAccess(userId, drawingId, "transfer-ownership");
    if (userId === newOwnerUserId) {
      throw new DrawingDomainError(
        "INVALID_OWNERSHIP_TARGET",
        409,
        "The owner is already the requested user",
      );
    }

    const result = await this.repository.transferOwnership({
      drawingId,
      currentOwnerUserId: userId,
      newOwnerUserId,
      ...(auditRequestId ? { auditRequestId } : {}),
    });
    if (result.status === "not-found") {
      throw notFound();
    }
    if (result.status === "target-not-found") {
      throw new DrawingDomainError(
        "INVALID_OWNERSHIP_TARGET",
        404,
        "The new owner does not exist",
      );
    }
    return toDrawingSummary(result.drawing);
  }

  private async requireAccess(
    userId: string,
    drawingId: string,
    capability: DrawingCapability,
  ): Promise<AccessibleDrawing> {
    const drawing = await this.repository.findAccessible(drawingId, userId);
    if (!drawing) {
      throw notFound();
    }
    if (!can(drawing.role, capability)) {
      throw forbidden();
    }
    return drawing;
  }
}

const notFound = () =>
  new DrawingDomainError("DRAWING_NOT_FOUND", 404, "Drawing not found");

const forbidden = () =>
  new DrawingDomainError(
    "FORBIDDEN",
    403,
    "You do not have permission to perform this action",
  );
