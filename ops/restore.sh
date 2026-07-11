#!/bin/sh
set -eu

usage() {
  echo "Usage: $0 --confirm-destroy-data BACKUP_DIRECTORY" >&2
  echo "This replaces the current PostgreSQL database and local asset volume." >&2
  exit 64
}

[ "$#" -eq 2 ] || usage
[ "$1" = "--confirm-destroy-data" ] || usage
backup=$2

if [ -e "$backup/.INCOMPLETE" ]; then
  echo "Refusing an incomplete backup" >&2
  exit 65
fi

for required in MANIFEST SHA256SUMS database.dump assets.tar.gz; do
  if [ ! -f "$backup/$required" ]; then
    echo "Backup is missing $required" >&2
    exit 66
  fi
done

if docker compose version >/dev/null 2>&1; then
  compose() { docker compose "$@"; }
elif command -v docker-compose >/dev/null 2>&1; then
  compose() { docker-compose "$@"; }
else
  echo "Docker Compose is required" >&2
  exit 69
fi

verify_hashes() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -c SHA256SUMS
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 -c SHA256SUMS
  else
    echo "sha256sum or shasum is required" >&2
    return 69
  fi
}

if ! grep -qx 'OPEN_EXCALIDRAW_BACKUP_VERSION=1' "$backup/MANIFEST"; then
  echo "Unsupported or invalid backup manifest" >&2
  exit 65
fi

checksum_files=$(awk 'NF == 2 { print $2 }' "$backup/SHA256SUMS")
expected_checksum_files=$(printf '%s\n' database.dump assets.tar.gz MANIFEST)
if [ "$checksum_files" != "$expected_checksum_files" ]; then
  echo "SHA256SUMS must contain exactly the three expected backup files" >&2
  exit 65
fi

echo "Verifying backup checksums..."
(cd "$backup" && verify_hashes)

# Refuse obvious path traversal before giving the trusted archive to tar.
if tar -tzf "$backup/assets.tar.gz" | awk -F/ '
  /^\// { bad = 1 }
  { for (i = 1; i <= NF; i++) if ($i == "..") bad = 1 }
  END { exit bad ? 0 : 1 }
'; then
  echo "Asset archive contains an unsafe path" >&2
  exit 65
fi

validate_identifier() {
  case "$2" in
    "" | *[!A-Za-z0-9_]*)
      echo "$1 may contain only letters, digits, and underscores" >&2
      exit 65
      ;;
  esac
}
manifest_value() {
  value=$(sed -n "s/^$1=//p" "$backup/MANIFEST")
  if [ -z "$value" ] || [ "$(grep -c "^$1=" "$backup/MANIFEST")" -ne 1 ]; then
    echo "Backup manifest must contain exactly one $1 field" >&2
    exit 65
  fi
  printf '%s\n' "$value"
}

manifest_database=$(manifest_value DATABASE)
manifest_database_user=$(manifest_value DATABASE_USER)
validate_identifier MANIFEST_DATABASE "$manifest_database"
validate_identifier MANIFEST_DATABASE_USER "$manifest_database_user"

lock_directory=
lock_acquired=false
destructive_started=false
restore_verified=false
cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$destructive_started" = true ] && [ "$restore_verified" != true ]; then
    compose stop -t "${RESTORE_STOP_TIMEOUT_SECONDS:-30}" app >/dev/null 2>&1 ||
      docker kill "${app_id:-}" >/dev/null 2>&1 || true
  fi
  if [ "$lock_acquired" = true ]; then
    rmdir "$lock_directory" 2>/dev/null || true
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

postgres_id=$(compose ps --status running -q postgres | head -n 1)
if [ -z "$postgres_id" ]; then
  echo "The bundled PostgreSQL service must be running for this restore script." >&2
  exit 69
fi

app_id=$(compose ps -aq app | head -n 1)
if [ -z "$app_id" ]; then
  echo "The application container has not been created; run 'docker compose create app' first." >&2
  exit 69
fi

container_environment() {
  docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$1" |
    sed -n "s/^$2=//p"
}

database=$(container_environment "$postgres_id" POSTGRES_DB)
database_user=$(container_environment "$postgres_id" POSTGRES_USER)
validate_identifier POSTGRES_DB "$database"
validate_identifier POSTGRES_USER "$database_user"
if [ "$database" != "$manifest_database" ] || [ "$database_user" != "$manifest_database_user" ]; then
  echo "Backup database identity does not match the target bundled PostgreSQL service." >&2
  exit 65
fi

app_database_url=$(container_environment "$app_id" DATABASE_URL)
database_authority=${app_database_url#*://}
database_authority=${database_authority%%/*}
database_host_port=${database_authority##*@}
database_host=${database_host_port%%:*}
if [ "$database_host" != postgres ]; then
  echo "Refusing bundled restore: the app is not configured for the bundled PostgreSQL host." >&2
  exit 69
fi
database_user_info=${database_authority%@*}
if [ "$database_user_info" = "$database_authority" ]; then
  echo "The bundled app DATABASE_URL must include its database user." >&2
  exit 65
fi
app_database_user=${database_user_info%%:*}
app_database_path=${app_database_url#*://}
app_database_path=${app_database_path#*/}
app_database=${app_database_path%%\?*}
app_database=${app_database%%\#*}
validate_identifier DATABASE_URL_USER "$app_database_user"
validate_identifier DATABASE_URL_DATABASE "$app_database"
if [ "$app_database_user" != "$database_user" ] || [ "$app_database" != "$database" ]; then
  echo "The app DATABASE_URL does not match the target bundled PostgreSQL database identity." >&2
  exit 65
fi

storage_driver=$(container_environment "$app_id" STORAGE_DRIVER)
if [ "$storage_driver" != local ]; then
  echo "This restore script supports STORAGE_DRIVER=local only." >&2
  exit 69
fi

deployment=$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' "$app_id")
case "$deployment" in
  "" | *[!A-Za-z0-9_.-]*)
    echo "Could not derive a safe Compose project identity for the maintenance lock." >&2
    exit 65
    ;;
esac
lock_directory=${TMPDIR:-/tmp}/open-excalidraw-maintenance-${deployment}.lock
if ! mkdir -m 700 "$lock_directory" 2>/dev/null; then
  echo "Another backup or restore for Compose project '$deployment' appears to be running: $lock_directory" >&2
  exit 75
fi
lock_acquired=true

asset_volume=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data/assets"}}{{.Name}}{{end}}{{end}}' "$app_id")
if [ -z "$asset_volume" ]; then
  echo "Could not locate the named local-asset volume mounted at /data/assets." >&2
  exit 69
fi

echo "Stopping the application..."
compose stop -t "${RESTORE_STOP_TIMEOUT_SECONDS:-30}" app >/dev/null
if [ "$(docker inspect --format '{{.State.Running}}' "$app_id")" = true ]; then
  echo "The application is still running; refusing destructive restore." >&2
  exit 70
fi
destructive_started=true

echo "Restoring local assets..."
docker run --rm --network none --interactive \
  --volume "$asset_volume:/target" \
  postgres:17.6-alpine \
  sh -ec 'find /target -mindepth 1 -maxdepth 1 -exec rm -rf -- {} \; && tar -xzf - -C /target' \
  <"$backup/assets.tar.gz"

echo "Recreating and restoring PostgreSQL database..."
compose exec -T postgres psql \
  --username "$database_user" \
  --dbname postgres \
  --set ON_ERROR_STOP=1 \
  --command "DROP DATABASE IF EXISTS \"$database\" WITH (FORCE);" \
  --command "CREATE DATABASE \"$database\" OWNER \"$database_user\";"

compose exec -T postgres pg_restore \
  --username "$database_user" \
  --dbname "$database" \
  --no-owner \
  --no-privileges <"$backup/database.dump"

echo "Starting the application and applying any forward migrations..."
if ! compose up -d --wait --wait-timeout "${RESTORE_READY_TIMEOUT_SECONDS:-120}" app >/dev/null; then
  compose stop -t "${RESTORE_STOP_TIMEOUT_SECONDS:-30}" app >/dev/null || docker kill "$app_id" >/dev/null || true
  if [ "$(docker inspect --format '{{.State.Running}}' "$app_id")" = true ]; then
    echo "CRITICAL: the restored application did not become ready and could not be stopped." >&2
  else
    echo "The restored application did not become ready and has been stopped." >&2
  fi
  exit 70
fi
restore_verified=true

echo "Restore completed. Check /health/ready, then verify login, drawings, and assets."
echo "If any restore command fails, leave the application stopped and rerun the complete restore."
