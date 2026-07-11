# Open Excalidraw

Open Excalidraw is a self-hostable collaboration and persistence layer built
around the published `@excalidraw/excalidraw` React package.

The current implementation includes guest IndexedDB persistence, email/password
authentication, optional Google and GitHub OAuth configuration, named drawing
dashboards, email-based invitations, owner/editor/viewer permissions,
PostgreSQL persistence, binary asset storage, conflict-safe revisioned autosave,
and authenticated real-time editing. It ships as a single-VPS production image
with an optional managed PostgreSQL override.

See the
[platform design](docs/design/open-excalidraw-platform-design.md) and
[implementation plan](docs/plans/open-excalidraw-implementation-plan.md). The
[collaboration runbook](docs/operations/collaboration.md) documents the realtime
protocol, permission enforcement, monitoring, and scaling boundary.

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

The application binds to `127.0.0.1:3000` by default. PostgreSQL and binary
asset storage use private named volumes. SMTP is optional: when it is absent,
owners can copy invitation links for manual delivery. Email verification and
ordinary reset-email delivery require SMTP; a loopback-only operator recovery
flow is documented for SMTP-disabled installations.
See the
[deployment runbook](docs/operations/deployment.md) for HTTPS and managed
database options.

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
