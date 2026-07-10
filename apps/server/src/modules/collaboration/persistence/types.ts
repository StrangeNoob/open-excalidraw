import type {
  AssetMetadata,
  ClientRealtimeEvent,
  ExcalidrawElementDTO,
  Role,
  SceneEnvelope,
  ServerRealtimeEvent,
} from "@open-excalidraw/contracts";

import type { SocketAuthorizationBinding } from "../../collaboration/security/index.js";

export type SceneMutateEvent = Extract<
  ClientRealtimeEvent,
  { type: "scene.mutate" }
>;
export type SceneCommittedEvent = Extract<
  ServerRealtimeEvent,
  { type: "scene.committed" }
>;
export type SceneAckEvent = Extract<ServerRealtimeEvent, { type: "scene.ack" }>;

export interface PersistMutationInput {
  binding: SocketAuthorizationBinding;
  event: SceneMutateEvent;
  payloadHash: Buffer;
}

export type PersistMutationResult =
  | {
      status: "committed";
      revision: bigint;
      elements: ExcalidrawElementDTO[];
      sharedSceneState?: SceneMutateEvent["sharedSceneState"];
    }
  | { status: "duplicate"; revision: bigint }
  | { status: "noop"; revision: bigint };

export interface CollaborationSnapshot {
  drawingId: string;
  role: Role;
  revision: bigint;
  snapshot: SceneEnvelope;
  assetManifest: AssetMetadata[];
}

export interface CollaborationSnapshotProvider {
  loadSnapshot(
    drawingId: string,
    userId: string,
  ): Promise<CollaborationSnapshot | null>;
}

export interface MutationRepository extends CollaborationSnapshotProvider {
  persist(input: PersistMutationInput): Promise<PersistMutationResult>;
}

export type MutationOutcome =
  | { kind: "committed"; event: SceneCommittedEvent }
  | { kind: "ack"; event: SceneAckEvent };
