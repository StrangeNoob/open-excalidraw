# Feature roadmap

Where Open Excalidraw goes after v0.7.0. The platform's core is complete:
authentication with OAuth, drawing dashboards with private tags, invitations
and roles, revisioned autosave with history, realtime editing with presence,
per-drawing chat, binary assets on local or S3 storage, public share links
with a live read-only view, and interactive API documentation. What follows
is ranked by value against effort for a self-hosted collaboration tool.

## Recently shipped

- **Public share links** (v0.7.0) — one revocable link per drawing; anyone
  with `/s/:token` gets a live read-only view without an account.

## Next up

### 1. Dashboard thumbnails

The dashboard is text-only cards. Excalidraw ships `exportToBlob`; render a
small PNG client-side on save and store it through the existing asset
pipeline. Cheap to build, and it transforms how the dashboard feels.

### 2. Generic OIDC single sign-on

Google and GitHub OAuth exist, but the self-hosting audience runs Keycloak,
Authentik, or Authelia. Better Auth has a generic OIDC plugin, so this is
mostly configuration plumbing — and it is one of the most-requested
capabilities for any self-hosted product.

### 3. Duplicate drawing and templates

Duplicating is nearly free: copy the scene and asset references, both owned
by the server. Templates then fall out of it — a boolean flag plus a "New
from template" list on the dashboard.

### 4. Trash and soft delete

Deleting a drawing today is forever. A `deleted_at` column already exists on
`drawings`; what is missing is a trash view, a restore action, and a purge
job. Small diff that prevents the worst kind of support request.

### 5. Persistent shape libraries

The editor supports `.excalidrawlib` libraries but keeps them in
localStorage, so they do not follow users across devices. Persisting them
per-account is a natural fit for the existing storage layer.

### 6. Minimal admin page

Operators currently manage users with `ADMIN_RESET_TOKEN` and SQL. A user
list with disable/delete plus instance counts (users, drawings, storage)
goes a long way for a self-hosted deployment.

## Deliberate non-goals

- **Anchored canvas comments** — per-drawing chat covers most of the need;
  Figma-style pinned threads are large and can be revisited on demand.
- **Multi-node realtime scaling** — the collaboration runbook documents the
  single-node boundary; scaling beyond it is operational work to take on
  when a deployment actually hits the limit.
- **Folders** — private per-user tags already organize the dashboard.
