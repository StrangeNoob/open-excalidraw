import { toTransportProblem } from "./transport";

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
