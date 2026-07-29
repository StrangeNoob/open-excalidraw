# Plan: v2 — agent drawing hardening and depth

Status: planned 2026-07-29 (follows `mcp-drawing-skill-v1.md`, whose v1 and
v1.1 are implemented and live-verified)
Branch: `feature/*` per workstream; independent workstreams may ship
separately
Estimated effort: ~8–10 dev-days total

Scope: the five backlog items carried out of the v1 research. Explicitly out
of scope: OAuth for claude.ai connectors (wait for the request-headers beta
to GA; revisit only if real multi-user claude.ai demand appears first).

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
e2e assertion). 5 stays dormant: ship the metric with whichever workstream
lands first, implement only on trigger.

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
- `resync_broadcasts_total` visible in `/metrics`.
- The e2e suite passes locally and in CI, covers scenarios (a)–(e), and
  runs automatically on any `@excalidraw/excalidraw` version bump.
