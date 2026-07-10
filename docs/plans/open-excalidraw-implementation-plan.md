# Open Excalidraw Implementation Plan

Date: 2026-07-10
Status: Ready for execution after user review
Design: [Open Excalidraw platform design](../design/open-excalidraw-platform-design.md)

## 1. Delivery objective

Build a new open-source product monorepo that embeds the published
`@excalidraw/excalidraw` package and adds:

- Local-only guest drawing.
- Email/password authentication with optional Google and GitHub OAuth.
- A dashboard of separately named drawings.
- PostgreSQL-backed scene persistence and bounded revision history.
- Local-filesystem assets with an S3-compatible adapter.
- Owner/editor/viewer permissions and email invitations.
- Authenticated real-time collaboration.
- Optional SMTP with manual invitation-link fallback.
- A one-VPS Docker Compose deployment.

This plan uses the built-in task plan and ordinary worker agents.

## 2. Fixed implementation decisions

All agents must follow these decisions:

- The repository is `open-excalidraw`; upstream Excalidraw is a pinned package
  dependency, not a fork.
- The monorepo uses pnpm, TypeScript, React/Vite, Express, Socket.IO, Better
  Auth, PostgreSQL, Drizzle, Zod, Vitest, and Playwright.
- Runtime Excalidraw imports come from supported package exports.
- The collaboration client uses Excalidraw `onChange`, element versions,
  `restoreElements`, `reconcileElements`, and `CaptureUpdateAction.NEVER`.
- The initial release does not use the newer delta/increment API as its wire
  protocol.
- The owner is stored on the drawing. Ordinary membership rows contain only
  `editor` or `viewer`.
- Owners and editors can rename drawings. Only owners manage sharing,
  ownership, and deletion.
- HTTP stale-save conflicts use `412 VERSION_CONFLICT`.
- Smooth collaboration uses volatile previews; durable mutations use a
  one-second debounce and a five-second maximum wait.
- WebSocket persistence commits before broadcast.
- Binary assets remain separate from scene JSON.
- Root manifests, lockfiles, shared contracts, global application composition,
  and applied migration files have one owner: the orchestrator.

## 3. Agent topology and file ownership

At most four agents are active: the orchestrator and three workers.

| Role                     | Primary ownership                                                                                              |
| ------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Orchestrator             | Root configuration, manifests, lockfile, contracts, router/server composition, integration, final verification |
| Backend worker           | `packages/database`, `apps/server/src/modules/auth`, `drawings`, `content`, `sharing`                          |
| Frontend worker          | `apps/web/src/features`, feature-local tests and pages                                                         |
| Platform/realtime worker | `packages/storage`, `packages/mail`, collaboration server modules, Compose and operations                      |

Rules:

1. Agents do not edit the same file concurrently.
2. Agents do not add dependencies. The orchestrator owns package manifests and
   the lockfile.
3. Agents do not edit shared barrel exports. They return the required exports
   to the orchestrator for integration.
4. An agent owns tests beside its implementation.
5. Every handoff includes changed files, commands run, passing/failing counts,
   assumptions, and remaining risks.
6. The orchestrator reviews every diff and independently reruns verification.

## 4. Planned repository layout

```text
open-excalidraw/
├── apps/
│   ├── web/
│   │   ├── src/app/
│   │   ├── src/features/
│   │   ├── src/shared/
│   │   └── e2e/
│   └── server/
│       ├── src/config/
│       ├── src/modules/
│       ├── src/platform/
│       ├── src/jobs/
│       └── test/
├── packages/
│   ├── contracts/
│   ├── database/
│   ├── storage/
│   └── mail/
├── infra/caddy/
├── ops/
├── docs/design/
├── docs/plans/
├── docs/operations/
├── compose.yaml
├── compose.managed.yaml
├── pnpm-workspace.yaml
└── package.json
```

## 5. Wave 0 — serial foundation

The orchestrator completes this wave before parallel coding.

### F0.1 Workspace scaffold and dependency freeze

Create:

- `package.json`
- `pnpm-workspace.yaml`
- `pnpm-lock.yaml`
- `tsconfig.base.json`
- `eslint.config.js`
- `prettier.config.js`
- `vitest.workspace.ts`
- `.editorconfig`
- `.gitignore`
- `.env.example`
- `apps/web/package.json`
- `apps/web/tsconfig.json`
- `apps/server/package.json`
- `apps/server/tsconfig.json`
- Package manifests and TypeScript configs under every `packages/*` directory.

Define root commands:

```text
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm build
pnpm dev
```

Predeclare all dependencies needed by the approved plan so workers never edit
manifests during parallel waves.

Verification:

- `pnpm install`
- `pnpm typecheck`
- Empty package builds complete.
- A second frozen install does not alter `pnpm-lock.yaml`.

### F0.2 Shared HTTP and WebSocket contract freeze

Create under `packages/contracts/src/`:

- `common/problem.ts`
- `auth.ts`
- `drawings.ts`
- `content.ts`
- `assets.ts`
- `sharing.ts`
- `realtime.ts`
- `limits.ts`
- `index.ts`

Contracts include:

- `owner | editor | viewer` roles.
- Drawing summary, metadata, scene envelope, asset manifest, member, and
  invitation schemas.
- Decimal-string WebSocket revisions so `BIGINT` never becomes an unsafe
  JavaScript number.
- HTTP ETag/content revision schemas.
- `application/problem+json` error schemas.
- `room.join`, `room.ready`, `scene.preview`, `scene.mutate`,
  `scene.committed`, presence, role-change, resync, acknowledgement, and
  protocol-error events.
- Shared app-state allowlist and payload limits.

Tests:

- Canonical request/response round trips.
- Invalid UUIDs, roles, revisions, and event discriminators.
- Embedded scene files rejected.
- Unknown Excalidraw element fields preserved.
- Oversized titles, scenes, patches, and asset manifests rejected.

### F0.3 Test and CI harness

Create:

- `.github/workflows/ci.yml`
- Web Vitest/Testing Library configuration.
- Server Vitest/Testcontainers configuration.
- Shared test environment helpers.
- Playwright configuration and browser fixtures.

CI stages:

1. Install from frozen lockfile.
2. Lint and formatting check.
3. Typecheck.
4. Unit tests.
5. PostgreSQL integration tests.
6. Production build.
7. Playwright tests when the stack is available.

### Gate F0

- Contracts are reviewed and frozen.
- Workspace typecheck passes.
- Empty test harnesses run successfully.
- Root configuration and lockfile are committed before worker waves start.

## 6. Wave 1 — parallel foundations

Three workers execute these tasks concurrently.

### B1. Database schema and migrations — backend worker

Owned paths:

- `packages/database/drizzle.config.ts`
- `packages/database/src/client.ts`
- `packages/database/src/schema/auth.ts`
- `packages/database/src/schema/drawings.ts`
- `packages/database/src/schema/sharing.ts`
- `packages/database/src/schema/assets.ts`
- `packages/database/src/schema/audit.ts`
- `packages/database/src/migrate.ts`
- `packages/database/migrations/0001_initial.sql`
- `packages/database/test/*`

Implement the approved tables, foreign keys, role checks, pending-invitation
uniqueness, content/metadata revisions, mutation idempotency, soft deletion,
asset ownership, audit events, and Better Auth schema integration.

Tests:

- Migrate an empty PostgreSQL database.
- Reject invalid roles and duplicate active invitations.
- Enforce all foreign keys and unique constraints.
- Validate mutation idempotency uniqueness per drawing.
- Verify soft-delete query behavior.
- Record a migration snapshot/checksum.

Migration rule: after Wave 1, `0001_initial.sql` is immutable. Corrections use a
new migration.

### W1. Web foundation, editor host, and guest database — frontend worker

Owned paths:

- `apps/web/src/main.tsx`
- `apps/web/src/app/providers.tsx`
- `apps/web/src/app/router.tsx`
- `apps/web/src/shared/api/*`
- `apps/web/src/shared/test/*`
- `apps/web/src/features/editor/*`
- `apps/web/src/features/guest/storage/*`
- `apps/web/src/features/guest/model/*`

Implement:

- React Router and TanStack Query providers.
- Excalidraw stylesheet import and full-height container.
- `ExcalidrawHost` with async initial data, API capture, read-only mode,
  controlled title, and `onChange` forwarding.
- Guest IndexedDB with separate scene, asset, and migration-marker stores.

Tests:

- The real package mounts in a non-zero-height container.
- Promise-based initial scene loads.
- API lifecycle invalidates handles after unmount.
- Guest scene/assets survive repository recreation.
- Guest local revisions are monotonic.
- Guest operations perform no cloud API or WebSocket requests.

### P1. Storage, mail, and Compose skeleton — platform worker

Owned paths:

- `packages/storage/src/types.ts`
- `packages/storage/src/local.ts`
- `packages/storage/src/errors.ts`
- `packages/storage/test/*`
- `packages/mail/src/types.ts`
- `packages/mail/src/disabled.ts`
- `packages/mail/src/smtp.ts`
- `packages/mail/src/templates/*`
- `packages/mail/test/*`
- `compose.yaml`
- `infra/caddy/Caddyfile`
- `docs/operations/deployment-draft.md`

Storage tests:

- Streaming put/get/stat/delete.
- Atomic temporary write and no-replace publication.
- Idempotent identical writes.
- Path traversal impossible.
- Interrupted writes expose no partial object.

Mail tests:

- Disabled mailer performs no network activity.
- SMTP uses TLS configuration and a bounded timeout.
- Failure returns a typed status without logging secrets.
- Templates escape user content.

Compose checks:

- `docker compose config` succeeds.
- PostgreSQL and the asset volume are private.
- Only the intended application/proxy ports are public.

### Gate W1

- `pnpm lint`, `pnpm typecheck`, and all Wave 1 tests pass.
- Fresh migration succeeds.
- Contracts and lockfile remain unchanged.
- The orchestrator integrates package exports without modifying worker-owned
  implementation files.

## 7. Wave 2 — authentication, drawings, dashboard, and assets

### B2. Authentication and drawing domain — backend worker

Owned paths:

- `apps/server/src/modules/auth/*`
- `apps/server/src/modules/drawings/*`
- `apps/server/test/auth.integration.test.ts`
- `apps/server/test/drawings.integration.test.ts`

Authentication deliverables:

- Better Auth Express handler.
- Email/password registration, session, logout, verification, and reset hooks.
- Optional Google/GitHub provider configuration.
- Disabled-SMTP behavior and administrative reset-link command boundary.
- Server session/identity service usable by HTTP and Socket.IO.

Drawing deliverables:

- Create, list, fetch, rename, leave, soft delete, and ownership transfer.
- Central capability policy.
- Dashboard query for owned and shared drawings.
- Metadata revision conflict handling.

Tests:

- Generic forgot-password response.
- OAuth routes unavailable when not configured.
- Secure cookie and session expiration behavior.
- Dashboard never leaks inaccessible or deleted drawings.
- Owner/editor/viewer capability matrix.
- Owner and editor rename; only owner delete/transfer/share.
- Ownership transfer leaves the previous owner as editor.

### W2. Auth UI, dashboard, and guest canvas — frontend worker

Owned paths:

- `apps/web/src/features/auth/*`
- `apps/web/src/features/dashboard/*`
- `apps/web/src/features/access/*`
- `apps/web/src/features/guest/pages/*`
- `apps/web/src/features/guest/hooks/*`

Implement:

- Cookie-backed auth client and provider.
- Login and sign-up pages with safe return paths.
- Google/GitHub buttons only when enabled by server capability response.
- Guest canvas page with IndexedDB persistence.
- Dashboard owned/shared sections, create/open, rename, delete, role badges,
  updated time, and loading/empty/error states.
- Exhaustive role capability mapping and viewer banner.

Tests:

- Login/sign-up validation and safe invitation redirect.
- No token stored in browser storage.
- Logout purges protected query/editor state.
- Owned/shared list rendering and role badges.
- Owner/editor rename controls; only owner delete controls.
- Guest reload restores scene/assets and remains zero-network.

### P2. Asset backend and deployment build — platform worker

Owned paths:

- `apps/server/src/modules/assets/*`
- `apps/server/test/assets.integration.test.ts`
- `apps/server/Dockerfile`
- `apps/web/Dockerfile`
- `compose.managed.yaml`
- `ops/migrate.sh`

Implement:

- Editor/owner upload and authorized member download.
- File ID, MIME, byte limit, and checksum validation.
- Document-to-asset ownership checks.
- Safe response headers.
- Local storage injection with an S3-compatible interface.
- Multi-stage non-root images.

Tests:

- Viewer upload rejected; viewer download allowed.
- Cross-drawing asset access rejected.
- MIME spoofing and oversize upload rejected.
- Failed blob write leaves no committed asset metadata.
- Identical file ID/hash is idempotent; mismatched hash conflicts.
- Container images build and run as non-root.

### Gate W2

- Orchestrator registers auth, drawings, and assets in the global Express app.
- Register → create drawing → upload asset → load asset integration flow passes.
- SMTP-disabled and OAuth-disabled configurations boot successfully.
- No root manifest or contract drift.

## 8. Wave 3 — content persistence, sharing, and editor integration

### B3. Content, revisions, and sharing API — backend worker

Owned paths:

- `apps/server/src/modules/content/*`
- `apps/server/src/modules/sharing/*`
- `apps/server/test/content.integration.test.ts`
- `apps/server/test/revisions.integration.test.ts`
- `apps/server/test/sharing.integration.test.ts`

Content deliverables:

- Full canonical scene load.
- `If-Match`/ETag conditional save.
- Idempotency-key replay protection.
- Scene envelope, size, element-count, and asset-reference validation.
- Checkpoint creation, retention input, and restore-as-new-revision.

Sharing deliverables:

- Immediate membership for existing users.
- Hashed seven-day pending invitations for new users.
- SMTP delivery or one-time manual URL.
- Role change, revoke, cancel, reissue, leave, and ownership transfer.

Tests:

- Successful save advances exactly one revision.
- Stale full save returns `412 VERSION_CONFLICT` without overwriting.
- Reused idempotency key returns the original result; mismatched payload is
  rejected.
- Missing asset references reject the scene transaction.
- Revision restore creates a new monotonic current revision.
- Invitation database contains only token hashes.
- Manual URL appears exactly once when SMTP is disabled or fails.
- Expiry, replay, email mismatch, and concurrent acceptance behavior.

### W3. Scene persistence, assets, and guest migration — frontend worker

Owned paths:

- `apps/web/src/features/persistence/*`
- `apps/web/src/features/assets/*`
- `apps/web/src/features/connectivity/*`
- `apps/web/src/features/guest/services/*`
- `apps/web/src/features/guest/components/GuestMigrationPrompt.tsx`

Implement:

- Database-clean scene projection with tombstones retained.
- One-second debounce, five-second max wait, one in-flight save.
- ETag revision tracking and `412` recovery UI.
- Cloud recovery IndexedDB scoped by user and drawing.
- Asset reference collection, upload-before-save, incremental hydration through
  `api.addFiles()`.
- Idempotent guest-to-account migration.

Tests:

- Transient app state does not dirty the document.
- Rapid changes coalesce and in-flight changes remain dirty.
- Asset uploads are deduplicated and precede scene commit.
- Partial hydration displays available images and exposes failures.
- Failed guest migration retains guest data.
- Successful migration marks the snapshot only after acknowledgement.
- Recovery data never crosses accounts.

### P3. Collaboration core and security primitives — platform/realtime worker

Owned paths:

- `apps/server/src/modules/collaboration/core/*`
- `apps/server/src/modules/collaboration/security/*`
- `apps/server/test/collaboration-core.test.ts`
- `apps/server/test/socket-security.integration.test.ts`

Implement:

- Pure Node-safe element reconciliation.
- Higher element version wins; equal version uses lower nonce.
- Tombstone and fractional-order preservation.
- Socket session authentication and strict Origin policy.
- Server-derived role binding and event authorization matrix.
- Rate-limit primitives for previews and presence.

Tests:

- Deterministic merge for concurrent inserts, updates, and deletion.
- Tombstone resurrection rejected.
- Forged socket identity/role rejected.
- Nonmember, expired session, wrong origin, and raw viewer mutation rejected.
- Merge code has no browser globals.

### Gate W3

- All HTTP domain modules pass against PostgreSQL.
- The frontend can create, save, reload, and hydrate an image without
  collaboration.
- Sharing works through manual invitation links with SMTP disabled.
- Socket security gates pass before gateway implementation begins.

## 9. Wave 4 — authenticated real-time collaboration

### B4. Durable mutation, preview, presence, and room services — backend worker

Owned paths:

- `apps/server/src/modules/collaboration/persistence/*`
- `apps/server/src/modules/collaboration/mutation-service.ts`
- `apps/server/src/modules/collaboration/preview-service.ts`
- `apps/server/src/modules/collaboration/presence-service.ts`
- `apps/server/src/modules/collaboration/room-registry.ts`
- Feature-local tests.

Implement:

- Transactional row lock and membership recheck.
- Mutation deduplication and asset ownership validation.
- Canonical merge, persistence, and monotonic revision.
- Preview relay without persistence or revision changes.
- Presence roster, heartbeat expiry, join/leave/idle/cursor events.
- Role-change and revocation notifications.

Tests:

- Two editors from one base changing different and identical elements.
- Duplicate mutation after lost acknowledgement.
- Future base revision rejected; stale base reconciled.
- Database failure produces no revision and no publishable commit.
- Viewer preview/mutation rejected while viewer presence works.
- Revocation removes authorization immediately.

### W4. Collaboration client and offline outbox — frontend worker

Owned paths:

- `apps/web/src/features/collaboration/*`
- `apps/web/src/features/connectivity/storage/cloudOutboxDb.ts`
- Feature-local tests.

Implement:

- Socket transport and connection state machine.
- Join/ready, role/revision tracking, structured errors, and gap resync.
- `onChange` version filter.
- 100 ms preview throttle.
- One-second durable mutation debounce and 20-second full resync.
- Remote restore/reconcile/apply with `CaptureUpdateAction.NEVER`.
- Echo suppression by remote source/version tracking.
- User/drawing-scoped IndexedDB outbox and reconnect resubmission.
- Presence conversion to Excalidraw collaborator maps.

Tests:

- Remote apply never echoes.
- Preview does not clear dirty durable state.
- Ack removes exactly the acknowledged generation.
- Outbox survives tab restart and never crosses accounts.
- Revision gaps trigger snapshot resync.
- Viewer transport never emits scene writes.
- Reconnect rebases pending elements before resubmission.

### P4. Socket gateway and collaboration operations — platform/realtime worker

Owned paths:

- `apps/server/src/modules/collaboration/socket-gateway.ts`
- `apps/server/test/socket-gateway.integration.test.ts`
- `docs/operations/collaboration.md`

The orchestrator performs final attachment to the global HTTP server after this
module is reviewed.

Implement:

- Join/ready lifecycle.
- Snapshot initialization from PostgreSQL.
- Preview, durable mutation, acknowledgement, presence, resync, and structured
  error wiring.
- Publish committed changes only after the durable service resolves.
- Role-change downgrade and revocation handling.
- Backpressure and queue limits.

Tests:

- Nonmember join rejected.
- Viewer receives live commits but raw mutation is rejected.
- Demotion during a session changes permissions immediately.
- Revision gap returns resync instruction/snapshot.
- Slow or flooding client is bounded and disconnected safely.

### Gate W4

- Orchestrator attaches the reviewed gateway to Express/Socket.IO.
- Two browser clients converge on different-element and same-element edits.
- Database failure is proven not to broadcast.
- Viewer authorization is proven with raw socket requests, not only UI tests.

## 10. Wave 5 — product composition and operations

### B5. Maintenance jobs and audit completion — backend worker

Owned paths:

- `apps/server/src/jobs/*`
- `apps/server/test/jobs.integration.test.ts`

Implement revision pruning, orphan-asset cleanup, expired invitation/token
cleanup, seven-day deleted-drawing purge, and security audit events.

Tests:

- Keep the newest 20 revisions.
- Respect five-minute checkpoint and seven-day cleanup boundaries.
- Never delete a referenced asset.
- Jobs are idempotent and safe when retried.

### W5. Drawing workspace, sharing, and revision UI — frontend worker

Owned paths:

- `apps/web/src/features/workspace/*`
- `apps/web/src/features/sharing/*`
- `apps/web/src/features/revisions/*`

Implement:

- `DrawingPage` and `DrawingHeader`.
- `<ExcalidrawHost key={drawingId}>` isolation.
- Save/offline/conflict status and presence avatars.
- Viewer mode, editor title controls, and owner sharing controls.
- Share dialog, members, pending invitations, manual-link copy flow.
- Invitation acceptance page.
- Recent revision list and restore confirmation.
- Demotion/revocation recovery actions.

Tests:

- Switching IDs clears files, history, collaborators, and stale state.
- Viewer receives changes with no autosave or mutation emission.
- Editor edits and renames but cannot manage ACL.
- Owner invitation/member controls work.
- Expired/revoked/accepted invitation states.
- Restore remounts the editor on the new canonical revision.

### P5. Deployment, backup, and optional S3 — platform worker

Owned paths:

- `packages/storage/src/s3.ts`
- `packages/storage/test/s3.integration.test.ts`
- `ops/backup.sh`
- `ops/restore.sh`
- `infra/caddy/Caddyfile`
- `docs/operations/deployment.md`
- `docs/operations/backup-restore.md`
- `docs/operations/storage.md`

Implement:

- S3 adapter contract parity tested with MinIO.
- HTTPS proxy configuration.
- Fresh-install, managed-PostgreSQL, local-storage, and S3 documentation.
- Encrypted backup and destructive restore procedure.
- Health/readiness checks and graceful shutdown configuration.

Checks:

- Local/S3 storage contract parity.
- Private objects and encryption headers.
- `docker compose config` for default and managed overrides.
- Backup/restore reproduces scenes, memberships, revisions, and asset bytes.

### F5. Serial application composition — orchestrator

After B5/W5/P5 finish, the orchestrator owns:

- `apps/server/src/app.ts`
- `apps/server/src/server.ts`
- `apps/server/src/config/env.ts`
- `apps/server/src/platform/*`
- `apps/web/src/app/router.tsx`
- `apps/web/src/app/providers.tsx`
- `apps/web/src/main.tsx`
- Shared package exports.

Integrate:

- All Express routes, middleware, Better Auth, and Socket.IO.
- Request IDs, problem details, security headers, CSRF/Origin checks, logging,
  rate limits, health endpoints, and graceful shutdown.
- Routes `/`, `/login`, `/signup`, `/invite/:token`, `/app`,
  `/drawings/:drawingId`, and `/settings`.
- Auth guards, signed-in root redirect, and logout isolation.

Integration tests:

- Register → create → upload → save → load.
- Invite editor/viewer → accept → enforce role matrix.
- Guest sign-in migration.
- HTTP and WebSocket errors use stable contracts.
- No secrets, reset links, or invitation tokens appear in logs.

## 11. Wave 6 — parallel end-to-end verification and reviews

### V6.1 Browser behavior stream

Owned specs:

- `apps/web/e2e/guest-auth.spec.ts`
- `apps/web/e2e/dashboard-sharing.spec.ts`

Cover guest reload, account migration, multiple drawings, rename/delete,
invitation acceptance, manual SMTP fallback, and logout isolation.

### V6.2 Collaboration/security stream

Owned specs:

- `apps/web/e2e/collaboration-permissions.spec.ts`
- `apps/web/e2e/collaboration-reconnect.spec.ts`
- `apps/web/e2e/collaboration-assets.spec.ts`

Cover two editors, viewer enforcement, same-element conflict, preview/durable
commit, lost acknowledgement, reconnect, role revocation, and shared images.

### V6.3 Offline/deployment stream

Owned specs and checks:

- `apps/web/e2e/offline-revision.spec.ts`
- Docker cold-start smoke test.
- SMTP-enabled and SMTP-disabled configurations.
- Empty-to-latest migration and previous-release migration.
- Backup/restore drill.

### Independent review assignments

After implementation workers stop editing:

1. Backend reviewer audits authentication, authorization, invitations, tokens,
   IDOR risks, and database transaction boundaries.
2. Collaboration reviewer audits convergence, idempotency, tombstones,
   viewer enforcement, backpressure, and reconnect behavior.
3. Frontend reviewer audits document isolation, guest/protected data separation,
   feedback loops, asset lifecycle, and accessible error states.

Review findings are prioritized, fixed by the owning implementation worker, and
independently reverified.

## 12. Final verification gate

Run from a clean checkout:

```text
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm build
docker compose config
docker compose up -d --build
pnpm test:e2e
```

Then verify:

- A fresh database migrates successfully.
- An upgrade fixture migrates successfully.
- Default local storage and S3-compatible storage pass contract tests.
- SMTP-disabled invitation links and SMTP-enabled emails work.
- Two editors converge and a viewer cannot mutate through raw APIs.
- Offline changes recover after browser and server restarts.
- Backup and restore preserve scenes and assets.
- Git status is clean and no generated secrets are committed.

## 13. Release sequence

1. Tag an internal preview after Gate W3.
2. Tag an alpha after authenticated collaboration and viewer enforcement pass.
3. Run security review, backup/restore, and deployment documentation checks.
4. Select the public license and complete naming/trademark review.
5. Tag the first public release only after the final verification gate.

## 14. Fastest safe critical path

The critical path is:

```text
F0 workspace/contracts
  -> B1 database
  -> B2 auth/drawings
  -> B3 content/sharing
  -> P3 collaboration core
  -> B4/P4 collaboration server
  -> W4 collaboration client
  -> F5 integration
  -> V6 verification
```

Time is saved by running web, storage/mail/deployment, and feature-local testing
beside this path. Security and persistence gates are not skipped because a fast
release that can leak drawings or lose edits is not acceptable.
