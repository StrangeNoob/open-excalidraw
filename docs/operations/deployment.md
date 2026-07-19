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

## One-click Railway template

The prebuilt image also powers a Railway template, so a deployment needs no
VPS: an `app` service running
`ghcr.io/strangenoob/open-excalidraw:latest` with a volume mounted at
`/data/assets`, plus Railway's managed PostgreSQL. The `app` service is
exposed publicly with the domain's target port set to 3000 explicitly — the
image listens on `APP_PORT` (default 3000), not the `PORT` variable Railway
auto-detects — and must stay at one replica (the collaboration registry is
in-process).

Template variables on the `app` service:

```dotenv
APP_BASE_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}
DATABASE_URL=${{Postgres.DATABASE_URL}}
BETTER_AUTH_SECRET=${{secret(32)}}
ADMIN_RESET_TOKEN=${{secret(32)}}
STORAGE_DRIVER=local
STORAGE_LOCAL_PATH=/data/assets
PORT=3000
```

`PORT` does not configure the application — it tells Railway which port to
probe for the `/health/ready` deployment healthcheck (without it every
healthcheck attempt returns `service unavailable` and the deploy fails after
the five-minute window).

`${{secret(32)}}` generates a fresh value for each deployment, and
`RAILWAY_PUBLIC_DOMAIN` resolves to the deployment's generated domain, so
authentication and socket-origin checks work without manual configuration.
The `${{Postgres.DATABASE_URL}}` reference is case-sensitive and resolves
only while the database service is named exactly `Postgres`; rename the
reference if the service is renamed.
Leave the OAuth, OIDC, SMTP, and S3 variables out of the template; deployers
add them afterwards following this runbook. Without SMTP, invitation links
remain copyable, and the loopback recovery flow runs from a shell inside the
container (`railway ssh`).

Maintainers create and publish the template from the production project:

```sh
railway templates create --project open-excalidraw --json
```

Template generation blanks every literal variable value on **all** services
(only `${{...}}` references survive). Before publishing, open the template in
the dashboard composer and, on `app`, set the definitions above and delete
the instance-specific OAuth/OIDC/SMTP entries. On `Postgres`, restore the
blanked literals — `POSTGRES_USER=postgres`, `POSTGRES_DB=railway`,
`PGDATA=/var/lib/postgresql/data/pgdata`, `PGPORT=5432`, `SSL_CERT_DAYS=820`
— or the deployed database boots with an empty username and the app fails
its migrations. Then:

```sh
railway templates publish <template-id> --category Starters \
  --description "Self-hostable collaborative drawing built on Excalidraw" \
  --readme-file docs/operations/railway-template-overview.md --json
```

Publishing returns the template code; link it from the README:

```md
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/<template-code>)
```

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

Set `DISABLE_SIGNUPS=true` to block all new account registration —
email/password, Google, GitHub, and OIDC alike — while existing users keep
signing in. It defaults to `false` (open registration).

Set `ADMIN_EMAILS` to a comma-separated allowlist to grant those accounts the
admin page — an instance overview (users, drawings, storage) plus a user list
with disable, enable, and delete. Disabling revokes a user's sessions and
blocks new sign-ins; deleting purges the drawings they own (storage included)
and removes the account. Leave `ADMIN_EMAILS` blank to keep every admin
endpoint returning `403`.

An allowlisted account only becomes admin once its email is **verified** —
registration does not verify email, so an unverified match (for example an
attacker who signed up under a configured-but-unregistered admin address) is
denied. Verify via the SMTP verification email, or by signing in through
Google/GitHub/OIDC (those providers supply a verified email). With SMTP disabled
and password-only auth, admin access therefore requires an OAuth/OIDC account.

Set `METRICS_TOKEN` to a long random string to enable `GET /metrics`, a
Prometheus text-format endpoint authenticated with that value as a bearer
token (`authorization: Bearer <token>` — Prometheus scrape configs support
this natively). It reports user/drawing/storage totals, unexpired sessions,
live collaboration connections, and the counters from the most recent
maintenance run. Leave it blank to keep the endpoint answering `404`.

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
