import {
  collaboratorSchema,
  presenceUpdateEventSchema,
  protocolErrorEventSchema,
  serverRealtimeEventSchema,
  type ClientRealtimeEvent,
} from "@open-excalidraw/contracts";
import { io, type Socket } from "socket.io-client";
import { z } from "zod";

import type {
  RealtimeProblem,
  RealtimeTransport,
  RealtimeTransportHandlers,
} from "./types";

const SERVER_EVENTS = [
  "room.ready",
  "scene.preview",
  "scene.committed",
  "scene.ack",
  "room.roleChanged",
  "room.resyncRequired",
  "protocol.error",
] as const;

const presenceBroadcastSchema = z
  .object({
    connectionId: z.string().min(1).max(128),
    presence: presenceUpdateEventSchema,
  })
  .strict();
const presenceRosterSchema = z
  .object({ collaborators: z.array(collaboratorSchema) })
  .strict();

export interface SocketIoTransportOptions {
  path?: string;
  socket?: Socket;
  url?: string;
}

export class SocketIoTransport implements RealtimeTransport {
  readonly #socket: Socket;
  #handlers: RealtimeTransportHandlers | null = null;

  constructor({
    path = "/socket.io",
    socket,
    url,
  }: SocketIoTransportOptions = {}) {
    this.#socket =
      socket ??
      io(url, {
        autoConnect: false,
        path,
        transports: ["websocket", "polling"],
        withCredentials: true,
      });
    this.#bind();
  }

  setHandlers(handlers: RealtimeTransportHandlers | null): void {
    this.#handlers = handlers;
  }

  connect(): void {
    this.#socket.connect();
  }

  disconnect(): void {
    this.#socket.disconnect();
  }

  emit(event: ClientRealtimeEvent): void {
    this.#socket.emit(event.type, event);
  }

  #bind() {
    this.#socket.on("connect", () => this.#handlers?.onConnect());
    this.#socket.on("disconnect", (reason) =>
      this.#handlers?.onDisconnect(String(reason)),
    );
    this.#socket.on("connect_error", (error) =>
      this.#handlers?.onError(toTransportProblem(error)),
    );
    for (const eventName of SERVER_EVENTS) {
      this.#socket.on(eventName, (value: unknown) => {
        const parsed = serverRealtimeEventSchema.safeParse(value);
        if (parsed.success) {
          this.#handlers?.onServerEvent(parsed.data);
        }
      });
    }
    this.#socket.on("presence.updated", (value: unknown) => {
      const parsed = presenceBroadcastSchema.safeParse(value);
      if (parsed.success) {
        this.#handlers?.onPresence(parsed.data);
      }
    });
    this.#socket.on("presence.roster", (value: unknown) => {
      const parsed = presenceRosterSchema.safeParse(value);
      if (parsed.success) {
        this.#handlers?.onRoster(parsed.data.collaborators);
      }
    });
  }
}

export const toTransportProblem = (error: Error): RealtimeProblem => {
  const data = (error as Error & { data?: unknown }).data;
  const parsed = protocolErrorEventSchema.safeParse(data);
  if (parsed.success) {
    return {
      code: parsed.data.code,
      message: parsed.data.message,
      requestId: parsed.data.requestId,
      retryable: parsed.data.retryable,
    };
  }
  return {
    code: "SOCKET_CONNECTION_ERROR",
    message: error.message || "Could not connect to collaboration",
    requestId: "socket-client",
    retryable: true,
  };
};
