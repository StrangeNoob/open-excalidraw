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

## Security

Personal access tokens are **unscoped**: a token can do anything its owner can do
over REST — read, edit, rename, trash, and share _every_ drawing in the account,
not just the one Claude is working on. Mitigate accordingly:

- mint a **dedicated** token for this plugin, never reuse a CI or script token;
- always set an expiry — a token created with **Never** stays valid until someone
  remembers to delete it;
- revoke it from the same settings page when the work is done, or if the machine
  it lives on is shared or lost.

A token cannot mint further tokens and cannot open realtime collaboration
sessions, so a leak stays bounded to REST access to the owner's drawings.

## What the skill does

- creates drawings with client-minted ids so retries cannot duplicate them;
- saves whole scenes with `If-Match`/`Idempotency-Key`, and rebases on `412`
  rather than clobbering a concurrent editor;
- lists and searches drawings, and returns share links;
- restores from revision history when a save goes wrong.

It does not upload image assets, and it deliberately batches one save per logical
change instead of streaming small edits.
