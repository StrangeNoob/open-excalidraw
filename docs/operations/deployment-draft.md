# Single-VPS deployment draft

Status: implementation draft. The production image and migration entrypoint
are present; backup/restore automation and release hardening land in later
waves. Do not treat this document as a release runbook until the release gate
marks it complete.

## Topology

The default Compose project runs the application and PostgreSQL. PostgreSQL has
no host port and sits on an internal backend network that is shared only with
the application. Assets and database data live in named Docker volumes. The
application binds to `127.0.0.1:3000` by default, which is suitable for local
use or for an existing host reverse proxy.

The optional `https` profile adds Caddy on public TCP ports 80 and 443 and UDP
port 443. Caddy handles certificates and forwards HTTP and WebSocket traffic to
the application over the Compose network.

## Prerequisites

- A Linux VPS with Docker Engine and the Docker Compose plugin.
- A DNS A/AAAA record pointing the deployment domain at the VPS when using the
  Caddy profile.
- Firewall access to 80/tcp, 443/tcp, and optionally 443/udp for HTTPS. Do not
  expose PostgreSQL.
- Enough independent disk capacity for both live volumes and backups.

## Configuration

Create a root `.env` file owned by the deployment account with mode `0600`.
Start from `.env.example`, then replace its example credentials and set the
deployment URL/domain:

```dotenv
POSTGRES_DB=open_excalidraw
POSTGRES_USER=open_excalidraw
POSTGRES_PASSWORD=replace-with-a-long-random-password
BETTER_AUTH_SECRET=replace-with-at-least-32-random-characters
ADMIN_RESET_TOKEN=replace-with-another-long-random-token
APP_BASE_URL=https://draw.example.com
DOMAIN=draw.example.com
```

Use URL-safe characters in `POSTGRES_PASSWORD` when Compose constructs the
default `DATABASE_URL`, or set an explicitly percent-encoded `DATABASE_URL`.
Never commit `.env`.

OAuth is off when its client ID or secret is blank. Configure each provider's
callback URL against the final `APP_BASE_URL`; the exact callback paths will be
documented with the authentication module.

SMTP is off when `SMTP_HOST` is blank. In that mode, the application returns
single-use invitation links to an authorized owner for manual copying. Email
verification and ordinary email password reset cannot be delivered; the final
runbook will wrap the administrative one-time reset-link endpoint in an
operator command. Until then, an operator can consume a generated reset URL
exactly once over the loopback-bound application port. First request the reset
for the account (the public response is deliberately non-enumerating), then
consume the server-held one-time URL with the administrative token:

```bash
curl --fail --silent \
  -H "Content-Type: application/json" \
  --data '{"email":"person@example.com","redirectTo":"https://draw.example.com/reset-password"}' \
  http://127.0.0.1:3000/api/auth/request-password-reset

curl --fail --silent \
  -H "Authorization: Bearer $ADMIN_RESET_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"email":"person@example.com"}' \
  http://127.0.0.1:3000/api/admin/manual-reset-links/consume
```

The manual reset store is process-local and intentionally one-time; restarting
the application discards unconsumed URLs. Request a new reset after a restart.

When SMTP is enabled, prefer port 465 with `SMTP_SECURE=true` or port 587 with
STARTTLS, and use a restricted credential.

## Startup

The plain local/reverse-proxy shape will use:

```bash
docker compose pull
docker compose up -d
docker compose ps
```

The standalone HTTPS shape will use:

```bash
docker compose --profile https pull
docker compose --profile https up -d
docker compose --profile https ps
```

For managed PostgreSQL, set `DATABASE_URL` and apply the overlay; the bundled
database service remains disabled and no `POSTGRES_PASSWORD` is required:

```bash
docker compose -f compose.yaml -f compose.managed.yaml up -d
```

Compose waits for PostgreSQL before starting the application. The application
entrypoint takes a PostgreSQL advisory lock, applies checksum-verified
migrations, starts the server, and exposes `/health/live` and `/health/ready`.
Do not automate upgrades until backup and rollback behavior is verified.

## Network and filesystem security

- PostgreSQL declares no `ports`, so it is reachable only from containers on
  the project network.
- The asset volume is mounted only into the application container.
- The application host binding defaults to loopback. Set
  `APP_BIND_ADDRESS=0.0.0.0` only when direct HTTP exposure is intentional and
  protected elsewhere.
- The application and Caddy filesystems are read-only except for explicit
  volumes and small `/tmp` mounts. Linux capabilities are dropped.
- Restrict Docker daemon access; membership in the `docker` group is equivalent
  to root access.
- Terminate TLS before authentication traffic and keep the same canonical
  origin for the web UI, REST API, and collaboration socket.

## Data, backup, and restore boundary

The data set is the consistent pair of `postgres-data` and `asset-data`. A
usable backup must include both, be encrypted, leave the VPS, and have a tested
restore procedure. Copying only the asset volume or only a database dump can
leave drawing metadata and binary references inconsistent.

Until automated scripts land, schedule neither ad-hoc volume copies nor live
filesystem snapshots as if they were supported backups. The release runbook
will define:

1. A PostgreSQL logical dump with checksum.
2. An asset archive or snapshot from a quiescent/checkpointed point.
3. Encryption, off-host retention, and rotation.
4. Restore into a separate Compose project.
5. Migration, asset-reference, login, and drawing smoke checks after restore.

## Updating and rollback boundary

Pin a released application image rather than `latest`. Read release notes and
back up before each update. Database migrations are forward-only; rollback is
therefore an application-plus-data restoration operation unless a release
explicitly documents backward compatibility.

The managed PostgreSQL overlay is available. S3-compatible storage remains a
later adapter. Moving storage does not change the public application/Caddy
topology, but must be verified through the same storage contract and restore
tests.
