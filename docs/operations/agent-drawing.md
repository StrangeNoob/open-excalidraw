# Drawing from Claude Code

The `open-excalidraw` plugin teaches Claude Code to create and edit drawings on
an instance over the REST API. It writes scenes the same way the editor does, so
a canvas that is open at the time updates live without a reload.

## Install the plugin

The repository is itself a plugin marketplace. In Claude Code:

```
/plugin marketplace add StrangeNoob/open-excalidraw
/plugin install open-excalidraw@open-excalidraw
/reload-plugins
```

The plugin ships one skill, `/open-excalidraw:draw`. Claude also picks it up on
its own when a request is about drawing on the instance.

To try it from a local checkout instead, run
`claude --plugin-dir ./plugins/open-excalidraw`.

## Create a token

The skill authenticates with a personal access token, not a browser session.

1. Open the dashboard and follow **Settings** in the header.
2. In the **API tokens** section, fill in **Token name** (for example
   `claude-code`).
3. Set **Expires** to `30 days`, `90 days`, or `365 days`. Do not pick `Never`.
4. Press **Create token** and copy the `oepat_…` secret. It is shown once and
   cannot be retrieved again.

See the [API automation runbook](api-automation.md) for token limits, revocation,
and audit behaviour.

## Configure the environment

The skill reads two variables:

| Variable                | Value                                                                |
| ----------------------- | -------------------------------------------------------------------- |
| `OPEN_EXCALIDRAW_URL`   | Instance origin, e.g. `https://draw.example.com` (no trailing slash) |
| `OPEN_EXCALIDRAW_TOKEN` | The `oepat_…` secret                                                 |

```bash
export OPEN_EXCALIDRAW_URL="https://draw.example.com"
export OPEN_EXCALIDRAW_TOKEN="oepat_…"
```

Set `OPEN_EXCALIDRAW_URL` in the shell that starts Claude Code or in the `env`
block of `.claude/settings.json` — it is not a secret. Keep
`OPEN_EXCALIDRAW_TOKEN` only in the launching shell or user-local secret
storage; never put it in project-scoped settings files, and never commit it.

## MCP endpoint

An instance also speaks MCP at `POST /api/mcp` (stateless Streamable HTTP), for
clients that prefer tools over a skill:

```
claude mcp add --transport http open-excalidraw https://draw.example.com/api/mcp \
  --header "Authorization: Bearer $OPEN_EXCALIDRAW_TOKEN"
```

Same token, same permissions — the endpoint authenticates with the personal
access token from above and does everything as its owner.

The tools mirror the skill's workflows — `read_format`, `list_drawings`,
`create_drawing`, `get_scene`, `edit_scene`, `upload_asset`, `share_drawing` —
with one difference: `edit_scene` takes only the elements you are adding,
changing, or deleting. Element versions, z-order indices, tombstones, and the retry when
someone saves first are handled server-side rather than in the prompt.

`upload_asset` takes the image as base64 in its arguments (up to 4 MiB decoded)
and returns the `fileId` to put on an image element; the skill does the same
thing with a `PUT` of the raw bytes. Either way the upload has to land before
the save that references it. It is a write, so a `read`-scoped token does not
see it.

`export_png` has no equivalent in the skill: it renders a drawing server-side
and hands the image back, so the agent can look at what it drew — overlapping
shapes, uneven spacing, a label wider than its box — instead of inferring the
layout from coordinates. It is a read, so a `read`-scoped token may call it.

Skill or endpoint, not both: they do the same job, and loading both only spends
context twice.

## claude.ai connector

claude.ai's custom-connector form takes only a URL, so the connector cannot be
given a personal access token — it has to obtain its own credential, which is
what the instance's OAuth authorization server is for. Paste:

```
https://draw.example.com/api/mcp
```

The instance has to be reachable from the internet over HTTPS with a valid
certificate; nothing else needs configuring, and Claude Code users are
unaffected — bearer `oepat_` tokens keep working exactly as above.

Claude discovers the authorization server from the endpoint itself
(`/.well-known/oauth-protected-resource/api/mcp`, and the `WWW-Authenticate`
header on an unauthenticated call), registers itself, and sends you to this
instance to sign in. The consent screen then names the application and what it
is asking for, in these words:

- _See your drawings and everything in them_ (`read`)
- _Create drawings, and change or delete anything in them_ (`write`)

A connector that names no scope gets `write`, which is what the screen says
before you approve it. There is no third option: an OAuth grant can never
reach `/api/v1/admin/*` or token management, so a connector cannot administer
the instance or mint tokens — the same gate that stops a scoped personal access
token stops it.

Access tokens last 15 minutes and refresh tokens 90 days, after which the
connector asks again. Both are stored only as SHA-256 digests, like personal
access tokens: a database read yields no usable credential, and expired grants
are swept by the maintenance job. To cut a connector off before then, delete its grants:

```sql
DELETE FROM oauth_access_token WHERE client_id = '<client id>';
-- or drop the client entirely, which cascades to its tokens and consent:
DELETE FROM oauth_application WHERE client_id = '<client id>';
```

**Standing caveat:** this whole flow exists because the connector form cannot
send a header. Anthropic's connector "Request headers" beta removes that limit;
once it is generally available, pointing a connector at `/api/mcp` with an
`Authorization: Bearer oepat_…` header is the simpler path and OAuth becomes
optional.

## Security

A token reaches every drawing in the account, not just the one Claude is working
on, and its scope decides what it may do there: **read** allows safe reads only,
**write** adds creating, editing, renaming, trashing and sharing, and **full**
additionally allows instance administration. Mitigate accordingly:

- mint a **dedicated write-scoped** token for this plugin, never reuse a CI or
  script token, and never give an agent a `full` token;
- always set an expiry — a token created with **Never** stays valid until someone
  remembers to delete it;
- revoke it from the same settings page when the work is done, or if the machine
  it lives on is shared or lost.

A token cannot mint further tokens and cannot open realtime collaboration
sessions, so a leak stays bounded to REST access to the owner's drawings. An
OAuth connector token is the same kind of credential with the same limits, and
is additionally capped at `read` or `write`.

## Exports

`GET /api/v1/drawings/{id}/export?format=svg|png&scale=1|2` renders a drawing
without a browser: Excalidraw's own exporters run in the API process under
jsdom, with the instance's self-hosted fonts. Any account that can open the
drawing can export it, including a `read`-scoped token, since it is a read.

```bash
curl -H "Authorization: Bearer $OPEN_EXCALIDRAW_TOKEN" \
  "$OPEN_EXCALIDRAW_URL/api/v1/drawings/$ID/export?format=png&scale=2" \
  -o drawing.png
```

`format` defaults to `svg` and `scale` to `1`; `scale` applies to PNG only.
Nothing is cached on disk — the response carries an `ETag` built from the
content revision, so `If-None-Match` gets a `304` until the drawing changes.
Renders over 8 MiB are refused with `EXPORT_TOO_LARGE`.

Two known gaps, both harmless for the drawings an agent authors:

- **Images are not embedded.** Elements referencing an uploaded asset render
  as empty placeholders. Everything else — shapes, arrows, text — is exact.
- **PNG text is Latin-only.** SVG carries the right font subset for any
  script; the PNG rasterizer has one subset per family registered, so
  Cyrillic, CJK and emoji come out as gaps. Use `format=svg` for those.

An agent-created drawing gets its dashboard thumbnail from the same renderer:
the first `edit_scene` on a drawing with no thumbnail renders one, so the card
is not blank before anyone opens the drawing in a browser.

Operationally, the renderer is a lazy singleton — the first export in a
process pays ~200 ms and roughly 250 MB of resident memory to boot, and
renders are serialized after that. Each render costs on top of that boot
figure, and roughly in proportion to the element count, so exports are capped:
scenes over 10,000 elements answer `413 EXPORT_TOO_LARGE`, either dimension is
clamped to 8192 px however large the scene's coordinates are, and a rendered
body over 8 MiB is refused rather than streamed. It needs
`dist/excalidraw-export.mjs` (produced by
`pnpm --filter @open-excalidraw/server run bundle:excalidraw-export`, and by
the image build); exports answer `503 EXPORT_UNAVAILABLE` while it is missing.

## What the skill does

- creates drawings with client-minted ids so retries cannot duplicate them;
- saves whole scenes with `If-Match`/`Idempotency-Key`, and rebases on `412`
  rather than clobbering a concurrent editor;
- lists and searches drawings, and returns share links;
- uploads image assets and places them as image elements;
- restores from revision history when a save goes wrong.

It deliberately batches one save per logical change instead of streaming small
edits.
