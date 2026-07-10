# Open Excalidraw Platform Design

Date: 2026-07-10
Status: Approved for implementation planning
Repository: `open-excalidraw`

## 1. Purpose

Open Excalidraw is a self-hostable product built around the published
`@excalidraw/excalidraw` React package. It adds user accounts, a dashboard of
named drawings, backend persistence, account-based sharing, and authenticated
real-time collaboration without modifying or copying the upstream Excalidraw
monorepo.

The reference installation targets a single VPS and starts with Docker Compose.
Operators can later replace the bundled PostgreSQL and local asset storage with
managed PostgreSQL and S3-compatible storage.

## 2. Goals

The first release must provide:

1. A local-only guest canvas that works without authentication.
2. Email/password authentication with optional Google and GitHub OAuth.
3. A dashboard containing separate named drawings owned by the signed-in user
   or shared with them.
4. Backend save/load for Excalidraw scenes and binary assets.
5. Owner, editor, and viewer permissions enforced by the server.
6. Email-based sharing with pending invitations for users who do not yet have
   accounts.
7. Real-time collaboration for owners and editors, with live read-only updates
   for viewers.
8. Debounced, conflict-safe saving with a bounded recent revision history.
9. Optional SMTP. When SMTP is disabled, owners can copy invitation links
   manually.
10. A documented `docker compose up` deployment path.

## 3. Non-goals for the first release

The first release will not include:

- Folders, teams, organizations, comments, or public anonymous share links.
- Drawing thumbnails or full-text drawing search.
- End-to-end encryption of backend-saved documents. TLS, encrypted storage,
  and encrypted backups are the privacy boundary.
- Character-level CRDT text editing. Concurrent changes are reconciled at the
  Excalidraw element level.
- Horizontally scaled WebSocket workers. The protocol will allow later
  scaling, but the reference deployment is a single application process.
- A fork of Excalidraw or runtime imports from `excalidraw-app` internals.
- Native mobile applications.

## 4. Repository and technology architecture

The project is a new monorepo:

```text
open-excalidraw/
├── apps/
│   ├── web/                 # React/Vite product application
│   └── server/              # HTTP API, auth, WebSockets, maintenance jobs
├── packages/
│   ├── contracts/           # Shared Zod HTTP/WebSocket contracts
│   ├── database/            # Drizzle schema, migrations, repositories
│   ├── storage/             # BlobStore port and local/S3 implementations
│   └── mail/                # Mailer port and disabled/SMTP implementations
├── docs/
├── docker-compose.yml
├── .env.example
├── pnpm-workspace.yaml
└── package.json
```

Technology decisions:

- TypeScript throughout.
- pnpm workspaces.
- React and Vite for the web application.
- React Router for routes and TanStack Query for server metadata.
- `@excalidraw/excalidraw` pinned to an exact version.
- Node.js with Express for the HTTP application and static web delivery.
- Socket.IO attached to the same HTTP server for collaboration.
- Better Auth for sessions, password authentication, and OAuth.
- PostgreSQL with Drizzle migrations.
- Zod schemas shared between the browser and server.
- Vitest for unit/integration tests and Playwright for browser tests.

The frontend imports Excalidraw only through supported package exports and its
published stylesheet. It must not depend on upstream `excalidraw-app` modules,
internal DOM class names, or copied collaboration code. Excalidraw upgrades are
explicit and gated by package-contract tests and saved-scene fixtures.

## 5. Runtime topology

The default Docker Compose installation contains:

```text
Internet or localhost
        |
        v
application container
  - static web application
  - REST API
  - Better Auth handlers
  - Socket.IO collaboration
  - single-instance cleanup scheduler
        |
        +---- PostgreSQL container and persistent volume
        |
        +---- private asset volume
        |
        +---- optional SMTP service
```

The application container is the only required public service. PostgreSQL is
available only on the private Compose network. Production operators place Caddy,
Traefik, Nginx, or their platform load balancer in front of the application.
An optional Caddy Compose profile provides automatic HTTPS for a standalone VPS.

Deployment adapters:

- `DATABASE_URL` selects bundled or managed PostgreSQL.
- `STORAGE_DRIVER=local` uses the persistent asset volume.
- `STORAGE_DRIVER=s3` uses a private S3-compatible bucket.
- SMTP variables enable mail. Missing SMTP variables select the disabled mailer.

Database migrations run under a PostgreSQL advisory lock before the application
becomes ready. The server exposes `/health/live` and `/health/ready`.

## 6. Authentication

Better Auth owns the user, session, password-account, OAuth-account,
verification, and reset-token tables.

Supported methods:

- Email and password.
- Google OAuth when credentials are configured.
- GitHub OAuth when credentials are configured.

Authentication uses same-origin `HttpOnly`, `Secure`, `SameSite=Lax` cookies.
The server validates request origins and CSRF protections. OAuth uses state,
nonce, and PKCE where supported. Provider accounts are not linked solely because
they report the same unverified email address.

When SMTP is enabled, email verification and password-reset mail are available.
When SMTP is disabled, sign-up remains available, password-reset requests return
the same generic response but cannot deliver mail, and operators can use a
documented administrative command to generate a one-time reset link.

Guest mode does not create a temporary server user and does not call account,
drawing, asset, or WebSocket endpoints.

## 7. Authorization model

Each drawing has exactly one owner. Additional memberships have one of two
roles:

- `editor`: read the drawing and assets, rename it, publish scene changes, and
  upload assets.
- `viewer`: read the drawing and assets and receive live updates.

Only the owner can:

- Delete the drawing.
- Invite users.
- Change or revoke memberships.
- Cancel invitations.
- Transfer ownership.

Ownership transfer is atomic. The new owner is removed from ordinary membership
records and the previous owner becomes an editor. An owner cannot leave or be
removed without first transferring ownership.

The frontend uses Excalidraw view mode and hides editing controls for viewers,
but these are usability measures only. Every HTTP endpoint and WebSocket event
performs authoritative server-side authorization.

## 8. Data model

Better Auth tables are managed by Better Auth migrations. Product tables are:

### `drawings`

- `id UUID PRIMARY KEY`
- `owner_user_id UUID NOT NULL`
- `title VARCHAR(120) NOT NULL`
- `scene JSONB NOT NULL`
- `scene_format_version INTEGER NOT NULL`
- `content_revision BIGINT NOT NULL DEFAULT 0`
- `metadata_revision BIGINT NOT NULL DEFAULT 0`
- `scene_bytes INTEGER NOT NULL`
- `created_at TIMESTAMPTZ NOT NULL`
- `updated_at TIMESTAMPTZ NOT NULL`
- `deleted_at TIMESTAMPTZ NULL`
- `last_checkpoint_at TIMESTAMPTZ NULL`

### `drawing_members`

- `drawing_id UUID NOT NULL`
- `user_id UUID NOT NULL`
- `role editor | viewer`
- `created_by_user_id UUID NOT NULL`
- `created_at TIMESTAMPTZ NOT NULL`
- Primary key: `(drawing_id, user_id)`

### `drawing_invitations`

- `id UUID PRIMARY KEY`
- `drawing_id UUID NOT NULL`
- `invitee_email CITEXT NOT NULL`
- `role editor | viewer`
- `token_hash BYTEA UNIQUE NOT NULL`
- `invited_by_user_id UUID NOT NULL`
- `expires_at TIMESTAMPTZ NOT NULL`
- `accepted_at TIMESTAMPTZ NULL`
- `accepted_by_user_id UUID NULL`
- `revoked_at TIMESTAMPTZ NULL`
- `delivery_status sent | manual | failed`
- `created_at TIMESTAMPTZ NOT NULL`

Only one active invitation may exist for a drawing/email pair. Invitation tokens
are 256-bit random values, stored only as hashes, single-use, and valid for seven
days.

### `drawing_assets`

- `id UUID PRIMARY KEY`
- `drawing_id UUID NOT NULL`
- `file_id TEXT NOT NULL`
- `storage_key TEXT UNIQUE NOT NULL`
- `mime_type TEXT NOT NULL`
- `byte_size INTEGER NOT NULL`
- `sha256 BYTEA NOT NULL`
- `file_version INTEGER NULL`
- `created_by_user_id UUID NOT NULL`
- `created_at TIMESTAMPTZ NOT NULL`
- `last_referenced_at TIMESTAMPTZ NULL`
- `deleted_at TIMESTAMPTZ NULL`
- Unique key: `(drawing_id, file_id)`

### `drawing_revisions`

- `id UUID PRIMARY KEY`
- `drawing_id UUID NOT NULL`
- `content_revision BIGINT NOT NULL`
- `scene JSONB NOT NULL`
- `scene_format_version INTEGER NOT NULL`
- `scene_bytes INTEGER NOT NULL`
- `author_user_id UUID NOT NULL`
- `reason checkpoint | restore`
- `created_at TIMESTAMPTZ NOT NULL`
- Unique key: `(drawing_id, content_revision)`

### `drawing_mutations`

- `drawing_id UUID NOT NULL`
- `mutation_id UUID NOT NULL`
- `payload_hash BYTEA NOT NULL`
- `base_revision BIGINT NOT NULL`
- `resulting_revision BIGINT NOT NULL`
- `created_at TIMESTAMPTZ NOT NULL`
- Primary key: `(drawing_id, mutation_id)`

### `audit_events`

- `id UUID PRIMARY KEY`
- `actor_user_id UUID NULL`
- `drawing_id UUID NULL`
- `event_type TEXT NOT NULL`
- `request_id TEXT NOT NULL`
- `metadata JSONB NOT NULL`
- `created_at TIMESTAMPTZ NOT NULL`

Drawing deletion sets `deleted_at` immediately, disconnects collaborators, and
removes it from all lists. A maintenance job permanently purges its database and
asset records after seven days. There is no trash-restoration UI in the first
release.

## 9. Scene and asset persistence

The current canonical scene is stored in `drawings.scene` as Excalidraw's
database-clean JSON envelope. Binary files are never embedded in this JSON and
are stored through the asset service.

The frontend derives the scene with Excalidraw's supported serialization and
restoration utilities. It preserves unknown element fields for forward
compatibility and retains deletion tombstones in the canonical collaborative
snapshot. Tombstone pruning is excluded from the first release because a stale
client could otherwise resurrect deleted elements.

Assets are uploaded before publishing elements that reference them. The server
verifies that every referenced file belongs to the drawing. Downloads require
viewer, editor, or owner access. Newly uploaded but unreferenced assets are kept
for seven days before cleanup so failed or reordered saves do not destroy data.

Initial safety limits are configurable and default to:

- 10 MiB per scene payload.
- 50,000 elements per scene.
- 4 MiB per binary asset.
- 100 asset uploads per minute per user.

Local storage uses atomic temporary-file writes followed by a no-replace
hard-link publication, preventing concurrent writers from overwriting an
existing object. S3 storage uses private objects and server-side encryption.

## 10. HTTP API

Better Auth is mounted below `/api/auth/*`. Product endpoints are versioned:

```text
GET    /api/v1/me

GET    /api/v1/drawings
POST   /api/v1/drawings
GET    /api/v1/drawings/:drawingId
PATCH  /api/v1/drawings/:drawingId
DELETE /api/v1/drawings/:drawingId

GET    /api/v1/drawings/:drawingId/content
PUT    /api/v1/drawings/:drawingId/content

GET    /api/v1/drawings/:drawingId/members
PATCH  /api/v1/drawings/:drawingId/members/:userId
DELETE /api/v1/drawings/:drawingId/members/:userId
DELETE /api/v1/drawings/:drawingId/members/me
POST   /api/v1/drawings/:drawingId/transfer-ownership

POST   /api/v1/drawings/:drawingId/invitations
DELETE /api/v1/drawings/:drawingId/invitations/:invitationId
GET    /api/v1/invitations/:token
POST   /api/v1/invitations/:token/accept

PUT    /api/v1/drawings/:drawingId/assets/:fileId
GET    /api/v1/drawings/:drawingId/assets/:fileId

GET    /api/v1/drawings/:drawingId/revisions
POST   /api/v1/drawings/:drawingId/revisions/:revision/restore
```

Full HTTP saves include an `If-Match` content revision and an idempotency key.
A stale revision returns `412 VERSION_CONFLICT`; it never overwrites current
content. Reusing an idempotency key with a different payload returns
`409 IDEMPOTENCY_MISMATCH`.

Errors use `application/problem+json` with stable machine-readable codes,
status, safe detail, field errors, and a request ID. Authentication and password
reset responses do not reveal whether an email address is registered.

## 11. Invitations

When an owner invites an existing user, the server creates or updates the
membership immediately and notifies active sessions. When the email has no
account, the server creates a pending invitation.

Invitation acceptance requires an authenticated account whose normalized email
matches the invitation. If SMTP is enabled, that email must be verified first.
If SMTP is disabled, possession of the manually shared single-use invitation
token is accepted as proof of access to the invitation.

For a pending invitation, the server creates an invitation URL. When SMTP
succeeds, it returns `deliveryStatus: sent` without returning the plaintext
token again. When SMTP is disabled or delivery fails, the creation response
returns a manual URL exactly once. Reissuing an invitation revokes the previous
token. Existing-user membership grants do not create invitation tokens.

## 12. Real-time collaboration

The collaboration service is server-authoritative and uses the authenticated
session cookie during the WebSocket upgrade. The server validates `Origin`,
loads drawing membership, and binds `{userId, drawingId, role}` to the socket.

### Join

```text
client -> room.join {
  protocolVersion,
  drawingId,
  clientInstanceId,
  lastRevision
}

server -> room.ready {
  connectionId,
  role,
  revision,
  snapshot,
  assetManifest,
  collaborators
}
```

The initial scene always comes from the backend, never from another peer.

### Mutation

```text
client -> scene.preview {
  previewId,
  elements
}

client -> scene.mutate {
  mutationId,
  baseRevision,
  elements,
  sharedSceneState
}

server -> scene.committed {
  mutationId,
  revision,
  elements,
  sharedSceneState
}
```

Only complete changed element objects, including tombstones, are sent. Shared
scene state is an explicit allowlist; zoom, selection, dialogs, active tool,
editing state, and viewport remain local.

The client uses Excalidraw's stable `onChange` callback and tracks the last sent
`version` for each element. It emits rate-limited `scene.preview` messages at
most every 100 ms for smooth collaboration. Previews are broadcast to room
members but are not persisted and do not advance document revision. Durable
`scene.mutate` messages use a one-second debounce with a five-second maximum
wait. The client sends a durable full resynchronization every 20 seconds. It
does not depend on undocumented delta APIs.

The server accepts previews only from owners and editors, validates their size,
and broadcasts them without touching PostgreSQL. A preview is discarded on
disconnect or resynchronization. The next committed mutation replaces any
preview state with canonical state.

For each mutation, the server:

1. Checks the bound socket role.
2. Validates payload limits and asset references.
3. Locks the drawing row in a transaction.
4. Deduplicates `mutationId`.
5. Reconciles incoming elements with the canonical scene: higher `version`
   wins; equal versions use the lower `versionNonce`; fractional indices define
   ordering.
6. Persists the canonical scene and increments `content_revision` once.
7. Commits the transaction.
8. Broadcasts the committed update.

Nothing is broadcast if persistence fails. Document revision is independent of
the sum of Excalidraw element versions.

Remote commits are restored and reconciled before being applied with
`CaptureUpdateAction.NEVER`. The client records remote versions before applying
the update so the resulting `onChange` is not echoed.

Viewers may join, receive snapshots and commits, download assets, and publish
rate-limited presence. Viewer scene mutations and uploads are rejected and
audited. A role downgrade updates socket authorization immediately; revocation
disconnects the socket.

Presence is ephemeral, separately rate-limited, and never advances document
revision. Reconnection receives a current snapshot. Revision gaps cause a full
snapshot resynchronization.

## 13. Autosave, offline behavior, and revisions

When WebSockets are healthy, committed WebSocket mutations are the save path.
The save indicator changes only after server acknowledgement. HTTP full-scene
saves are used for initial creation, guest migration, explicit recovery, and
offline/reconnect fallback; the client does not run competing HTTP autosaves
while the socket is healthy.

The browser keeps an IndexedDB outbox containing unacknowledged mutations and
the latest recovery snapshot. Autosave uses a one-second debounce, a five-second
maximum wait, one in-flight save, and exponential retry.

On reconnect, the client loads the canonical snapshot, reconciles pending
elements, and resubmits them with their original mutation IDs. If reconciliation
cannot safely converge after bounded retries, autosave pauses and the UI offers:

- Reload the server version.
- Save the local version as a new private drawing.
- Export the local scene.

Revision checkpoints are created on the first save, no more than once every five
minutes during editing, and immediately before restoration. The newest 20
checkpoints are retained. Restoring a checkpoint creates a new current revision;
revision numbers never move backward.

## 14. Frontend routes and composition

Routes:

```text
/                         guest local-only canvas
/login                    sign in
/signup                   create account
/invite/:token            inspect and accept invitation
/app                      authenticated dashboard
/drawings/:drawingId      authenticated editor or viewer
/settings                 account settings
```

Dashboard scope:

- Owned and shared drawing sections.
- Create, open, rename, and delete.
- Title, owner, role, and last-updated time.
- Loading, empty, offline, and error states.

Drawing composition:

```text
DrawingPage
├── DrawingHeader
│   ├── dashboard navigation
│   ├── controlled title
│   ├── save status
│   ├── presence avatars
│   ├── share action
│   └── account menu
├── ExcalidrawHost key={drawingId}
│   ├── SceneLoader
│   ├── PersistenceController
│   ├── AssetManager
│   ├── CollaborationAdapter
│   └── PermissionAdapter
└── ShareDialog
```

Remounting `ExcalidrawHost` on drawing changes prevents undo history, files,
collaborators, and editor state from leaking between documents. Server metadata
lives in TanStack Query; Excalidraw elements remain owned by Excalidraw rather
than being mirrored into a global React store.

## 15. Guest migration and sign-out

Guest state uses IndexedDB with separate scene and binary asset stores.

After sign-in, the application asks whether to save the local drawing to the
account. If accepted, it:

1. Freezes a guest snapshot and asset manifest.
2. Creates a named drawing using the guest canvas ID as an idempotency key.
3. Uploads referenced assets.
4. Saves the scene.
5. Marks the guest snapshot migrated only after server acknowledgement.
6. Navigates to the created drawing.

Guest content is never silently merged into an existing drawing. Signing out
flushes pending work when possible, disconnects sockets, clears protected scene
data from memory, and returns to the separate guest namespace. A protected
drawing is never copied automatically into guest storage.

## 16. Error and failure behavior

- Offline work is kept in IndexedDB and shown with an explicit offline status.
- Save conflicts never silently overwrite canonical content.
- Invalid or expired invitation links show a recoverable error page.
- Permission revocation disconnects collaboration immediately.
- A demoted editor with unacknowledged work can export or create a private copy.
- Asset upload failures prevent scene commits that reference the missing asset.
- Database failures do not advance revisions or broadcast changes.
- Slow clients and oversized queues are disconnected with a structured error
  after their recovery snapshot is preserved locally.
- Document-level errors include a request ID suitable for server-log lookup.

## 17. Security requirements

- Authorization is checked on every HTTP route and WebSocket event.
- Session, reset, and invitation tokens are hashed at rest.
- Login, registration, reset, invitation, upload, and mutation endpoints are
  rate-limited.
- Cross-site WebSocket hijacking is prevented with same-origin cookies and
  strict Origin validation.
- Assets are served with validated MIME types and
  `X-Content-Type-Options: nosniff`.
- Embeddable URLs follow Excalidraw validation and the application uses a strict
  Content Security Policy.
- Audit events cover invitation lifecycle, role changes, ownership transfer,
  deletion, and rejected viewer mutations.
- PostgreSQL, the asset volume, and backups must use encryption at rest in
  production.
- Backups and restoration are documented and smoke-tested before a release.

## 18. Testing and acceptance criteria

Unit tests cover:

- Role policies and owner invariants.
- Invitation expiry, email matching, replay, revocation, and SMTP fallback.
- Scene serialization, dirty tracking, autosave coalescing, and idempotency.
- Element reconciliation, nonce tie-breaking, tombstones, and fractional order.
- Asset references and guest migration.

Integration tests cover:

- The full owner/editor/viewer HTTP permission matrix.
- Authentication and optional-provider configuration.
- Raw viewer WebSocket mutation attempts.
- Two simultaneous editor mutations from the same revision.
- Lost acknowledgements and duplicate mutation IDs.
- Database failures producing no broadcast.
- Reconnection, revision gaps, role changes, and revocation.
- Asset access and cross-drawing reference rejection.

Playwright tests cover:

- Guest persistence across reload.
- Sign-up and guest migration.
- Multiple named drawings in the dashboard.
- Invitation acceptance by a new account.
- Two editors converging on distinct and identical elements.
- A viewer receiving updates while remaining unable to edit.
- Offline editing, reconnect, and recovery choices.
- Images appearing for another collaborator.

Release verification requires:

- Typecheck, lint, unit, integration, and Playwright suites.
- Production frontend and server builds.
- Database migration from an empty database and the previous release.
- Docker Compose startup in SMTP-disabled and SMTP-enabled configurations.
- Health-check and backup/restore smoke tests.
- Excalidraw package-contract fixtures against the pinned version.

The MVP is accepted when a fresh operator can clone the repository, configure
`.env`, start Docker Compose, register a user, create multiple drawings, invite
an editor and viewer, collaborate live, recover from a reconnect, and restore a
recent revision without bypassing role enforcement.

## 19. Multi-agent implementation strategy

The primary agent is the orchestrator and owns architecture, shared contracts,
integration, and final verification. The runtime does not expose per-agent model
tier selection; worker agents receive narrow roles and isolated file ownership.

Implementation proceeds in dependency-aware waves with at most three workers
plus the orchestrator:

1. Foundation wave: repository tooling, contracts, database schema, migration
   harness, Docker skeleton, and CI. Shared interfaces are frozen before
   parallel edits begin.
2. Parallel product wave:
   - Backend worker: auth, drawings, authorization, invitations.
   - Frontend worker: guest mode, auth screens, dashboard, editor shell.
   - Platform worker: storage/mail adapters and Compose deployment.
3. Parallel collaboration wave:
   - Realtime server and canonical reconciliation.
   - Browser collaboration, assets, offline outbox.
   - Sharing and revision-history UI.
4. Integration wave: orchestrator reviews diffs, resolves interface mismatches,
   and runs the complete suite.
5. Review wave: independent agents review backend security, collaboration
   convergence, and frontend isolation. Findings are fixed and reverified before
   release.

Agents do not edit the same files concurrently. Work is split by package or
feature boundary, and every agent returns a change summary and focused test
evidence. The orchestrator independently reviews all results and runs the full
verification suite.

## 20. Open-source release boundaries

This design commit intentionally does not select the public project license or
make trademark claims. Before the first public release, the repository owner
must select an open-source license, preserve required notices for dependencies,
and review whether the project name and branding can be used publicly. No public
release will occur without those checks.
