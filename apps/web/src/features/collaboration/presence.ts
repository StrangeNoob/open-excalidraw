import type { Collaborator, SocketId } from "@excalidraw/excalidraw/types";
import type { PresenceUpdateEvent, RoomReadyEvent } from "./types";

type WireCollaborator = RoomReadyEvent["collaborators"][number];

export const createCollaboratorMap = (
  collaborators: readonly WireCollaborator[],
): Map<SocketId, Collaborator> =>
  new Map(
    collaborators.map((collaborator) => [
      collaborator.connectionId as SocketId,
      toExcalidrawCollaborator(collaborator),
    ]),
  );

export const updateCollaboratorPresence = (
  collaborators: ReadonlyMap<SocketId, Collaborator>,
  connectionId: string,
  presence: PresenceUpdateEvent,
): Map<SocketId, Collaborator> => {
  const next = new Map(collaborators);
  const socketId = connectionId as SocketId;
  const current = next.get(socketId) ?? { socketId };
  next.set(socketId, {
    ...current,
    ...(presence.pointer ? { pointer: presence.pointer } : {}),
    ...(presence.button ? { button: presence.button } : {}),
    ...(presence.selectedElementIds
      ? { selectedElementIds: presence.selectedElementIds }
      : {}),
    ...(presence.idleState
      ? { userState: presence.idleState as Collaborator["userState"] }
      : {}),
  });
  return next;
};

const toExcalidrawCollaborator = (
  collaborator: WireCollaborator,
): Collaborator => ({
  avatarUrl: collaborator.image ?? undefined,
  color: colorFor(collaborator.userId),
  id: collaborator.userId,
  socketId: collaborator.connectionId as SocketId,
  username: collaborator.name,
});

const colorFor = (value: string) => {
  let hash = 0;
  for (const character of value) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  const hue = hash % 360;
  return {
    background: `hsl(${hue} 80% 92%)`,
    stroke: `hsl(${hue} 65% 42%)`,
  };
};
