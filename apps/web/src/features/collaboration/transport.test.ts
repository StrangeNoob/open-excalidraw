import type { Socket } from "socket.io-client";

import { SocketIoTransport, toTransportProblem } from "./transport";

describe("Socket.IO transport errors", () => {
  it("preserves structured upgrade rejection details", () => {
    const error = Object.assign(new Error("rejected"), {
      data: {
        code: "SOCKET_ORIGIN_DENIED",
        message: "The socket Origin is not trusted",
        requestId: "request-1",
        retryable: false,
        type: "protocol.error",
      },
    });

    expect(toTransportProblem(error)).toEqual({
      code: "SOCKET_ORIGIN_DENIED",
      message: "The socket Origin is not trusted",
      requestId: "request-1",
      retryable: false,
    });
  });

  it("uses a safe fallback for unstructured transport failures", () => {
    expect(toTransportProblem(new Error("network down"))).toEqual({
      code: "SOCKET_CONNECTION_ERROR",
      message: "network down",
      requestId: "socket-client",
      retryable: true,
    });
  });
});

describe("Socket.IO transport chat binding", () => {
  const message = {
    id: "10000000-0000-4000-8000-000000000001",
    drawingId: "10000000-0000-4000-8000-000000000002",
    userId: "10000000-0000-4000-8000-000000000003",
    authorName: "Ada",
    body: "hello",
    createdAt: "2026-07-15T00:00:00.000Z",
  };

  function createFakeSocket() {
    const listeners = new Map<string, (value: unknown) => void>();
    const socket = {
      connect: () => socket,
      disconnect: () => socket,
      emit: () => socket,
      on: (event: string, listener: (value: unknown) => void) => {
        listeners.set(event, listener);
        return socket;
      },
    };
    return {
      socket: socket as unknown as Socket,
      fire: (event: string, value: unknown) => listeners.get(event)?.(value),
    };
  }

  it("multicasts valid chat messages and honors unsubscribe", () => {
    const fake = createFakeSocket();
    const transport = new SocketIoTransport({ socket: fake.socket });
    const first: unknown[] = [];
    const second: unknown[] = [];
    const unsubscribeFirst = transport.onChatMessage((m) => first.push(m));
    transport.onChatMessage((m) => second.push(m));

    fake.fire("chat.message", { type: "chat.message", message });
    unsubscribeFirst();
    fake.fire("chat.message", { type: "chat.message", message });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(2);
    expect(first[0]).toEqual(message);
  });

  it("drops malformed chat payloads", () => {
    const fake = createFakeSocket();
    const transport = new SocketIoTransport({ socket: fake.socket });
    const received: unknown[] = [];
    transport.onChatMessage((m) => received.push(m));

    fake.fire("chat.message", { type: "chat.message" });
    fake.fire("chat.message", {
      type: "chat.message",
      message: { ...message, body: "" },
    });

    expect(received).toHaveLength(0);
  });
});
