# Plan: v2 — agent drawing hardening and depth

Status: planned 2026-07-29 (follows `mcp-drawing-skill-v1.md`, whose v1 and
v1.1 are implemented and live-verified)
Branch: `feature/*` per workstream; independent workstreams may ship
separately
Estimated effort: ~12–14 dev-days total

Scope: the six backlog items carried out of the v1 research, including OAuth
for claude.ai connectors (workstream 4). OAuth ships last and is dropped if
Anthropic's connector "Request headers" beta reaches GA first — at that point
the existing PAT-bearer endpoint covers claude.ai with zero server work.

## Workstream 1 — scoped personal access tokens (~2.5d)

The v1 risk list's top security item: a PAT is currently the whole account.

**Scope model (deliberately small):** `read` | `write` | `full`.

- `read` — safe methods only (GET/HEAD) on `/api/v1` and the read MCP tools.
- `write` — everything `read` allows plus unsafe methods, EXCEPT
  `/api/v1/admin/*` and token management (already session-only).
- `full` — today's behavior. Existing tokens (scopes column NULL) resolve to
  `full` so nothing breaks on deploy.

**One enforcement seam, not per-route checks:** token identities already flow
through a single resolution point (`apps/server/src/modules/auth/identity.ts`
→ `authKind: "token"`). Attach `scope` to the resolved token identity and
enforce centrally by HTTP method + path prefix in a small middleware
registered right after identity-bearing routes' auth (or inside the resolve
seam itself): method unsafe + scope `read` → 403 `INSUFFICIENT_SCOPE`;
path under `/api/v1/admin` + scope ≠ `full` → 403. The MCP router passes the
scope into `createMcpServer`, which registers write tools (`create_drawing`,
`edit_scene`, `share_drawing`) only when the scope allows writes — clients
then never see tools they cannot call.

**Changes:**

- Migration `00xx_token_scopes.sql`: `ALTER TABLE personal_access_tokens ADD
COLUMN scopes text` (single value, not an array — YAGNI until a real need
  for combinations). Run `db:migrate` locally and update the schema
  inventory test (both are manual in this repo).
- `packages/contracts/src/tokens.ts`: `scope: z.enum(["read", "write",
"full"])` on create request + token response; default `write` (NOT `full`)
  in the web UI picker so new agent tokens stop being account-wide by
  default.
- Tokens UI: a three-option radio on the create form with one-line blast
  radius descriptions.
- Docs: `agent-drawing.md` security section switches its recommendation from
  "dedicated short-expiry token" to "dedicated short-expiry **write-scoped**
  token".

**Tests:** resolve seam (NULL → full, each scope enforced by method/path),
MCP tool listing per scope, one router-level 403 test per boundary
(read-token PUT, write-token admin route).

## Workstream 2 — headless SVG/PNG export (~3d, the risky one)

The agent cannot see what it drew, and agent-created drawings have no
dashboard thumbnail.

**Approach: SVG first, PNG derived.** `@excalidraw/excalidraw`'s
`exportToSvg` runs in Node under jsdom, but text measurement needs a canvas
implementation with the app's actual fonts registered — the fonts are
already self-hosted in the repo (the CSP work), so register those exact
files with `@napi-rs/canvas`. PNG is then rasterized from the SVG with
`resvg` (no browser, no screenshotting).

**Changes:**

- `GET /api/v1/drawings/:id/export?format=svg|png&scale=1|2` — session or
  PAT (scope `read`), owner/editor/viewer all allowed. Cache by
  `(drawingId, contentRevision, format, scale)` — revision is already the
  perfect cache key; store nothing, just `ETag`/`If-None-Match`.
- MCP tool `export_png({drawingId})` returning the PNG as an MCP image
  content block (capped ~512px longest side, mirroring the official
  excalidraw-mcp's feedback-loop size) — this closes the "agent can't see
  its work" gap end to end.
- On `edit_scene` save of a drawing whose thumbnail is missing, render and
  store the standard 512 KiB PNG thumbnail via the existing thumbnail
  service path — fixes the blank dashboard card for agent-created drawings.

**Risk + fallback:** font-metric fidelity under jsdom is THE risk (labels
overflowing boxes in export but not in the editor). Timebox a spike (0.5d):
export a scene authored in the real editor and diff text bounding boxes. If
fidelity is unacceptable, fall back to SVG-only (no text measurement needed
for correctness of shapes; text renders with the same font files) and defer
PNG. Pin `@excalidraw/excalidraw` to the exact version `apps/web` uses —
one version, one source of truth, checked by a test.

**Tests:** golden SVG snapshot for a fixture scene; ETag/304 behavior; PNG
dimensions/scale; version-pin equality test.

**Spike outcome (2026-07-29): green, both formats shipped.** Text metrics
under `@napi-rs/canvas` matched Chromium to within 0.013% across 56
string×font×size cases, and `exportToSvg` turned out to make no `measureText`
calls at all — it emits stored geometry and inlines the exact woff2 subsets,
so the SVG path is structurally immune to the risk above. `resvg` was dropped:
it ignores the inlined `@font-face` rules and cannot read woff2, while
`exportToCanvas` rasterizes directly from the same font files in ~13 ms.
Two gaps were accepted rather than fixed, both documented in
`agent-drawing.md`: PNG registers one latin subset per family, so non-Latin
scripts render as gaps there (SVG is unaffected), and image assets are not
embedded in either format — that belongs with workstream 3, which is where
the asset plumbing already lives.

## Workstream 3 — image support in skill + MCP (~1.5d)

The server side already works (asset endpoints, MIME sniffing, quotas, and
`edit_scene` computes `assetIds` from `fileId` refs). Only the teaching and
one tool are missing.

- SKILL.md: an "Images" section — upload recipe (`PUT
/drawings/:id/assets/:fileId` with `x-content-sha256`, sniffed MIME must
  match), the image element JSON shape (`type: "image"`, `fileId`, `status:
"saved"`, width/height from the actual bitmap), and the rule that the
  asset must be uploaded BEFORE the content save referencing it
  (`MISSING_ASSET` 422 otherwise). Storage quota note (asset bytes count,
  scene JSON does not).
- `read_format`: one paragraph mirroring the same rules.
- MCP tool `upload_asset({drawingId, fileId, mimeType, dataBase64})` —
  base64 in the tool arguments, capped well under the 10 MiB body limit
  (say 4 MiB decoded); returns the fileId to reference from `edit_scene`.
  Requires `write` scope (workstream 1).
- e2e scenario: agent uploads a PNG, places it, canvas shows it live.

## Workstream 4 — OAuth for claude.ai connectors (~3–4d, ships last, drop-if-obsolete)

Why it exists: claude.ai's connector form only takes a URL, so a client we
don't control has to _acquire_ the PAT-equivalent credential itself — that
acquisition flow is what OAuth standardizes. The moment the connector
"Request headers" beta GAs for this account, this whole workstream is
unnecessary; check that before starting.

**Design (lean on better-auth, which the app already uses):**

- Authorization server: better-auth's OIDC/OAuth provider plugin on the
  existing auth stack — authorization endpoint reuses the app session +
  a minimal consent screen ("Claude wants to read and edit your drawings"),
  token endpoint issues short-lived access tokens bound to
  `(userId, scope)`, refresh tokens with PAT-style expiry rules.
- Discovery: `/.well-known/oauth-protected-resource` (RFC 9728) pointing at
  the app's own authorization-server metadata; 401s from `/api/mcp` gain a
  `WWW-Authenticate` header referencing it (this is what claude.ai follows).
- Client registration: Dynamic Client Registration for claude.ai's callback
  (`https://claude.ai/api/mcp/auth_callback`), with CIMD accepted if the
  plugin supports it.
- Resource server: the MCP identity seam accepts OAuth bearer tokens
  alongside `oepat_` PATs; OAuth scopes map 1:1 onto workstream 1's
  `read`/`write` (never `full` — a connector should not get admin reach).

**Depends on workstream 1** (the scope model is the consent language).

**Tests:** discovery documents served and spec-shaped; full authorization-
code round trip against a test client; MCP call with an OAuth token resolves
the right user and scope; expired/revoked token → 401 with
`WWW-Authenticate`.

**Risk:** claude.ai connector quirks are only observable against a public
HTTPS deployment — budget a half-day of live testing against the Railway
instance; the local e2e can only prove the spec flow, not Anthropic's
client behavior.

### Shipped (2026-07-29)

Beta re-check first: the connector "Request headers" beta is still not GA for
this account, so the workstream proceeded.

better-auth 1.6.23 ships an `mcp` plugin (`better-auth/plugins`), a thin
wrapper over its deprecated `oidc-provider`, mounting `/api/auth/mcp/{authorize,
token,register}` plus `/oauth2/consent`, with three tables (`oauthApplication`,
`oauthAccessToken`, `oauthConsent`). It was configured with `requirePKCE`,
S256 only, 15-minute access tokens, 90-day refresh tokens, `scopes: [read,
write]` and `defaultScope: "openid offline_access write"` — never `full`.

Five gaps in the plugin were closed in `apps/server/src/modules/oauth`:

- **Consent was optional.** The plugin only shows a consent screen when the
  client sends `prompt=consent`, and otherwise hands a code straight to the
  redirect URI — so any site could navigate a signed-in browser to the
  authorize endpoint and collect a code. An express guard on the authorize
  path forces `prompt=consent` and pins the scope to exactly one of
  read/write before better-auth sees the request.
- **Signed-out callers.** The same guard sends them through the app's own
  `/login?returnTo=…`, because the plugin's resume-after-login hook rewrites
  the SPA's JSON sign-in response into a 302 the client cannot follow.
- **Registration was wide open** (the plugin ignores
  `allowDynamicClientRegistration` and accepts any non-`javascript:` URI). The
  guard requires a client name, exact HTTPS redirect URIs (loopback HTTP
  excepted), no wildcards or fragments, at most five, code flow only, behind a
  20/hour per-address limit.
- **Discovery.** `/.well-known/oauth-protected-resource` (RFC 9728, served at
  both the root and the `/api/mcp` path-inserted URL) and
  `/.well-known/oauth-authorization-server` (plus the `openid-configuration`
  alias) are served at the root, where clients probe; the plugin only serves
  them under `/api/auth` and advertises a `/mcp/userinfo` and `/mcp/jwks` it
  never registers. A test compares the published endpoints against the
  plugin's own document so an upstream rename cannot pass silently.
- **Refresh tokens were issued, not rotated** — the consumed row stayed valid.
  A small after-hook deletes it.

Tokens are hashed at rest by generalizing the session-token adapter wrapper
(now `token-adapter.ts`) over `oauthAccessToken.accessToken/refreshToken`; the
resource server hashes the presented value the same way and resolves it in one
query that also rejects expired tokens and disabled owners. The resolved
identity is `authKind: "token"`, so `enforceTokenScope`, the token-management
gate and the collaboration gate all apply unchanged. Migration
`0019_oauth_clients.sql`. Consent and post-login resume are two routes in the
web app's existing auth pages (`/oauth/consent`, `/oauth/authorize`).

Known limits, all judged acceptable rather than overlooked:

- The plugin ignores the RFC 8707 `resource` parameter. Harmless here: tokens
  are opaque, this deployment is the only resource, and a token is only valid
  against the row that issued it.
- Client secrets are stored as the plugin writes them, because its token
  endpoint compares them in plaintext. PKCE, exact redirect matching and the
  registration guard carry the weight instead; a connector registered with
  `token_endpoint_auth_method: none` has no secret at all.
- The plugin signs its `id_token` with a per-request throwaway HMAC key, so it
  cannot be verified by anyone. We publish OAuth metadata with no `jwks_uri`,
  so nothing should read it; a client that insists on OIDC will not work.
- Expired grant rows are not swept. They cannot authenticate, and there is at
  most one live row per grant (rotation deletes the consumed one), so this is
  a line in `cleanupExpiredSecurityRecords` whenever someone wants it.
- There is no "connected apps" UI yet — revoking a connector is a `DELETE`
  documented in `agent-drawing.md`.

Anthropic's real client behavior remains unverified: it needs a public HTTPS
deployment. Everything below the connector — discovery shape, the challenge
header, the code+PKCE round trip, rotation, expiry, revocation and the scope
boundaries — is covered by `apps/server/test/oauth.integration.test.ts`
against a real Postgres and a real better-auth instance.

## Workstream 5 — incremental `scene.committed` for external writes (gated, metric first ~0.5d; implementation 3–5d only if triggered)

Today every external save broadcasts a full-snapshot resync. Fine at agent
scale; wasteful if agents ever stream many small edits.

- **Now (cheap):** add a counter to the existing Prometheus endpoint
  (`apps/server/src/http/metrics.ts`) — `resync_broadcasts_total` labeled by
  reason, plus room size at broadcast time. This turns "is snapshot-resync
  churn a problem?" from a debate into a graph.
- **Trigger:** sustained > ~10 `external-save` resyncs/minute on rooms with
  ≥ 2 members, or user reports of visible canvas stutter during agent
  edits.
- **Then (the real work):** route external writes through the mutation
  pipeline (`PostgresMutationRepository.persist` reconcile semantics) and
  emit incremental `scene.committed` (changed elements only) instead of
  resync. The gateway's single-publish-point invariant moves into a shared
  publisher. Do not start this without the metric crossing the trigger —
  the v1 red-team and both v1.1 reviewers agreed it is not yet justified.

## Workstream 6 — e2e agent suite + upstream drift canary (~2d)

One suite, three jobs: close the two remaining workstream-D scenarios,
become the regression net for workstreams 2/3/5, and act as the canary when
`@excalidraw/excalidraw` is upgraded (the format reference and
`scene-edit.ts` have no other guard against upstream element-semantics
drift).

- A Playwright spec (`apps/web` e2e project, which already exists) driving
  the real stack: two pages + REST/MCP writes. Scenarios: (a) external
  write appears live, (b) 412 rebase-retry under an actively-editing page,
  (c) tombstone delete stays deleted, (d) **concurrent drag** — user drags
  an element while the agent edits a different one; both survive, (e)
  **restore recovery** — bad save, restore from history UI, canvas
  converges. (a)–(c) were validated by hand in v1; the spec makes them
  repeatable.
- CI: run the suite in the existing integration workflow (CI already
  provisions Postgres). Add a lockfile-watch job (or a plain conditional
  step) that runs the suite whenever `@excalidraw/excalidraw`'s resolved
  version changes in `pnpm-lock.yaml` — that PR is exactly when drift
  lands.

## Sequencing

1 (scoped PATs) and 6 (e2e suite) first and in parallel — one is the top
security item, the other is the safety net everything else runs behind.
Then 2 (export), then 3 (images, which reuses 2's thumbnail path for its
e2e assertion). 4 (OAuth) last: it depends on 1's scope model, and every
week of delay is a week for the request-headers beta to make it
unnecessary — re-check the beta's status immediately before starting.
5 stays dormant: ship the metric with whichever workstream lands first,
implement only on trigger.

Per project process: Opus implementation agents per workstream in isolated
worktrees (pin the base sha in every prompt), review pass over each diff,
tests/lint before push.

## Acceptance criteria

- A `read`-scoped token cannot mutate anything (403), cannot see write MCP
  tools, and a legacy NULL-scope token behaves exactly as before.
- `export_png` returns an image the agent can act on; an agent-created
  drawing shows a dashboard thumbnail without any browser having opened it.
- An agent can place an uploaded image and it appears live on an open
  canvas.
- A claude.ai custom connector pointed at the instance completes the OAuth
  consent flow and can call the MCP tools as the consenting user with
  `read`/`write` scope — or the workstream is closed as obsolete with the
  request-headers beta documented as the path instead.
- `resync_broadcasts_total` visible in `/metrics`.
- The e2e suite passes locally and in CI, covers scenarios (a)–(e), and
  runs automatically on any `@excalidraw/excalidraw` version bump.
