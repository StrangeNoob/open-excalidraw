# Contributing to Open Excalidraw

Thank you for helping improve Open Excalidraw. Keep changes focused, include
tests for behavior changes, and avoid committing credentials, generated build
output, database dumps, or user drawings.

## Development setup

Use Node.js 22.12 or newer and pnpm 10.11.1:

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm lint
```

Database-backed tests use Testcontainers when Docker is available. They can
also use an empty local PostgreSQL database:

```bash
DATABASE_TEST_URL=postgresql://localhost/open_excalidraw_test \
  pnpm test:integration
```

The integration suite owns the configured test database while it runs. Never
point `DATABASE_TEST_URL` at development or production data.

Before opening a pull request, run `pnpm format:check`, `pnpm lint`,
`pnpm typecheck`, `pnpm test`, `pnpm test:integration`, `pnpm test:e2e`, and
`pnpm build`. Explain schema, protocol, deployment, and security implications
in the pull request when they apply.

## Compatibility and security

Database migrations are forward-only and immutable after release. Realtime
protocol changes must remain server-authoritative and must include raw-socket
authorization tests. Do not weaken owner/editor/viewer checks in favor of UI-
only restrictions.

Report vulnerabilities through the process in [SECURITY.md](SECURITY.md), not
in a public issue.
