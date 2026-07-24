# API automation with personal access tokens

Personal access tokens (PATs) give scripts and integrations non-interactive
access to the REST API without a browser session. A token authenticates the same
routes a signed-in user can call, scoped to that user's own data.

## Creating a token

Open **Settings → Personal access tokens** in the web app, choose a name and an
optional expiry (1–365 days, or never), and create it. The full secret —
`oepat_` followed by 43 characters — is shown **once**. Copy it immediately; the
server only stores its SHA-256 hash and can never display it again. The list
afterward shows just the name, last four characters, creation time, optional
expiry, and a coarse last-used timestamp.

Each account may hold at most **25 tokens**; creating a 26th fails with
`TOKEN_LIMIT_REACHED`.

## Using a token

Send it as a bearer token on any REST request:

```bash
curl https://draw.example.com/api/v1/drawings \
  -H "Authorization: Bearer oepat_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
```

Every versioned REST route under `/api/v1` accepts the header and resolves the
caller from the token instead of the session cookie. Because automation clients
send no `Origin`, they are exempt from the browser same-origin check.

When a bearer token is present the server never falls back to a session cookie:
an invalid, expired, or revoked token is rejected with `401` even if a valid
session cookie is sent alongside it.

## Revoking and expiry

Delete a token from the same settings page to revoke it immediately; the next
request using it gets `401`. A token past its expiry, or one belonging to a
disabled account, is likewise rejected. Revocation and creation are recorded in
the audit log (event types `token.created` and `token.revoked`) with only the
token id and name — never the secret or its hash.

## Limits

Tokens are for REST automation only. They deliberately **cannot**:

- manage tokens — listing, creating, or revoking tokens requires a signed-in
  session, so a leaked token cannot mint more (`403
TOKEN_MANAGEMENT_REQUIRES_SESSION`); and
- open realtime collaboration sessions — the Socket.IO handshake rejects token
  identities (`REALTIME_REQUIRES_SESSION`). Live editing, presence, and chat
  sending stay session-only.
