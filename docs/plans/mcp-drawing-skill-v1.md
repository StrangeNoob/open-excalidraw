# Plan: v1 "Claude draws on the hosted app" — skill + resync broadcast

Status: planned (research: 2026-07-29 viability study — verdict VIABLE)
Branch: `feature/mcp-drawing-skill`
Estimated effort: ~5 dev-days

## Goal

Let Claude (Claude Code) create and edit drawings on a user's hosted
open-excalidraw instance through the existing REST API, and make those edits
appear live on any open canvas. Deliverables:

1. **Server change**: broadcast `room.resyncRequired` when drawing content is
   saved over REST, so open editors converge instead of rendering a stale
   scene forever.
2. **Agent Skill** (`SKILL.md`): teaches Claude the REST workflows and the
   exact element-JSON rules the server/reconciler enforces.
3. **Plugin packaging**: the skill installable via
   `/plugin marketplace add <owner>/open-excalidraw`.
4. **End-to-end validation** against a running stack.

Non-goals for v1 (from the research, red-team-confirmed): no `/mcp` HTTP route
(that is v1.1), no OAuth, no npm stdio server, no image assets, no scoped
PATs, no server-side element normalization, no socket-level agent presence.

## Workstream A — resync broadcast on REST content save (server, ~1d)

Mirror the existing revision-restore seam. Verified facts this rests on:

- `ContentService` already takes an injected `events.restored` callback
  (`apps/server/src/modules/content/service.ts:24-27`, fired at `:123`),
  wired in `apps/server/src/server.ts:154` to
  `roomRegistry.requestResync(drawingId, revision, "revision-restored")`.
- The gateway relays registry events to the room
  (`apps/server/src/modules/collaboration/socket-gateway.ts:240-247`), and the
  web client re-joins on any resync reason without inspecting it
  (`apps/web/src/features/collaboration/controller.ts:379-386`), merging via
  the outbox/owned-element rebase.
- **Constraint (verified)**: the client validates every incoming event with
  `serverRealtimeEventSchema.safeParse` and silently drops parse failures
  (`apps/web/src/features/collaboration/transport.ts:107-109`). The resync
  reason is a closed enum (`packages/contracts/src/realtime.ts:124-129`), so a
  new reason value MUST be added to the shared contract enum.

### Changes

1. `packages/contracts/src/realtime.ts` — add `"external-save"` to the
   `roomResyncRequiredEventSchema` reason enum.
2. `apps/server/src/modules/content/service.ts` — add optional
   `saved?: (drawingId, revision) => void` beside `restored`; fire it only on
   an actual commit (`status: "saved"`), never on idempotent replay or
   conflict.
3. `apps/server/src/modules/collaboration/room-registry.ts:13,115-128` and
   `socket-gateway.ts` gateway-event types — widen the hardcoded
   `"revision-restored"` reason literal to the union (or import the contract
   type so it can't drift again).
4. `apps/server/src/server.ts` (beside `:154`) — wire `saved` →
   `roomRegistry.requestResync(drawingId, revision, "external-save")`.

Notes:
- When collaboration is disabled or nobody has the drawing open, there is no
  room; `requestResync` is a no-op. The web client's own REST-fallback
  autosave also lands here — a broadcast to an empty/own room is harmless.
- Version-skew caveat: a browser tab running a pre-deploy bundle drops the
  unknown reason and stays stale — identical to today's behavior, self-heals
  on reload. Acceptable for single-version self-hosted deployments.

### Tests (workstream A)

- Unit (content service): `saved` fires on commit with the new revision; does
  NOT fire on idempotent replay or 412 conflict.
- Integration (collab, model on `collaboration-services.test.ts` /
  `run-app` Postgres suites): two clients join a room → REST `PUT` content →
  both receive `room.resyncRequired` with reason `external-save` and converge
  to the new scene.
- Merge-safety: client with an in-flight dirty element survives the resync
  with its edit preserved; a REST scene that tombstones an element
  (`isDeleted: true`, version bumped) stays deleted after resync — and a REST
  scene that merely *omits* an element gets it resurrected from the client
  outbox (expected reconcile behavior; the test documents it so the skill's
  tombstone rule stays honest).

## Workstream B — SKILL.md (~2–2.5d, the load-bearing artifact)

Location: `plugins/open-excalidraw/skills/draw/SKILL.md` (see workstream C).
Sources to crib from: the local `excalidraw-diagram` skill (element JSON
conventions) and the official `excalidraw/excalidraw-mcp` `read_me` cheat
sheet (label centering, strict-JSON rules).

### Required sections

1. **Setup** — `OPEN_EXCALIDRAW_URL` + `OPEN_EXCALIDRAW_TOKEN` env vars; PAT
   minting walkthrough (web UI → settings → tokens); mandate a dedicated
   token with `expiresInDays` set (never `null`) and note the blast radius
   (PATs are unscoped).
2. **Workflows** — exact `curl` recipes:
   - Create: `POST /api/v1/drawings` with client-minted UUID +
     `idempotencyKey` (retry-safe).
   - Read: `GET /api/v1/drawings/:id/content` → capture `revision`.
   - Update: GET → mutate elements → `PUT .../content` with
     `If-Match: <revision>` + `Idempotency-Key: <uuid>`; on 412 re-GET,
     rebase (re-apply agent elements with `version = max(existing)+1`),
     retry ≤3; one batched PUT per logical change, never per-element PUTs.
   - Find: `GET /drawings` + `GET /drawings/search?q=` (search returns bare
     ids — join against the list for titles).
   - Deliver: `POST /drawings/:id/share-link` → return the URL to the user.
   - Recover: `GET .../revisions` + restore (undo for any bad save).
3. **Element format reference** — the four red-team findings, stated as hard
   rules:
   - **Envelope is strict**: body is
     `{"scene":{"type":"excalidraw","version":2,"source":...,"elements":[...],"appState":{...}},"assetIds":[]}`.
     No top-level `files` key (standard `.excalidraw` exports get 400);
     `assetIds` is exactly `[]` in v1 (no images).
   - **Z-order is fractional `index`** (`"a0"`, `"a1"`, …), not array order.
     Rules for appending after the last index and inserting between
     neighbors; elements without `index` sink to one end when merged into a
     live scene.
   - **Versioning**: new elements `version: 1`; any touched element gets
     `version` strictly above the base it was read at; `versionNonce` =
     random int32 (lower nonce wins version ties — the bump, not the nonce,
     is the protection). Concurrent edits to the *same* element by a live
     user are last-write-wins and may be lost; don't fight the user's
     in-progress drags.
   - **Deletes are tombstones**: `isDeleted: true` + version bump. An
     omitted element resurrects from a collaborator's outbox.
   - Bindings: arrows carry `startBinding`/`endBinding` with reciprocal
     `boundElements` on the shapes; labels as separate centered text
     elements (official-MCP convention: `x = shape.x + (shape.width -
     text.width)/2`) rather than container binding.
   - Limits: 50k elements / 10 MiB per scene.
4. **Verification loop** — after every PUT, re-GET the scene and sanity-check
   structure; give the user the drawing/share URL (live resync from
   workstream A shows the result on their open canvas).

## Workstream C — plugin packaging + docs (~0.5d)

- `plugins/open-excalidraw/.claude-plugin/plugin.json` + `skills/draw/SKILL.md`;
  repo-root `.claude-plugin/marketplace.json` listing the plugin (any GitHub
  repo with that file is a marketplace).
- Run `claude plugin validate` locally; no CI wiring in v1.
- Docs page (`docs/` or README section): install =
  `/plugin marketplace add <owner>/open-excalidraw` → `/plugin install`;
  PAT minting walkthrough with screenshots optional.

## Workstream D — end-to-end validation (~1d)

Use the `run-app` skill (containerized Postgres + API + web + Playwright).
Scenarios, each driven as a real skill session against the running stack:

1. Fresh flowchart from scratch → renders correctly in the web client, share
   link resolves publicly.
2. Edit-existing while an editor has the drawing open in the Playwright
   browser → canvas updates live (resync), no reload.
3. Concurrent-edit conflict: live editor autosaving while the agent PUTs →
   412 → rebase/retry loop converges without clobbering either side.
4. Tombstone delete under a live editor → element stays deleted.
5. Bad-save recovery: intentionally malformed-but-schema-valid scene →
   restore from revision history.

Then full `pnpm test`, `pnpm lint`, `pnpm typecheck` before push.

## Sequencing

- A and B are independent — run in parallel (A: Opus implementation agent; B:
  Opus agent drafting SKILL.md from this plan + the research report).
- C after B. D last, against A+B+C combined.
- Per project process: implementation agents on Opus in isolated worktrees
  (pin the base sha in every agent prompt), review pass (`/code-review`) over
  the full diff, findings verified and addressed before push.

## Acceptance criteria

- REST `PUT` to a drawing open in two browsers → both canvases show the new
  content within ~2s, no reload; an in-flight local edit survives.
- A skill session with only `OPEN_EXCALIDRAW_URL`/`OPEN_EXCALIDRAW_TOKEN` set
  can: create a drawing, draw a labeled multi-node flowchart with bound
  arrows, edit it under a live editor, delete an element durably, and return
  a working share link.
- All five workstream-D scenarios pass; tests/lint/typecheck green;
  `claude plugin validate` passes.

## Risks

| Risk | Mitigation |
|---|---|
| Model emits schema-valid but render-breaking elements | Strict format reference (B3); revision-restore recovery documented; if it bites in practice, promote validation into the v1.1 `/mcp` route |
| Resync churn if the agent streams many small PUTs | Skill mandates one batched PUT per logical change; incremental `scene.committed` path stays deferred until measured |
| Unscoped PAT in agent env | Dedicated short-expiry token mandated in docs; scoped tokens = first post-v1 server feature |
| Skill format reference rots against upstream Excalidraw drift | Workstream D scenarios double as a canary — rerun on `@excalidraw/excalidraw` upgrades |

## v1.1 pointer (out of scope, pre-committed)

Stateless Streamable HTTP `/mcp` route mounted on the API server (official TS
SDK, PAT bearer, the same 4–5 coarse tools), moving the CAS/version/index/
tombstone logic from prompt-space into tested TypeScript. Trigger: the first
time workstream-D-style format errors show up in real use, or when claude.ai
reach is wanted.
