<p align="center">
  <picture>
    <source
      media="(prefers-color-scheme: dark)"
      srcset="docs/brand/wordmark-dark.svg"
    />
    <img src="docs/brand/wordmark.svg" alt="Open Excalidraw" width="460" />
  </picture>
</p>

Open Excalidraw is a self-hostable collaboration and persistence layer built
around the published `@excalidraw/excalidraw` React package.

The current implementation includes guest IndexedDB persistence, email/password
authentication, optional Google, GitHub, and generic OIDC
(Keycloak/Authentik/Authelia) sign-in configuration, named drawing
dashboards with private per-user tags, email-based invitations,
owner/editor/viewer permissions, PostgreSQL persistence, binary asset storage
(local volume or any S3-compatible bucket, with a migration CLI between them),
conflict-safe revisioned autosave with revision history and restore,
authenticated real-time editing, per-drawing chat with persistent history, an
account settings page, and interactive API documentation. It ships as a
single-VPS production image with an optional managed PostgreSQL override.

See the
[platform design](docs/design/open-excalidraw-platform-design.md) and
[implementation plan](docs/plans/open-excalidraw-implementation-plan.md). The
[collaboration runbook](docs/operations/collaboration.md) documents the realtime
protocol, permission enforcement, monitoring, and scaling boundary. The
[storage runbook](docs/operations/storage.md) covers local and S3-compatible
asset storage and driver migration.

## API documentation

Every deployment serves interactive Swagger UI documentation for the REST API
at `/api/docs`, backed by the OpenAPI specification at `/api/docs/openapi.json`.
The spec covers authentication, drawings, scene content and revisions, sharing,
chat history, and binary assets; realtime editing and chat delivery use
Socket.IO and are documented in the collaboration runbook.

Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). Report
security issues privately using [SECURITY.md](SECURITY.md).

This is an independent community project and is not affiliated with or endorsed
by the Excalidraw project. Open Excalidraw is released under the
[MIT License](LICENSE). The editor dependency's license notice is preserved
in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Run with Docker Compose

```bash
cp .env.example .env
# Replace POSTGRES_PASSWORD, BETTER_AUTH_SECRET, and ADMIN_RESET_TOKEN in .env.
docker compose up --build -d
```

Prebuilt multi-architecture images are published to
`ghcr.io/strangenoob/open-excalidraw` on every `main` push and release tag;
set `OPEN_EXCALIDRAW_IMAGE` in `.env` to deploy without building locally. See
the deployment runbook for details.

The application binds to `127.0.0.1:3000` by default. PostgreSQL and binary
asset storage use private named volumes. SMTP is optional: when it is absent,
owners can copy invitation links for manual delivery. Email verification and
ordinary reset-email delivery require SMTP; a loopback-only operator recovery
flow is documented for SMTP-disabled installations. Set `ADMIN_EMAILS` to a
comma-separated allowlist to unlock the admin page (instance counts plus a user
list with disable and delete). Each admin's account email must be verified —
via the SMTP verification email or an OAuth/OIDC sign-in — so with SMTP disabled
and password-only auth, admin access requires an OAuth/OIDC-verified account.
Set `DISABLE_SIGNUPS=true` to block all new account registration
(email/password and OAuth/OIDC) while existing users keep signing in; it
defaults to `false`. See the
[deployment runbook](docs/operations/deployment.md) for HTTPS, managed
database, and one-click Railway template options.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/open-excalidraw)

## Local development

Node.js 22.12 or newer, pnpm 10.11.1, and PostgreSQL 17 are recommended.

```bash
pnpm install
createdb -h localhost -p 5432 open_excalidraw
DATABASE_URL=postgresql://localhost/open_excalidraw pnpm --filter @open-excalidraw/database db:migrate
cp .env.example .env
# Set DATABASE_URL, BETTER_AUTH_SECRET, and ADMIN_RESET_TOKEN in .env.
pnpm dev
```

`db:migrate` creates and updates tables inside an existing PostgreSQL database;
it does not create the database itself. If `createdb` reports that the database
already exists, continue with the migration command.

`pnpm dev` automatically loads the repository-root `.env`; running
`source .env` is not required.

## Workspace commands

```bash
pnpm install
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm build
```
