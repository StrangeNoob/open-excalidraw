import type { Collaborator, SocketId } from "@excalidraw/excalidraw/types";
import type {
  ClientRealtimeEvent,
  Role,
  ServerRealtimeEvent,
} from "@open-excalidraw/contracts";

export type RoomReadyEvent = Extract<
  ServerRealtimeEvent,
  { type: "room.ready" }
>;
export type SceneCommittedEvent = Extract<
  ServerRealtimeEvent,
  { type: "scene.committed" }
>;
export type SceneAckEvent = Extract<ServerRealtimeEvent, { type: "scene.ack" }>;
export type ScenePreviewEvent = Extract<
  ServerRealtimeEvent,
  { type: "scene.preview" }
>;
export type PresenceUpdateEvent = Extract<
  ClientRealtimeEvent,
  { type: "presence.update" }
>;

export interface PresenceBroadcast {
  connectionId: string;
  presence: PresenceUpdateEvent;
}

export interface RealtimeProblem {
  code: string;
  message: string;
  requestId: string;
  retryable: boolean;
}

export type CollaborationStatus =
  | "idle"
  | "connecting"
  | "joining"
  | "ready"
  | "reconnecting"
  | "disconnected"
  | "error";

export interface CollaborationState {
  collaborators: Map<SocketId, Collaborator>;
  error: RealtimeProblem | null;
  revision: string;
  role: Role | null;
  status: CollaborationStatus;
}

export interface RealtimeTransportHandlers {
  onConnect(): void;
  onDisconnect(reason: string): void;
  onError(error: RealtimeProblem): void;
  onPresence(event: PresenceBroadcast): void;
  onRoster(collaborators: RoomReadyEvent["collaborators"]): void;
  onServerEvent(event: ServerRealtimeEvent): void;
}

export interface RealtimeTransport {
  connect(): void;
  disconnect(): void;
  emit(event: ClientRealtimeEvent): void;
  setHandlers(handlers: RealtimeTransportHandlers | null): void;
}
