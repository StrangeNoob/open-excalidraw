---
name: draw
description: Create and edit drawings on a self-hosted Open Excalidraw instance over its REST API — flowcharts, architecture diagrams, wireframes, sketches. Use when the user asks to draw, diagram, sketch, or update a drawing on their Open Excalidraw server, instance, or canvas, when they paste a drawing URL from it, or when OPEN_EXCALIDRAW_URL is set.
---

# Draw on an Open Excalidraw instance

Author scenes as JSON and save them over REST. The canvas of anyone who has
the drawing open updates without a reload.

## Setup

Two environment variables:

- `OPEN_EXCALIDRAW_URL` — instance origin, e.g. `https://draw.example.com`
  (serves both the web app and `/api`). No trailing slash.
- `OPEN_EXCALIDRAW_TOKEN` — personal access token, starts with `oepat_`.

If either is missing, stop and tell the user how to get them: **Dashboard →
Settings → API tokens**, fill in _Token name_, pick an _Expires_ value
(30/90/365 days — not _Never_), press _Create token_, copy the secret (it is
shown once). Tokens are unscoped: they can do anything the user can do over
REST, so use a dedicated token with an expiry, never a shared one.

Check both before doing anything else:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' \
  "$OPEN_EXCALIDRAW_URL/api/v1/drawings" \
  -H "Authorization: Bearer $OPEN_EXCALIDRAW_TOKEN"
```

`200` means good. `401` means the token is wrong, expired, or revoked.

Tokens cannot join realtime sessions and cannot manage tokens — REST only.

## Ground rules

1. **One batched `PUT` per logical change.** Build the whole scene, save once.
   Never save per element.
2. **Every save is compare-and-swap.** `If-Match` carries the revision you read;
   `Idempotency-Key` is a fresh UUID per distinct payload.
3. **Send the whole scene back.** The save replaces stored content wholesale.
   Elements you drop out of the array are gone from storage (and can be revived
   by a live editor's pending edits — see Deleting).
4. **Do not fight a live editor.** Add and change your own elements; leave
   elements the user may be dragging alone.

## Workflows

Shell setup used by every recipe:

```bash
AUTH="Authorization: Bearer $OPEN_EXCALIDRAW_TOKEN"
API="$OPEN_EXCALIDRAW_URL/api/v1"
uuid() { python3 -c 'import uuid; print(uuid.uuid4())'; }
```

### Create a drawing

Mint the id yourself so a retry cannot create duplicates. Re-posting an id you
already own replays the existing drawing; an id owned by someone else returns
`409 DRAWING_ID_CONFLICT`.

```bash
ID=$(uuid)
curl -sS -X POST "$API/drawings" -H "$AUTH" -H "Content-Type: application/json" \
  -d "{\"id\":\"$ID\",\"title\":\"Deploy pipeline\",\"idempotencyKey\":\"$(uuid)\"}"
```

`201` with the drawing summary. `contentRevision` is `"0"` on a fresh drawing —
use it as the `If-Match` for the first save; no `GET` needed.

### Read the scene

```bash
curl -sS -D - -o scene.json "$API/drawings/$ID/content" -H "$AUTH"
```

Body: `{"revision":"7","scene":{…},"assetIds":[…],"savedAt":"…"}`. The `ETag`
header carries the same revision, quoted. Keep `revision` — it is the
precondition for the save, and it changes on every save by anyone.

### Save the scene (CAS loop)

```bash
curl -sS -X PUT "$API/drawings/$ID/content" -H "$AUTH" \
  -H "Content-Type: application/json" \
  -H "If-Match: $REVISION" \
  -H "Idempotency-Key: $(uuid)" \
  --data-binary @save.json
```

`200` returns `{"revision":"8","savedAt":"…"}`.

Both headers are mandatory: no `If-Match` → `428 PRECONDITION_REQUIRED`,
`If-Match: *` → `400`, no `Idempotency-Key` → `400 IDEMPOTENCY_KEY_REQUIRED`
(it must be a UUID).

On `412 VERSION_CONFLICT` someone saved first:

1. `GET` the content again — take the new `revision` and the new elements.
2. Rebase: re-apply your elements onto the fresh scene. For each element you are
   rewriting, set `version` to _that element's version in the fresh scene_ plus
   one. Elements you did not author stay untouched.
3. `PUT` again with the new revision and a **new** `Idempotency-Key`.

Retry at most 3 times, then stop and tell the user the drawing is being edited
right now. Reusing an idempotency key with a different payload is
`409 IDEMPOTENCY_MISMATCH`; reusing it with the identical payload replays the
first result (that is the safe retry for a timeout or a dropped connection).

Other failures: `403` (read-only access), `404` (unknown or trashed drawing),
`413 SCENE_TOO_LARGE`, `422 ASSET_MANIFEST_MISMATCH` (see `assetIds` below),
`400 INVALID_REQUEST` with per-field errors when the envelope is malformed.

### Find drawings

```bash
curl -sS "$API/drawings" -H "$AUTH"                       # {"owned":[…],"shared":[…],"nextCursor":…}
curl -sS "$API/drawings/search?q=deploy+pipeline" -H "$AUTH"   # {"drawingIds":[…]}
```

Search covers canvas text only — text elements and frame names, never titles —
and returns **bare ids ranked by relevance**. Join them against the list response
to show the user names. A drawing with no text saved yet never matches; find
those by title in the list response.

### Share a link

```bash
curl -sS "$API/drawings/$ID/share-link" -H "$AUTH"   # {"active":true,"url":"…","createdAt":"…"} or {"active":false}
curl -sS -X POST "$API/drawings/$ID/share-link" -H "$AUTH"   # {"url":"…","createdAt":"…"}
```

`GET` first. Every `POST` mints a fresh token and **revokes the previous link**,
so only post when there is no active link or the user asked to rotate it. Return
the URL to the user.

### Recover a bad save

```bash
curl -sS "$API/drawings/$ID/revisions" -H "$AUTH"
curl -sS -X POST "$API/drawings/$ID/revisions/$REV/restore" -H "$AUTH"
```

Revisions are periodic checkpoints (roughly one per five minutes of saving
activity) plus restores — not one per save, so do not count on rolling back the
exact previous state. Restore moves forward: it writes the old scene as a new
revision.

## Scene format

These are hard rules; the API rejects or the merge silently reorders anything
that breaks them.

### Envelope (strict — unknown keys are rejected)

```json
{
  "scene": {
    "type": "excalidraw",
    "version": 2,
    "source": "open-excalidraw-skill",
    "elements": [],
    "appState": { "viewBackgroundColor": "#ffffff" }
  },
  "assetIds": []
}
```

No top-level `files` key — a standard `.excalidraw` export pasted as-is gets
`400`. `appState` holds document state only (`viewBackgroundColor`, `gridSize`,
`gridStep`); leave viewport, selection, and tool state out.

`assetIds` must be the sorted, de-duplicated list of every `fileId` referenced by
the elements. Author scenes with no images and it stays `[]`; when editing a
drawing that has images, echo back exactly what the `GET` returned and do not
touch the image elements. A mismatch is `422 ASSET_MANIFEST_MISMATCH`. This skill
does not upload assets.

### Every element needs

`id` (string), `type`, `version` (non-negative int), `versionNonce` (int),
`isDeleted` (bool), `index` (string). Everything else Excalidraw expects
(`x`, `y`, `width`, `height`, `strokeColor`, `backgroundColor`, `fillStyle`,
`strokeWidth`, `strokeStyle`, `roughness`, `opacity`, `angle`, `seed`,
`groupIds`, `boundElements`, `link`, `locked`) passes through unvalidated — omit
what the editor needs and the drawing renders wrong.

### Z-order is `index`, not array order

The server sorts elements by `index` as **plain strings**; an element with a
missing or `null` index sorts **after** every indexed element, ties broken by
`id`. Array order survives only until the first realtime edit, then the scene is
rewritten in index order. So set `index` on every element you write.

- New scene: assign zero-padded, fixed-width indices back-to-front —
  `"a000"`, `"a001"`, … Size the width to the element count (fixed width
  matters: `"a10"` sorts _before_ `"a9"`, and `"a100"` before `"a99"`).
- Appending to an existing scene: take the largest existing index and append
  characters — after `"a5"` use `"a51"`, `"a52"`, … A string with another string
  as its prefix always sorts after it.
- Do not parse or imitate the editor's own index format; only compare strings.

### Versioning is how your edit wins

- New element: `version: 1`, `versionNonce`: a random positive 32-bit int.
- Changed element: `version` strictly greater than the value you read, and a
  fresh `versionNonce`.
- Merge rule: higher `version` wins; on a tie the **lower** `versionNonce` wins,
  then a tombstone, then a JSON fingerprint. The nonce is not protection — the
  version bump is. Always bump.
- Concurrent edits to the _same_ element are last-write-wins. Whoever bumped
  higher wins; the other side's change is lost.

### Deleting is a tombstone

Keep the element in the array, set `"isDeleted": true`, and bump `version`.
Dropping the element from the array only removes it from storage — a live
editor's pending copy re-adds it on the next sync.

### Arrows and labels

Bind both ends and mirror the binding on the shapes:

```json
{
  "type": "arrow",
  "id": "arrow1",
  "index": "a04",
  "x": 300,
  "y": 145,
  "width": 120,
  "height": 0,
  "points": [
    [0, 0],
    [120, 0]
  ],
  "startBinding": { "elementId": "boxA", "focus": 0, "gap": 4 },
  "endBinding": { "elementId": "boxB", "focus": 0, "gap": 4 },
  "startArrowhead": null,
  "endArrowhead": "arrow",
  "version": 1,
  "versionNonce": 481920377,
  "isDeleted": false,
  "strokeColor": "#1e1e1e",
  "backgroundColor": "transparent",
  "fillStyle": "solid",
  "strokeWidth": 2,
  "strokeStyle": "solid",
  "roughness": 0,
  "opacity": 100,
  "angle": 0,
  "seed": 331201,
  "groupIds": [],
  "boundElements": null,
  "link": null,
  "locked": false
}
```

Each bound shape carries the reciprocal entry:
`"boundElements": [{ "id": "arrow1", "type": "arrow" }]`.

Bindings do not move geometry — the arrow's `x`/`y`/`points` must already reach
from one shape's edge to the other's, or it renders detached.

**Labels are separate free text elements, not container text.** Center them
yourself:

```
width  ≈ 0.6 × fontSize × characters       height ≈ 1.25 × fontSize
x = shape.x + (shape.width  - width)  / 2
y = shape.y + (shape.height - height) / 2
```

with `"textAlign": "center"`, `"verticalAlign": "middle"`, `"containerId": null`,
`"fontFamily": 3`, `"fontSize": 16`, `"lineHeight": 1.25`, and `originalText`
equal to `text`. Text elements need their own `index` — put labels after their
shapes so they draw on top.

### Layout defaults that read well

`roughness: 0`, `opacity: 100`, `strokeWidth: 2`, rounded boxes
(`"roundness": {"type": 3}`), boxes around 180×90 with 80–120px gaps, flow left
to right or top to bottom. Keep the palette small and consistent.

### Limits

50,000 elements per scene; 10 MiB of scene JSON (`413 SCENE_TOO_LARGE`); title
120 characters.

## Finish

After every save:

1. `GET` the content again. Confirm the revision advanced and the elements you
   wrote are present, indexed, and not `isDeleted`.
2. Give the user the drawing URL: `$OPEN_EXCALIDRAW_URL/drawings/$ID` — plus the
   share URL if they asked for one.
3. If they have the drawing open, say it updates live; no reload needed.

If a save went wrong, recover from revision history rather than patching over it.
