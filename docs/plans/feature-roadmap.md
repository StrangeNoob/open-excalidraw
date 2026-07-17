# Feature roadmap

Where Open Excalidraw goes after v0.7.0. The platform's core is complete:
authentication with OAuth, drawing dashboards with private tags, invitations
and roles, revisioned autosave with history, realtime editing with presence,
per-drawing chat, binary assets on local or S3 storage, public share links
with a live read-only view, and interactive API documentation. What follows
is ranked by value against effort for a self-hosted collaboration tool.

## Recently shipped

- **Trash and soft delete** — deleting moves a drawing to a per-user trash
  (`GET /api/v1/drawings/trash`); owners can restore
  (`POST /api/v1/drawings/:drawingId/restore`) or delete forever
  (`DELETE /api/v1/drawings/:drawingId/permanent`), and the existing
  maintenance job still purges trashed drawings after 7 days.
- **Duplicate drawing and templates** — `POST /api/v1/drawings/:drawingId/duplicate`
  copies the scene, assets, and thumbnail for any member; an `is_template`
  flag feeds the dashboard's "New from template" picker.
- **Public share links** (v0.7.0) — one revocable link per drawing; anyone
  with `/s/:token` gets a live read-only view without an account.
- **Dashboard thumbnails** — small PNGs rendered client-side after edits and
  stored through the existing asset pipeline.
- **Generic OIDC single sign-on** — Keycloak, Authentik, Authelia, or any
  OIDC provider via Better Auth's generic OAuth plugin; configured with
  `OIDC_*` environment variables.
- **Persistent shape libraries** — the editor's `.excalidrawlib` items now
  persist per account (`GET`/`PUT /api/v1/library`) instead of only in
  localStorage, so they follow users across devices.

## Next up

### 1. Minimal admin page

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
