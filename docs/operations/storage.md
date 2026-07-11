# Asset storage

The current release implements `STORAGE_DRIVER=local`. Binary assets live in
the `asset-data` Docker volume at `/data/assets`; PostgreSQL stores metadata and
references, not the asset bytes themselves. Keep the volume private and back it
up together with PostgreSQL as described in
[Backup and restore](backup-restore.md).

## Capacity and permissions

Monitor both the Docker data filesystem and backup destination. A full asset
volume prevents new uploads even when PostgreSQL has space. The application
runs as non-root UID/GID `10001`; preserve ownership and readable modes when
moving data manually. Do not expose the asset directory through Caddy or a
public file server—authorization is enforced by application routes.

## S3-compatible storage is a later adapter

S3 is not implemented or supported in this release. Setting
`STORAGE_DRIVER=s3` does not enable object storage.

The code isolates storage behind the `ObjectStorage` contract, which is the future
migration boundary: put/get/delete, private-object authorization, content
metadata, and deterministic keys must behave the same for local and S3-backed
implementations. A production S3 release also needs contract tests against an
S3-compatible service, private buckets, encryption, lifecycle rules, retry and
multipart behavior, and backup/restore documentation.

A future migration must be an explicit, restartable copy-and-verify job:

1. Back up PostgreSQL and local assets.
2. Copy every referenced object to the private bucket without changing keys.
3. Verify size and content hash, recording resumable progress.
4. Run the storage contract and application asset smoke tests.
5. Switch the driver only after verification, retaining the local backup for a
   documented rollback window.

Do not point an existing deployment at object storage or delete the local
volume based solely on the presence of the interface.
