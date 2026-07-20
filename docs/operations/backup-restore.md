# Backup and restore

A complete local-storage backup is a consistent pair: a PostgreSQL logical
dump plus the binary asset volume. Backing up only one can leave database
references without bytes, or unreferenced bytes without drawing metadata.

## Create a backup

Run from the release checkout while the bundled PostgreSQL service is healthy:

```sh
./ops/backup.sh /secure-staging/open-excalidraw-$(date -u +%Y%m%dT%H%M%SZ)
```

The script:

1. Atomically reserves a private destination directory, marks it incomplete,
   and refuses to overwrite any existing path.
2. Gracefully stops the app to drain writes and collaboration connections,
   then refuses to dump data unless the app stopped cleanly with exit code 0.
3. Creates `database.dump` using PostgreSQL's custom dump format.
4. Creates `assets.tar.gz` from the named local-asset volume.
5. Writes a versioned `MANIFEST` and `SHA256SUMS`, restarts the app if it was
   running, and removes the incomplete marker only after readiness succeeds.

The brief application outage is intentional: it makes the database and asset
capture one quiescent pair without a distributed snapshot protocol.

The output is not encrypted by the script. Immediately copy the whole
directory to encrypted, access-controlled off-host storage, then remove the
staging copy according to your retention policy. Example tools include an
encrypted restic/borg repository or encrypted provider storage; do not place
credentials in the repository. Keep at least one backup outside the VPS and
monitor scheduled-job failures and storage capacity.

Backup and restore use a Compose-project-scoped maintenance lock under
`${TMPDIR:-/tmp}`. Different deployments can be maintained independently, while
overlapping operations against the same volumes are rejected even when invoked
by different operator accounts sharing that lock directory. If the host kills a
script without allowing cleanup, verify that no backup or restore process
remains before removing the reported stale lock directory.

Example cron entry (adjust path and off-host transfer command):

```cron
17 2 * * * cd /srv/open-excalidraw && ./ops/backup.sh /var/backups/staging/oe-$(date -u +\%Y\%m\%dT\%H\%M\%SZ) && /usr/local/sbin/push-open-excalidraw-backup
```

## Restore

Restore only a trusted, complete backup set. First back up the current state.
Prefer a separate VPS or a separate Compose project for routine restore tests.
For an in-place restore:

```sh
./ops/restore.sh --confirm-destroy-data /secure-staging/open-excalidraw-20260711T020000Z
```

The confirmation flag is mandatory. The script verifies the backup version,
checksums, archive paths, and recorded database user/name against the actual app
and PostgreSQL containers before stopping the app. Shell `POSTGRES_*` defaults
are never used to choose a restore target. It then replaces every asset and
recreates that validated PostgreSQL database before running `pg_restore`.
Finally it starts the app, whose normal entrypoint applies any newer forward
migrations.

The migration ledger travels inside the dump, so the restored database carries
the exact set of applied migrations it had when captured. Restoring an older
dump into the same or a newer release is supported: the entrypoint applies the
remaining forward migrations on startup. Restoring a dump from a newer release
into older code is not — its schema is ahead of the code. A migration checksum
error on startup after restore means the dump came from a deployment whose
migration files differ from this release; restore it into the matching release
instead, and never hand-edit migration files or the ledger to silence the check.

If restore fails or receives a termination signal after replacement begins, its
exit trap stops the application unless readiness already succeeded. Fix the
reported cause and rerun the entire restore from the same backup; do not serve a
partially restored database/asset pair.

After restore, verify:

```sh
curl --fail http://127.0.0.1:3000/health/ready
docker compose logs --tail=200 app
```

Then test login, an owned drawing, a shared viewer/editor drawing, recent
revision history, and at least one embedded image/file byte-for-byte. A backup
is not proven until a restore test succeeds.

## S3 asset storage

The bundled scripts capture the bundled Compose database and the local asset
volume only. When `STORAGE_DRIVER=s3` the drawing bytes live in a bucket instead
(see [object storage](storage.md)), so the volume archive covers nothing.

Take the `pg_dump` the same quiesced way — stop the app to drain writes, then
dump — and capture the bucket in that same maintenance window with provider
tooling: bucket versioning plus cross-region replication, or a point-in-time
sync such as `rclone sync` or `aws s3 sync` into a separate, private backup
bucket. Restore is `pg_restore` plus restoring the bucket contents from that
same window. Keep the backup bucket private; asset objects are served through
the app, never from a public bucket.

## Managed PostgreSQL boundary

The scripts support the bundled Compose database and local asset volume only.
For managed PostgreSQL, combine provider point-in-time recovery with an
independent `pg_dump`, retain the local asset archive from the same maintenance
window, and document the provider-specific sequence. Never run the bundled
restore script against a managed database URL.

## Portable drawing export

The production image ships `export-drawings.mjs` alongside `migrate-assets.mjs`.
It writes every live drawing to its own portable `.excalidraw` file, inlining
each drawing's live image assets as base64 data URLs so the file opens
standalone in any Excalidraw client. Run it inside the container:

```sh
node export-drawings.mjs --out /tmp/export --dry-run   # list what would export
node export-drawings.mjs --out /tmp/export             # write the files
```

It reads `DATABASE_URL` and the same storage environment the server uses; the
driver comes from `STORAGE_DRIVER` (default `local`). Each file is named
`<slug>-<drawingId>.excalidraw`. Assets missing from storage are logged and
counted, and the drawing is still written without that image. The command
prints an `exported/inlined/missing/failed` summary and exits non-zero when any
drawing failed. `--dry-run` lists the would-be files from the database alone,
reading no asset bytes and writing nothing.

This is a portability and user-level export, not a substitute for the backup
pair above: it carries no users, permissions, revision history, or share links.
