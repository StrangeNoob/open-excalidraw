# Open Excalidraw

Open Excalidraw is a self-hostable collaboration and persistence layer built
around the published `@excalidraw/excalidraw` React package.

The current implementation includes guest IndexedDB persistence, email/password
authentication, optional Google and GitHub OAuth configuration, named drawing
dashboard APIs/UI, owner/editor/viewer capabilities, PostgreSQL persistence,
binary asset storage, and a single-VPS production image. Real-time editing,
sharing invitations, and revision history are the next implementation waves.

See the
[platform design](docs/design/open-excalidraw-platform-design.md) and
[implementation plan](docs/plans/open-excalidraw-implementation-plan.md).

## Run with Docker Compose

```bash
cp .env.example .env
# Replace POSTGRES_PASSWORD, BETTER_AUTH_SECRET, and ADMIN_RESET_TOKEN in .env.
docker compose up --build -d
```

The application binds to `127.0.0.1:3000` by default. PostgreSQL and asset
storage are private named volumes. See the
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
