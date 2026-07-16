# Single-VPS deployment

This runbook deploys the supported release shape: one application container,
PostgreSQL 17, and local binary-asset storage on one VPS. Caddy is an optional
Compose profile that terminates HTTPS and proxies both HTTP and Socket.IO.

## Prerequisites

- A Linux VPS with Docker Engine and Docker Compose.
- A DNS A/AAAA record pointing at the VPS for public HTTPS.
- Inbound 80/tcp and 443/tcp; 443/udp is optional for HTTP/3.
- Independent, encrypted off-host backup storage.

Do not publish PostgreSQL. The default Compose file places it on an internal
network and exposes only the application loopback port.

## Prebuilt images

Multi-architecture (linux/amd64, linux/arm64) images are published to GitHub
Container Registry on every `main` push and on `v*` release tags:

```text
ghcr.io/strangenoob/open-excalidraw:<tag>
```

Tags: `latest` tracks `main`, `v*` release tags publish their version, and
every build is also addressable as `sha-<commit>` for immutable pins. To
deploy without building locally, set the image in `.env` and start Compose
without `--build`:

```dotenv
OPEN_EXCALIDRAW_IMAGE=ghcr.io/strangenoob/open-excalidraw:latest
```

The image is self-contained: it serves the web UI, REST API, and Socket.IO
from port 3000, and its entrypoint applies database migrations before start.
On Kubernetes, run it as a single-replica Deployment (the collaboration
registry is in-process; see the [collaboration runbook](collaboration.md)
before scaling out), provide `DATABASE_URL`, `BETTER_AUTH_SECRET`,
`APP_BASE_URL`, and either SMTP or `ADMIN_RESET_TOKEN`, mount a persistent
volume at the `STORAGE_LOCAL_PATH` asset path, and probe `/health/live` and
`/health/ready`.

## Configure

Clone a tagged release, copy `.env.example` to `.env`, set mode `0600`, and
replace every placeholder secret:

```sh
cp .env.example .env
chmod 0600 .env
```

At minimum, configure:

```dotenv
POSTGRES_PASSWORD=a-long-url-safe-random-password
BETTER_AUTH_SECRET=at-least-32-random-characters
ADMIN_RESET_TOKEN=another-long-random-token
APP_BASE_URL=https://draw.example.com
DOMAIN=draw.example.com
```

If the database password is not URL-safe, set `DATABASE_URL` with a
percent-encoded password. OAuth providers are disabled when their client ID or
secret is blank. SMTP is disabled when `SMTP_HOST` is blank; invitation links
remain available for an owner to copy manually.

Provider callback URLs must use the final `APP_BASE_URL`:
`https://draw.example.com/api/auth/callback/google` and
`https://draw.example.com/api/auth/callback/github`. Keep the UI, REST API,
and collaboration socket on the same canonical origin.

A generic OIDC provider (Keycloak, Authentik, Authelia, ...) is configured
with `OIDC_ISSUER_URL` (issuer base URL or full discovery URL),
`OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, and the optional
`OIDC_PROVIDER_NAME` sign-in button label. The redirect URI to register at
the identity provider is
`https://draw.example.com/api/auth/oauth2/callback/oidc` — note it differs
from the `/api/auth/callback/<provider>` pattern used by Google and GitHub.
The provider is disabled when the issuer URL, client ID, or secret is blank.
The issuer URL must use HTTPS; plain HTTP is accepted only for loopback
hosts so a local identity provider works in development. Discovery is
fetched at each sign-in start, so identity-provider downtime only fails new
sign-ins.

## S3-compatible object storage

Assets default to the local volume at `STORAGE_LOCAL_PATH`. Set
`STORAGE_DRIVER=s3` to store them in any S3-compatible bucket instead — AWS
S3, Cloudflare R2, MinIO, Backblaze B2, DigitalOcean Spaces, or Wasabi:

```dotenv
STORAGE_DRIVER=s3
S3_BUCKET=open-excalidraw-assets
S3_REGION=auto                # R2 uses "auto"; AWS needs a real region
S3_ENDPOINT=                  # omit for AWS; see .env.example for providers
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_FORCE_PATH_STYLE=false     # true for MinIO
```

With the `s3` driver, `STORAGE_LOCAL_PATH` and the persistent asset volume
are unused, so the container needs no writable mounts. The deployment must
still run as a single replica: the collaboration registry is in-process (see
the [collaboration runbook](collaboration.md)).

### Migrating existing assets between drivers

The image ships `migrate-assets.mjs`, which copies every live asset between
the local volume and the S3 bucket in either direction. It enumerates from
the database (only referenced assets move), verifies each copy against the
recorded checksum, and skips assets already at the destination — so it is
safe to re-run after an interruption.

Run it inside the container with **both** storage configurations present
(`STORAGE_LOCAL_PATH` and the `S3_*` variables), before switching
`STORAGE_DRIVER`:

```sh
node migrate-assets.mjs --from local --to s3 --dry-run   # list what would move
node migrate-assets.mjs --from local --to s3             # copy volume -> bucket
node migrate-assets.mjs --from s3 --to local             # copy bucket -> volume
```

The command prints one line per asset and a
`copied/skipped/missing/failed` summary, exiting non-zero when any copy
failed. Once it reports success, flip `STORAGE_DRIVER` and redeploy; the
source location can be retired afterwards.

## Start with built-in HTTPS

```sh
docker compose --profile https pull
docker compose --profile https up -d
docker compose --profile https ps
curl --fail https://draw.example.com/health/ready
```

Caddy obtains and renews certificates automatically. Its data and config are
persisted in named volumes. WebSocket upgrades need no special Caddy route;
`reverse_proxy` supports them. Set `APP_BASE_URL` and `DOMAIN` to the same
public host or authentication and strict socket-origin checks will reject the
browser.

For an existing host reverse proxy, omit the `https` profile. The application
binds to `127.0.0.1:3000` by default:

```sh
docker compose up -d
curl --fail http://127.0.0.1:3000/health/ready
```

Forward the original host and scheme, support WebSocket upgrades, and use TLS
at the public edge. Do not set `APP_BIND_ADDRESS=0.0.0.0` unless a firewall or
private network intentionally protects the direct port.

## Health and shutdown

- `/health/live` reports that the HTTP process is running.
- `/health/ready` also checks database readiness and is the endpoint used by
  Compose.
- The application handles `SIGTERM`, closes the collaboration gateway and
  sockets, then closes the database pool. Compose grants it 30 seconds.
- PostgreSQL receives a 60-second stop grace period.

Investigate a failing readiness check before restarting repeatedly:

```sh
docker compose ps
docker compose logs --tail=200 app postgres
docker compose --profile https logs --tail=200 caddy
```

## Update

Pin `OPEN_EXCALIDRAW_IMAGE` to a release tag or immutable digest rather than
`latest`. Read release notes and create an off-host backup before every update:

```sh
./ops/backup.sh /secure-staging/open-excalidraw-$(date -u +%Y%m%dT%H%M%SZ)
docker compose --profile https pull
docker compose --profile https up -d
docker compose --profile https ps
```

The application entrypoint obtains a PostgreSQL advisory lock and applies
checksum-verified forward migrations before starting. Database rollback is a
restore of the pre-update backup unless a release explicitly documents
backward compatibility. See [Backup and restore](backup-restore.md) for the
full procedure and required post-restore checks.

## Managed PostgreSQL

Set `DATABASE_URL` to a TLS-protected managed PostgreSQL connection and apply
the overlay:

```sh
docker compose -f compose.yaml -f compose.managed.yaml --profile https up -d
```

The overlay disables the bundled database. Use the provider's point-in-time
recovery plus regular independent logical dumps. The bundled-database
`ops/backup.sh` and `ops/restore.sh` intentionally refuse this topology; do not
mistake a local asset-only archive for a complete backup.

## SMTP-disabled password recovery

The public reset request is deliberately non-enumerating. An operator can
consume the process-local, one-time URL over the loopback-bound port:

```sh
curl --fail --silent \
  -H 'Content-Type: application/json' \
  --data '{"email":"person@example.com","redirectTo":"https://draw.example.com/reset-password"}' \
  http://127.0.0.1:3000/api/auth/request-password-reset

curl --fail --silent \
  -H "Authorization: Bearer $ADMIN_RESET_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"email":"person@example.com"}' \
  http://127.0.0.1:3000/api/admin/manual-reset-links/consume
```

Restarting the app discards unconsumed manual URLs. Request a new reset after a
restart.
