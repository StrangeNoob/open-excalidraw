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
[deployment draft](docs/operations/deployment-draft.md) for HTTPS and managed
database options.

## Local development

Node.js 22.12 or newer, pnpm 10.11.1, and PostgreSQL 17 are recommended.

```bash
pnpm install
DATABASE_URL=postgresql://localhost/open_excalidraw pnpm --filter @open-excalidraw/database db:migrate
DATABASE_URL=postgresql://localhost/open_excalidraw \
BETTER_AUTH_SECRET=replace-with-at-least-32-random-characters \
ADMIN_RESET_TOKEN=replace-with-another-32-random-characters \
pnpm dev
```

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
