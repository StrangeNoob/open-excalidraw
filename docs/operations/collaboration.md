# Collaboration operations

Open Excalidraw serves Socket.IO from the same origin as the web application
and REST API. The collaboration gateway is intentionally server-authoritative:
the session cookie, drawing membership, role, scene snapshot, revision, and
asset manifest all come from backend services. Client-supplied identity or role
claims are rejected.

## Connection lifecycle

1. The HTTP upgrade must carry an allowed `Origin` and an active session
   cookie.
2. The client emits `room.join` with protocol version `1`, its drawing ID,
   client instance ID, and optional last observed revision.
3. The gateway resolves membership and loads the canonical PostgreSQL
   snapshot. It then emits `room.ready` and joins the Socket.IO drawing room.
4. A revision mismatch emits `room.resyncRequired` before the authoritative
   `room.ready` snapshot. The snapshot never comes from another browser.
5. Every later preview, mutation, and presence event revalidates the session.
   Mutation and preview services additionally recheck live membership.
6. Disconnect removes the connection from the room registry and presence
   roster.

Viewers join normally and receive snapshots, previews, committed mutations,
and roster updates. They may publish rate-limited presence only. Raw preview or
mutation events from a viewer receive a structured `SOCKET_EVENT_FORBIDDEN`
error.

## Durability and ordering

`scene.preview` is volatile and never changes the content revision. A
`scene.mutate` request enters the per-connection bounded queue and is handed to
the transactional mutation service. The gateway broadcasts `scene.committed`
only after that service returns a committed outcome. Duplicate and no-op
outcomes are acknowledged only to the originating connection. An exception or
database rollback produces a structured error and no room broadcast.

The queue serializes events from each connection. Its default maximum is 64
pending operations. Crossing the limit emits `SOCKET_BACKPRESSURE_LIMIT` and
disconnects the flooding connection, preventing unbounded process memory. The
gateway also disconnects after repeated malformed or forbidden events; tune
these limits only together with load tests and memory monitoring.

## Permission changes

The room registry publishes role and revocation changes:

- A role change replaces the immutable socket binding and emits
  `room.roleChanged`. The next queued event uses the new role.
- Revocation emits a structured `SOCKET_MEMBERSHIP_REVOKED` error and forcibly
  disconnects the affected connection.
- An authoritative membership recheck that returns no role is treated as a
  revocation even if a registry notification was delayed.
- Session expiry or server-side session revocation is checked for every event
  and disconnects the socket.

## Monitoring

Production observability should instrument and track at least these signals;
the initial release does not yet ship a metrics exporter:

- active connections and rooms;
- joins, disconnect reasons, and reconnect rate;
- preview/presence rate-limit drops;
- per-connection queue depth and backpressure disconnects;
- mutation latency, commit/duplicate/no-op counts, and transaction failures;
- protocol errors by code;
- forced resyncs and role/revocation events.

Never log session cookies, complete scenes, invitation tokens, or raw asset
data. Logs should use request/connection ID, drawing ID, user ID, event type,
revision, latency, and stable error code.

## Deployment and scaling

The single-VPS Docker Compose deployment runs one collaboration server process,
so its in-memory room registry and presence roster are authoritative for that
process. Graceful shutdown should stop new upgrades, emit a server-restart
resync instruction when possible, disconnect sockets, and only then close the
HTTP server.

Before running multiple application replicas, add a Socket.IO-compatible
shared adapter and a shared presence/role-change bus (for example Redis), then
verify cross-replica commit ordering and revocation. PostgreSQL remains the
durable source of truth. Do not scale replicas independently with only sticky
sessions: a commit, downgrade, or revocation on one replica must reach sockets
on every replica.

## Incident checks

When clients do not converge:

1. Compare the client's last acknowledged revision with the PostgreSQL content
   revision.
2. Look for `room.resyncRequired`, backpressure disconnects, and transaction
   errors for the connection.
3. Confirm the mutation committed before any corresponding broadcast.
4. Reconnect one client and verify its `room.ready` snapshot matches the REST
   content endpoint.

When access appears stale, revoke the session or membership, confirm the
registry notification was observed, and verify the socket disconnected. Treat
any post-revocation mutation broadcast as a security incident.
