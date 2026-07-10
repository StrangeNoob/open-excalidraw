import type { Pool, PoolClient, QueryResultRow } from "pg";

import {
  CONTRACT_LIMITS,
  type AssetMetadata,
  type ExcalidrawElementDTO,
  type Role,
  type SceneEnvelope,
} from "@open-excalidraw/contracts";
import type { StoredScene } from "@open-excalidraw/database";

import { reconcileElements } from "../core/reconcile.js";
import { SocketSecurityError } from "../security/errors.js";
import { MutationPersistenceError } from "./errors.js";
import type {
  CollaborationSnapshot,
  MutationRepository,
  PersistMutationInput,
  PersistMutationResult,
} from "./types.js";

interface LockedDrawing extends QueryResultRow {
  id: string;
  owner_user_id: string;
  scene: StoredScene;
  scene_format_version: number;
  content_revision: string;
  last_checkpoint_at: Date | null;
}

interface MutationRow extends QueryResultRow {
  payload_hash: Buffer;
  resulting_revision: string;
}

const CHECKPOINT_INTERVAL_MS = 5 * 60 * 1_000;

export class PostgresMutationRepository implements MutationRepository {
  public constructor(private readonly pool: Pool) {}

  public async persist(
    input: PersistMutationInput,
  ): Promise<PersistMutationResult> {
    return transaction(this.pool, async (client) => {
      const drawing = await lockDrawing(
        client,
        input.binding.drawingId,
        "update",
      );
      if (!drawing) throw notMember();
      const role = await roleForLockedDrawing(
        client,
        drawing,
        input.binding.userId,
      );
      if (!role) throw notMember();
      if (role === "viewer") {
        throw new SocketSecurityError(
          "SOCKET_EVENT_FORBIDDEN",
          "Viewers cannot publish durable scene mutations",
        );
      }

      const prior = await client.query<MutationRow>(
        `SELECT payload_hash, resulting_revision
         FROM drawing_mutations WHERE drawing_id = $1 AND mutation_id = $2`,
        [input.binding.drawingId, input.event.mutationId],
      );
      const replay = prior.rows[0];
      if (replay) {
        if (!replay.payload_hash.equals(input.payloadHash)) {
          throw new MutationPersistenceError(
            "MUTATION_ID_MISMATCH",
            "The mutation ID was already used for a different payload",
          );
        }
        return {
          status: "duplicate",
          revision: BigInt(replay.resulting_revision),
        };
      }

      const currentRevision = BigInt(drawing.content_revision);
      const baseRevision = BigInt(input.event.baseRevision);
      if (baseRevision > currentRevision) {
        throw new MutationPersistenceError(
          "FUTURE_REVISION",
          `Mutation base ${baseRevision.toString()} is newer than canonical revision ${currentRevision.toString()}`,
          true,
        );
      }

      const canonical = drawing.scene as SceneEnvelope;
      const reconciliation = reconcileElements(
        canonical.elements,
        input.event.elements,
      );
      if (reconciliation.elements.length > CONTRACT_LIMITS.elementsPerScene) {
        throw new MutationPersistenceError(
          "ELEMENT_LIMIT_EXCEEDED",
          "The canonical scene exceeds the maximum element count",
        );
      }
      const state = mergeSharedSceneState(
        canonical.appState,
        input.event.sharedSceneState,
      );
      const changedState = state.changed;
      const canonicalById = new Map(
        reconciliation.elements.map((element) => [element.id, element]),
      );
      const changedElements = reconciliation.changedElementIds.map((id) => {
        const element = canonicalById.get(id);
        if (!element) throw new Error("Changed canonical element disappeared");
        return element;
      });

      if (changedElements.length === 0 && !changedState) {
        await recordMutation(client, {
          drawingId: input.binding.drawingId,
          mutationId: input.event.mutationId,
          payloadHash: input.payloadHash,
          baseRevision,
          resultingRevision: currentRevision,
        });
        return { status: "noop", revision: currentRevision };
      }

      const nextScene: SceneEnvelope = {
        ...canonical,
        elements: reconciliation.elements,
        appState: state.appState,
      };
      const serialized = JSON.stringify(nextScene);
      const sceneBytes = Buffer.byteLength(serialized);
      if (sceneBytes > CONTRACT_LIMITS.sceneBytes) {
        throw new MutationPersistenceError(
          "SCENE_TOO_LARGE",
          "The canonical scene exceeds the maximum size",
        );
      }

      const assetIds = referencedAssetIds(nextScene.elements);
      if (assetIds.length > CONTRACT_LIMITS.assetManifestEntries) {
        throw new MutationPersistenceError(
          "ASSET_LIMIT_EXCEEDED",
          "The canonical scene exceeds the maximum asset count",
        );
      }
      const missing = await lockAndFindMissingAssets(
        client,
        input.binding.drawingId,
        assetIds,
      );
      if (missing.length > 0) {
        throw new MutationPersistenceError(
          "MISSING_ASSET",
          `Upload referenced assets before publishing: ${missing.join(", ")}`,
          true,
        );
      }

      const nextRevision = currentRevision + 1n;
      const checkpointDue =
        drawing.last_checkpoint_at === null ||
        Date.now() - drawing.last_checkpoint_at.getTime() >=
          CHECKPOINT_INTERVAL_MS;
      await client.query(
        `UPDATE drawings
         SET scene = $2::jsonb, scene_bytes = $3,
             content_revision = $4::bigint, updated_at = now(),
             last_checkpoint_at = CASE WHEN $5 THEN now() ELSE last_checkpoint_at END
         WHERE id = $1`,
        [
          input.binding.drawingId,
          serialized,
          sceneBytes,
          nextRevision.toString(),
          checkpointDue,
        ],
      );
      await recordMutation(client, {
        drawingId: input.binding.drawingId,
        mutationId: input.event.mutationId,
        payloadHash: input.payloadHash,
        baseRevision,
        resultingRevision: nextRevision,
      });
      await client.query(
        `UPDATE drawing_assets SET last_referenced_at = now()
         WHERE drawing_id = $1 AND file_id = ANY($2::text[]) AND deleted_at IS NULL`,
        [input.binding.drawingId, assetIds],
      );
      if (checkpointDue) {
        await client.query(
          `INSERT INTO drawing_revisions
             (drawing_id, content_revision, scene, scene_format_version,
              scene_bytes, author_user_id, reason)
           VALUES ($1, $2::bigint, $3::jsonb, $4, $5, $6, 'checkpoint')
           ON CONFLICT (drawing_id, content_revision) DO NOTHING`,
          [
            input.binding.drawingId,
            nextRevision.toString(),
            serialized,
            drawing.scene_format_version,
            sceneBytes,
            input.binding.userId,
          ],
        );
      }

      return {
        status: "committed",
        revision: nextRevision,
        elements: changedElements,
        ...(changedState && input.event.sharedSceneState
          ? { sharedSceneState: input.event.sharedSceneState }
          : {}),
      };
    });
  }

  public async loadSnapshot(
    drawingId: string,
    userId: string,
  ): Promise<CollaborationSnapshot | null> {
    return transaction(this.pool, async (client) => {
      const drawing = await lockDrawing(client, drawingId, "share");
      if (!drawing) return null;
      const role = await roleForLockedDrawing(client, drawing, userId);
      if (!role) return null;
      const snapshot = drawing.scene as SceneEnvelope;
      const referencedAssets = referencedAssetIds(snapshot.elements);
      const assets = await client.query<AssetRow>(
        `SELECT id, drawing_id, file_id, mime_type, byte_size, sha256,
                file_version, created_at
         FROM drawing_assets
         WHERE drawing_id = $1 AND file_id = ANY($2::text[])
           AND deleted_at IS NULL
         ORDER BY file_id`,
        [drawingId, referencedAssets],
      );
      return {
        drawingId,
        role,
        revision: BigInt(drawing.content_revision),
        snapshot,
        assetManifest: assets.rows.map(mapAsset),
      };
    });
  }
}

interface AssetRow extends QueryResultRow {
  id: string;
  drawing_id: string;
  file_id: string;
  mime_type: string;
  byte_size: number;
  sha256: Buffer;
  file_version: number | null;
  created_at: Date;
}

async function lockDrawing(
  client: PoolClient,
  drawingId: string,
  mode: "share" | "update",
) {
  const lock = mode === "update" ? "FOR UPDATE" : "FOR SHARE";
  const result = await client.query<LockedDrawing>(
    `SELECT id, owner_user_id, scene, scene_format_version,
            content_revision, last_checkpoint_at
     FROM drawings WHERE id = $1 AND deleted_at IS NULL ${lock}`,
    [drawingId],
  );
  return result.rows[0] ?? null;
}

async function roleForLockedDrawing(
  client: PoolClient,
  drawing: LockedDrawing,
  userId: string,
): Promise<Role | null> {
  if (drawing.owner_user_id === userId) return "owner";
  const member = await client.query<{ role: "editor" | "viewer" }>(
    `SELECT role FROM drawing_members WHERE drawing_id = $1 AND user_id = $2`,
    [drawing.id, userId],
  );
  return member.rows[0]?.role ?? null;
}

async function lockAndFindMissingAssets(
  client: PoolClient,
  drawingId: string,
  assetIds: string[],
) {
  if (assetIds.length === 0) return [];
  const assets = await client.query<{ file_id: string }>(
    `SELECT file_id FROM drawing_assets
     WHERE drawing_id = $1 AND file_id = ANY($2::text[]) AND deleted_at IS NULL
     ORDER BY file_id FOR UPDATE`,
    [drawingId, assetIds],
  );
  const found = new Set(assets.rows.map((asset) => asset.file_id));
  return assetIds.filter((assetId) => !found.has(assetId));
}

async function recordMutation(
  client: PoolClient,
  input: {
    drawingId: string;
    mutationId: string;
    payloadHash: Buffer;
    baseRevision: bigint;
    resultingRevision: bigint;
  },
) {
  await client.query(
    `INSERT INTO drawing_mutations
       (drawing_id, mutation_id, payload_hash, base_revision, resulting_revision)
     VALUES ($1, $2, $3, $4::bigint, $5::bigint)`,
    [
      input.drawingId,
      input.mutationId,
      input.payloadHash,
      input.baseRevision.toString(),
      input.resultingRevision.toString(),
    ],
  );
}

function mergeSharedSceneState(
  appState: Record<string, unknown>,
  incoming: PersistMutationInput["event"]["sharedSceneState"],
) {
  if (!incoming) return { appState, changed: false };
  const next = { ...appState, ...incoming };
  return {
    appState: next,
    changed: JSON.stringify(next) !== JSON.stringify(appState),
  };
}

function referencedAssetIds(elements: readonly ExcalidrawElementDTO[]) {
  const ids = new Set<string>();
  for (const element of elements) {
    if (typeof element.fileId === "string" && element.fileId.length > 0) {
      ids.add(element.fileId);
    }
  }
  return [...ids].sort();
}

function mapAsset(row: AssetRow): AssetMetadata {
  return {
    id: row.id,
    drawingId: row.drawing_id,
    fileId: row.file_id,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    sha256: row.sha256.toString("hex"),
    fileVersion: row.file_version,
    createdAt: row.created_at.toISOString(),
  };
}

function notMember() {
  return new SocketSecurityError(
    "SOCKET_NOT_MEMBER",
    "The authenticated user is not a member of this drawing",
  );
}

async function transaction<T>(
  pool: Pool,
  action: (client: PoolClient) => Promise<T>,
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await action(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
