export type SocketSecurityErrorCode =
  | "REALTIME_REQUIRES_SESSION"
  | "SOCKET_EVENT_FORBIDDEN"
  | "SOCKET_FORGED_AUTHORIZATION"
  | "SOCKET_NOT_MEMBER"
  | "SOCKET_ORIGIN_DENIED"
  | "SOCKET_SESSION_EXPIRED"
  | "SOCKET_SESSION_REVOKED"
  | "SOCKET_UNAUTHENTICATED";

export class SocketSecurityError extends Error {
  public readonly code: SocketSecurityErrorCode;

  public constructor(code: SocketSecurityErrorCode, message: string) {
    super(message);
    this.name = "SocketSecurityError";
    this.code = code;
  }
}
