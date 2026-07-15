# Asset storage

Binary assets are stored through one of two drivers selected with
`STORAGE_DRIVER`: `local` (the default) keeps bytes in the `asset-data` Docker
volume at `/data/assets`, and `s3` keeps them in any S3-compatible bucket.
PostgreSQL stores metadata and references, not the asset bytes themselves.
With the local driver, keep the volume private and back it up together with
PostgreSQL as described in [Backup and restore](backup-restore.md).

## Capacity and permissions

Monitor both the Docker data filesystem and backup destination. A full asset
volume prevents new uploads even when PostgreSQL has space. The application
runs as non-root UID/GID `10001`; preserve ownership and readable modes when
moving data manually. Do not expose the asset directory through Caddy or a
public file server—authorization is enforced by application routes.

## S3-compatible storage

Set `STORAGE_DRIVER=s3` to store assets in a private S3-compatible bucket
instead of the local volume (`STORAGE_LOCAL_PATH` is then ignored):

| Variable               | Required | Purpose                                            |
| ---------------------- | -------- | -------------------------------------------------- |
| `S3_BUCKET`            | yes      | Bucket name.                                       |
| `S3_ACCESS_KEY_ID`     | yes      | Access key with read/write/delete on the bucket.   |
| `S3_SECRET_ACCESS_KEY` | yes      | Matching secret.                                   |
| `S3_REGION`            | no       | Region (`auto` works for most non-AWS providers).  |
| `S3_ENDPOINT`          | no       | Endpoint URL; omit for AWS S3.                     |
| `S3_FORCE_PATH_STYLE`  | no       | Set `true` for path-style providers such as MinIO. |

`.env.example` lists working endpoint examples for AWS S3, Cloudflare R2,
MinIO, Backblaze B2, DigitalOcean Spaces, and Wasabi. Keep the bucket private:
authorization is enforced by application routes, never by bucket ACLs.

## Migrating between drivers

The production image ships an asset migration CLI that copies every live,
database-referenced asset between drivers and verifies each copy against the
recorded SHA-256. It is safe to re-run after a partial migration; identical
objects are skipped.

```bash
# Inside the server container (or apps/server/dist locally):
node migrate-assets.mjs --from local --to s3 --dry-run
node migrate-assets.mjs --from local --to s3
```

Both sides read the same environment variables the server uses
(`STORAGE_LOCAL_PATH` for local, `S3_*` for s3). The recommended sequence:

1. Back up PostgreSQL and the current asset storage.
2. Run the migration with `--dry-run`, then without, while the old driver is
   still live.
3. Stop the server (or otherwise block uploads) and run the migration once
   more. The asset list is loaded once per run, so this delta pass picks up
   anything uploaded since step 2; it is cheap because identical objects are
   skipped.
4. Do not switch drivers until the final run reports `missing=0 failed=0`.
   Only `failed` produces a non-zero exit code, so check the printed summary,
   not just the exit status. Resolve any missing or failed assets and re-run
   until clean.
5. Switch `STORAGE_DRIVER` and restart the server.
6. Retain the previous storage for a rollback window before deleting it.
