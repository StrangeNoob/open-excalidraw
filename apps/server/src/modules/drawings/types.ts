import type {
  DrawingListResponse,
  DrawingSummary,
  Role,
  TrashedDrawing,
} from "@open-excalidraw/contracts";

export interface AccessibleDrawing {
  id: string;
  title: string;
  ownerUserId: string;
  ownerName: string;
  role: Role;
  /** Private tags of the user the drawing was resolved for. */
  tags: string[];
  contentRevision: bigint;
  metadataRevision: bigint;
  createdAt: Date;
  updatedAt: Date;
  thumbnailUpdatedAt: Date | null;
  isTemplate: boolean;
}

/**
 * Copies asset/thumbnail blobs when a drawing is duplicated. A missing or
 * corrupt source blob is reported (not thrown) so a duplicate mirrors its
 * source, broken images included; hard storage failures still throw.
 */
export interface DrawingBlobStore {
  copy(input: {
    sourceKey: string;
    targetKey: string;
    expectedSha256?: string;
  }): Promise<"copied" | "missing">;
  remove(key: string): Promise<void>;
}

export type CreateDrawingResult =
  { status: "created"; drawing: AccessibleDrawing } | { status: "conflict" };

export type RenameDrawingResult =
  | { status: "updated"; drawing: AccessibleDrawing }
  | { status: "conflict"; currentRevision: bigint }
  | { status: "forbidden" }
  | { status: "not-found" };

export interface TrashedDrawingRecord extends AccessibleDrawing {
  deletedAt: Date;
}

export type DeleteDrawingResult = "deleted" | "not-found";
export type RestoreDrawingResult = "restored" | "not-found";
export type PurgeDrawingResult = "purged" | "not-found";
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
    id?: string;
    idempotencyKey?: string;
  }): Promise<CreateDrawingResult>;
  rename(input: {
    drawingId: string;
    actorUserId: string;
    title: string;
    expectedMetadataRevision: bigint;
    isTemplate?: boolean;
  }): Promise<RenameDrawingResult>;
  duplicate(input: {
    sourceDrawingId: string;
    ownerUserId: string;
    idempotencyKey?: string;
  }): Promise<AccessibleDrawing | null>;
  softDelete(input: {
    drawingId: string;
    ownerUserId: string;
    auditRequestId?: string;
  }): Promise<DeleteDrawingResult>;
  listTrashedForUser(userId: string): Promise<TrashedDrawingRecord[]>;
  restore(input: {
    drawingId: string;
    ownerUserId: string;
    auditRequestId?: string;
  }): Promise<RestoreDrawingResult>;
  purge(input: {
    drawingId: string;
    ownerUserId: string;
    auditRequestId?: string;
  }): Promise<PurgeDrawingResult>;
  leave(input: {
    drawingId: string;
    userId: string;
  }): Promise<LeaveDrawingResult>;
  replaceTags(input: {
    drawingId: string;
    userId: string;
    tags: string[];
  }): Promise<void>;
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
  tags: drawing.tags,
  contentRevision: drawing.contentRevision.toString(),
  metadataRevision: drawing.metadataRevision.toString(),
  createdAt: drawing.createdAt.toISOString(),
  updatedAt: drawing.updatedAt.toISOString(),
  thumbnailUpdatedAt: drawing.thumbnailUpdatedAt?.toISOString() ?? null,
  isTemplate: drawing.isTemplate,
});

export const toTrashedDrawingSummary = (
  drawing: TrashedDrawingRecord,
): TrashedDrawing => ({
  ...toDrawingSummary(drawing),
  deletedAt: drawing.deletedAt.toISOString(),
});

export const toDrawingListResponse = (input: {
  owned: AccessibleDrawing[];
  shared: AccessibleDrawing[];
}): DrawingListResponse => ({
  owned: input.owned.map(toDrawingSummary),
  shared: input.shared.map(toDrawingSummary),
  nextCursor: null,
});
