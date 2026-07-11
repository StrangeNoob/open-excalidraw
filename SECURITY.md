# Security policy

## Supported versions

Until the first stable release, security fixes are made on the current default
branch only. Operators should deploy pinned release tags once releases exist
and should keep PostgreSQL, the reverse proxy, and the host operating system
patched.

## Reporting a vulnerability

Do not open a public issue for suspected vulnerabilities. Use GitHub's private
security-advisory workflow for this repository. Include the affected version,
deployment shape, reproduction steps, impact, and any suggested mitigation.
Avoid including real session cookies, invitation tokens, drawings, or personal
data.

The maintainers will acknowledge a complete report, validate it, prepare a fix
and coordinated disclosure, and credit the reporter when requested. If private
security advisories are unavailable before the repository is published, share
the report privately with the repository owner instead of posting it publicly.

Authentication bypasses, owner/editor/viewer authorization failures, invitation
token disclosure, cross-tenant asset access, revision corruption, and post-
revocation collaboration access are considered high-priority reports.
