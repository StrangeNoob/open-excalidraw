#!/bin/sh
set -eu

usage() {
  echo "Usage: $0 BACKUP_DIRECTORY" >&2
  echo "Creates a new, checksummed PostgreSQL + local-asset backup set." >&2
  exit 64
}

[ "$#" -eq 1 ] || usage

destination=$1
case "$destination" in
  "" | /) usage ;;
esac

if [ -e "$destination" ]; then
  echo "Refusing to overwrite existing path: $destination" >&2
  exit 73
fi

if docker compose version >/dev/null 2>&1; then
  compose() { docker compose "$@"; }
elif command -v docker-compose >/dev/null 2>&1; then
  compose() { docker-compose "$@"; }
else
  echo "Docker Compose is required" >&2
  exit 69
fi

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1"
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1"
  else
    echo "sha256sum or shasum is required" >&2
    return 69
  fi
}

validate_identifier() {
  case "$2" in
    "" | *[!A-Za-z0-9_]*)
      echo "$1 may contain only letters, digits, and underscores" >&2
      exit 65
      ;;
  esac
}

partial=
lock_directory=
lock_acquired=false
app_was_running=false
app_stopped=false

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$app_stopped" = true ] && [ "$app_was_running" = true ]; then
    compose up -d app >/dev/null || true
  fi
  if [ "$status" -ne 0 ] && [ -n "$partial" ]; then
    rm -rf "$partial"
    echo "Backup failed; the incomplete backup was removed." >&2
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

umask 077
parent=$(dirname "$destination")
name=$(basename "$destination")
mkdir -p "$parent"
parent=$(CDPATH= cd -- "$parent" && pwd)
final="$parent/$name"
if ! mkdir "$final"; then
  echo "Refusing to overwrite existing path: $final" >&2
  exit 73
fi
partial=$final
printf '%s\n' 'Backup is incomplete; do not restore it.' >"$partial/.INCOMPLETE"

postgres_id=$(compose ps --status running -q postgres | head -n 1)
if [ -z "$postgres_id" ]; then
  echo "The bundled PostgreSQL service is not running." >&2
  echo "For managed PostgreSQL, use provider-native backups plus an independent pg_dump." >&2
  exit 69
fi

app_id=$(compose ps -aq app | head -n 1)
if [ -z "$app_id" ]; then
  echo "The application container has not been created; run 'docker compose up -d' first." >&2
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

app_database_url=$(container_environment "$app_id" DATABASE_URL)
database_authority=${app_database_url#*://}
database_authority=${database_authority%%/*}
database_host_port=${database_authority##*@}
database_host=${database_host_port%%:*}
if [ "$database_host" != postgres ]; then
  echo "Refusing bundled backup: the app is not configured for the bundled PostgreSQL host." >&2
  echo "Use provider-native backups plus an independent pg_dump for managed PostgreSQL." >&2
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
  echo "The app DATABASE_URL does not match the bundled PostgreSQL database identity." >&2
  exit 65
fi

storage_driver=$(container_environment "$app_id" STORAGE_DRIVER)
if [ "$storage_driver" != local ]; then
  echo "This backup script supports STORAGE_DRIVER=local only." >&2
  exit 69
fi

asset_volume=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data/assets"}}{{.Name}}{{end}}{{end}}' "$app_id")
if [ -z "$asset_volume" ]; then
  echo "Could not locate the named local-asset volume mounted at /data/assets." >&2
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

if [ "$(docker inspect --format '{{.State.Running}}' "$app_id")" = true ]; then
  app_was_running=true
  app_stopped=true
  compose stop -t "${BACKUP_STOP_TIMEOUT_SECONDS:-30}" app >/dev/null
  if [ "$(docker inspect --format '{{.State.Running}}' "$app_id")" = true ]; then
    echo "The application is still running; refusing a non-quiescent backup." >&2
    exit 70
  fi
  app_exit_code=$(docker inspect --format '{{.State.ExitCode}}' "$app_id")
  if [ "$app_exit_code" != 0 ]; then
    echo "The application did not drain gracefully (exit $app_exit_code); refusing backup." >&2
    exit 70
  fi
fi

echo "Dumping PostgreSQL..."
compose exec -T postgres pg_dump \
  --username "$database_user" \
  --dbname "$database" \
  --format=custom \
  --compress=9 \
  --no-owner \
  --no-privileges >"$partial/database.dump"

echo "Archiving local assets..."
docker run --rm --network none \
  --volume "$asset_volume:/source:ro" \
  postgres:17.6-alpine \
  tar -C /source -czf - . >"$partial/assets.tar.gz"

created_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
app_image=$(docker inspect --format '{{.Config.Image}}' "$app_id")
cat >"$partial/MANIFEST" <<EOF
OPEN_EXCALIDRAW_BACKUP_VERSION=1
CREATED_AT=$created_at
DATABASE=$database
DATABASE_USER=$database_user
APP_IMAGE=$app_image
STORAGE_DRIVER=local
EOF

(
  cd "$partial"
  hash_file database.dump >SHA256SUMS
  hash_file assets.tar.gz >>SHA256SUMS
  hash_file MANIFEST >>SHA256SUMS
)

if [ "$app_was_running" = true ]; then
  compose up -d --wait --wait-timeout "${BACKUP_READY_TIMEOUT_SECONDS:-120}" app >/dev/null
fi
app_stopped=false
rm "$partial/.INCOMPLETE"
rmdir "$lock_directory"
lock_acquired=false
trap - EXIT HUP INT TERM

echo "Backup created: $final"
echo "Copy this directory to encrypted, off-host storage and test a restore."
