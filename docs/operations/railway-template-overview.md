# Deploy and Host Open Excalidraw on Railway

Open Excalidraw is a self-hostable collaboration and persistence layer built
around the published Excalidraw editor: named drawing dashboards,
authenticated real-time editing, revision history with restore, email-based
invitations with owner/editor/viewer permissions, public read-only share
links, and per-drawing chat.

## About Hosting Open Excalidraw

The template deploys one prebuilt application service
(`ghcr.io/strangenoob/open-excalidraw`) beside Railway's managed PostgreSQL.
Railway generates the authentication secret and the operator recovery token,
references the private database URL, and mounts a persistent volume at
`/data/assets` for binary assets. The image applies database migrations
before each start. No user-entered variables are required. SMTP is optional:
without it, owners copy invitation links for manual delivery.

Setting the optional `ADMIN_EMAILS` variable (comma-separated) unlocks a
built-in admin page with instance counts and user management. Admin access
additionally requires the account's email to be verified, which happens
through the SMTP verification link or a Google, GitHub, or OIDC sign-in —
so configure one of those alongside `ADMIN_EMAILS`.

The application service must run as exactly one replica: real-time
collaboration state lives in-process, and the asset volume mounts to a
single instance. Scaling out is unsupported.

## Why Deploy Open Excalidraw on Railway

- Keep drawings, revision history, and uploaded assets in a database and
  volume you control.
- Start with generated secrets and a working public domain — no manual
  configuration at deploy time.
- Email/password sign-in works immediately; add Google, GitHub, or any
  generic OIDC provider later through environment variables.
- Real-time collaboration and chat run inside the single service with no
  extra infrastructure.
- Manage users and watch instance usage (users, drawings, storage) from a
  built-in admin page — no SQL required.
- Move binary assets to any S3-compatible bucket later with the bundled
  migration CLI.

## Common Use Cases

- A team whiteboard with named drawings, private tags, and per-drawing
  permissions.
- Architecture and design diagrams kept under revision history with restore.
- Publishing live read-only share links to documents, wikis, or customers.
- Classroom or workshop sketching where guests draw locally and sign up to
  persist.

## Dependencies for Open Excalidraw Hosting

Open Excalidraw ships as a single Node.js image that serves the web UI, REST
API, and Socket.IO collaboration from port 3000, persisting to PostgreSQL.

### Deployment Dependencies

- Railway service running `ghcr.io/strangenoob/open-excalidraw:latest`
- Railway PostgreSQL service
- Private `${{Postgres.DATABASE_URL}}` service reference
- Generated `BETTER_AUTH_SECRET` and `ADMIN_RESET_TOKEN`
- Persistent volume at `/data/assets` for binary assets
- Optional `ADMIN_EMAILS` for the admin page (requires a verified email via
  SMTP or an OAuth/OIDC sign-in)
- Optional `DISABLE_SIGNUPS=true` to block new account registration across
  email/password and OAuth/OIDC (existing users keep signing in)
