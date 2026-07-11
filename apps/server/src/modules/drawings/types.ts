import type {
  DrawingListResponse,
  DrawingSummary,
  Role,
} from "@open-excalidraw/contracts";

export interface AccessibleDrawing {
  id: string;
  title: string;
  ownerUserId: string;
  ownerName: string;
  role: Role;
  contentRevision: bigint;
  metadataRevision: bigint;
  createdAt: Date;
  updatedAt: Date;
}

export type RenameDrawingResult =
  | { status: "updated"; drawing: AccessibleDrawing }
  | { status: "conflict"; currentRevision: bigint }
  | { status: "forbidden" }
  | { status: "not-found" };

export type DeleteDrawingResult = "deleted" | "not-found";
export type LeaveDrawingResult = "left" | "not-found";
export type TransferOwnershipResult =
  | { status: "transferred"; drawing: AccessibleDrawing }
  | { status: "not-found" }
  | { status: "target-not-found" };

export interface DrawingRepository {
  listForUser(userId: string): Promise<{
    owned: AccessibleDrawing[];
    shared: AccessibleDrawing[];
  }>;
  findAccessible(
    drawingId: string,
    userId: string,
  ): Promise<AccessibleDrawing | null>;
  create(input: {
    ownerUserId: string;
    title: string;
    idempotencyKey?: string;
  }): Promise<AccessibleDrawing>;
  rename(input: {
    drawingId: string;
    actorUserId: string;
    title: string;
    expectedMetadataRevision: bigint;
  }): Promise<RenameDrawingResult>;
  softDelete(input: {
    drawingId: string;
    ownerUserId: string;
    auditRequestId?: string;
  }): Promise<DeleteDrawingResult>;
  leave(input: {
    drawingId: string;
    userId: string;
  }): Promise<LeaveDrawingResult>;
  transferOwnership(input: {
    drawingId: string;
    currentOwnerUserId: string;
    newOwnerUserId: string;
    auditRequestId?: string;
  }): Promise<TransferOwnershipResult>;
}

export const toDrawingSummary = (
  drawing: AccessibleDrawing,
): DrawingSummary => ({
  id: drawing.id,
  title: drawing.title,
  ownerUserId: drawing.ownerUserId,
  ownerName: drawing.ownerName,
  role: drawing.role,
  contentRevision: drawing.contentRevision.toString(),
  metadataRevision: drawing.metadataRevision.toString(),
  createdAt: drawing.createdAt.toISOString(),
  updatedAt: drawing.updatedAt.toISOString(),
});

export const toDrawingListResponse = (input: {
  owned: AccessibleDrawing[];
  shared: AccessibleDrawing[];
}): DrawingListResponse => ({
  owned: input.owned.map(toDrawingSummary),
  shared: input.shared.map(toDrawingSummary),
  nextCursor: null,
});
