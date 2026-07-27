---
name: run-app
description: >-
  Launch the open-excalidraw stack (Postgres + API server + Vite web app) in a
  Linux container and drive it in a real browser with Playwright. Use this
  whenever asked to run, start, demo, screenshot, or manually verify the app —
  including "test this in the browser", "does it actually work", or checking a
  feature end to end — and also when running the Postgres-backed integration
  test suites. Prefer this over rediscovering the setup: it records the exact
  cluster commands, env vars, health probes, and Excalidraw/Playwright gotchas
  that cost real debugging time.
---

# Run open-excalidraw locally

Monorepo layout: `apps/server` (Fastify-style API + Socket.IO on :3000),
`apps/web` (Vite dev server on :5173, proxies `/api` to :3000),
`packages/database` (raw SQL migrations, applied by a CLI, discovered by
filename — no registry to update).

## 1. Postgres

The container images ship a dormant Postgres 16 cluster. Check and start it:

```bash
pg_lsclusters                      # expect: 16 main 5432 down
pg_ctlcluster 16 main start
su postgres -c "psql -c \"CREATE ROLE open_excalidraw LOGIN PASSWORD 'localdev'\""
su postgres -c "createdb -O open_excalidraw open_excalidraw"
```

`initdb` refuses to run as root, so reuse this cluster rather than creating
one. Role/db creation is not idempotent — "already exists" errors on a rerun
are fine. No SUPERUSER is needed: migration 0001 installs the `citext` and
`pgcrypto` extensions, but both are trusted on Postgres 13+, so the database
owner may install them (verified against this cluster).

## 2. Environment

The server loads dotenv from `$PWD/.env` or the repo root `.env` (gitignored —
never commit it). `DATABASE_URL` and `BETTER_AUTH_SECRET` (≥32 chars) are
always required, and `ADMIN_RESET_TOKEN` is also required whenever `SMTP_HOST`
is unset — which it is in this runbook. Write the repo-root `.env`:

```dotenv
APP_BASE_URL=http://localhost:3000
APP_PORT=3000
BETTER_AUTH_SECRET=local-dev-secret-0123456789abcdefghijklmnopqrstuv
ADMIN_RESET_TOKEN=local-dev-reset-0123456789abcdefghijklmnopqrstuv
DATABASE_URL=postgresql://open_excalidraw:localdev@localhost:5432/open_excalidraw
STORAGE_DRIVER=local
STORAGE_LOCAL_PATH=/tmp/open-excalidraw-assets
```

## 3. Migrate, then launch

Run from the repo root:

```bash
DATABASE_URL=postgresql://open_excalidraw:localdev@localhost:5432/open_excalidraw pnpm --filter @open-excalidraw/database db:migrate
pnpm dev   # run in background; logs both web and server
```

Ready when the log shows `"event":"server.listening","port":3000` and
`http://localhost:5173` returns 200. `curl localhost:3000/api/auth/get-session`
returning 200 proves the API + DB path. There is no `/healthz`.

## 4. Integration tests (optional but valuable)

The `test:integration` suites need a live database via `DATABASE_TEST_URL`:

```bash
su postgres -c "createdb -O open_excalidraw open_excalidraw_test"
export DATABASE_TEST_URL=postgresql://open_excalidraw:localdev@localhost:5432/open_excalidraw_test
pnpm --filter @open-excalidraw/database test:integration
pnpm --filter @open-excalidraw/server test:integration
```

Do not run the root-level `pnpm test:integration`: `packages/storage` and
`apps/server/test/migrate-assets.integration.test.ts` start a MinIO container
via testcontainers, which fails in this environment (no usable container
runtime) and aborts the recursive run. That failure is environmental, not a
regression — run the database and server suites individually instead.

## 5. Drive it in the browser

Chromium lives at `/opt/pw-browsers/chromium`; launch with
`chromium.launch({ executablePath: "/opt/pw-browsers/chromium" })`. If the
driver script lives outside the repo, plain `import "@playwright/test"` won't
resolve — import it as
`file:///<repo>/node_modules/@playwright/test/index.mjs`.

App-specific driving knowledge (all verified):

- **Auth**: `/signup` has `input[name=name|email|password]` + a
  "Create account" button; `/login` has email/password + "Sign in". Accounts
  persist across script runs — try login first, sign up only on a fresh DB.
  No email verification blocks local sign-in.
- **Create a drawing**: on `/app`, the "Create drawing" button silently
  requires the "New drawing title" field to be filled first, then navigates to
  `/drawings/:id`.
- **Canvas focus**: click the canvas once before sending any tool hotkey —
  keys pressed before first click are dropped. `r` = rectangle (then drag),
  `v` = selection tool.
- **Selecting shapes**: unfilled shapes hit-test on their stroke only;
  clicking the hollow middle selects nothing. `Control+a` (select all) is the
  reliable way to get a selection.
- **Chat**: toggle button is named `Chat…`; composer textarea has
  `aria-label="Message"`; typing `@` opens the mention picker; the
  "Attach selection (N)" toggle appears only while the canvas selection is
  non-empty, and the selection is polled every 500 ms — wait ~900 ms after
  selecting before expecting it. Sent anchors render as `.chat-anchor` chips.
- Screenshot after every step and actually look at the images — a missing
  button usually means a precondition above was skipped, not a bug.
