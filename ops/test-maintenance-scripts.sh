#!/bin/sh
set -eu

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
fixture=$(mktemp -d "${TMPDIR:-/tmp}/open-excalidraw-ops-test.XXXXXX")
cleanup() { rm -rf "$fixture"; }
trap cleanup EXIT HUP INT TERM
mkdir -p "$fixture/bin" "$fixture/assets"
printf '%s\n' true >"$fixture/state"
printf '%s\n' asset-bytes >"$fixture/assets/example.bin"

cat >"$fixture/bin/docker" <<'MOCK'
#!/bin/sh
set -eu

if [ "${1:-} ${2:-}" = "compose version" ]; then exit 0; fi
if [ "${1:-}" = compose ]; then
  shift
  case "$*" in
    "ps --status running -q postgres") echo postgres-container ;;
    "ps -aq app") echo app-container ;;
    "stop "*" app") printf '%s\n' false >"$MOCK_STATE" ;;
    "up "*)
      printf '%s\n' true >"$MOCK_STATE"
      [ "${MOCK_FAIL_READY:-false}" != true ] || exit 1
      ;;
    "exec -T postgres pg_dump "*) printf 'mock-database-dump\n' ;;
    *) : ;;
  esac
  exit 0
fi
if [ "${1:-}" = inspect ]; then
  template=${3:-}
  container=${4:-}
  case "$template" in
    *State.Running*) cat "$MOCK_STATE" ;;
    *State.ExitCode*) echo "${MOCK_APP_EXIT_CODE:-0}" ;;
    *Mounts*) echo mock-asset-volume ;;
    *Config.Image*) echo open-excalidraw:test ;;
    *Config.Labels*) echo "${MOCK_PROJECT:-alpha}" ;;
    *Config.Env*)
      if [ "$container" = postgres-container ]; then
        echo POSTGRES_DB=open_excalidraw
        echo POSTGRES_USER=open_excalidraw
      else
        echo DATABASE_URL="${MOCK_DATABASE_URL:-postgresql://open_excalidraw:password@postgres:5432/open_excalidraw}"
        echo STORAGE_DRIVER=local
      fi
      ;;
  esac
  exit 0
fi
if [ "${1:-}" = kill ]; then
  printf '%s\n' false >"$MOCK_STATE"
  exit 0
fi
if [ "${1:-}" = run ]; then
  case "$*" in
    *--interactive*) dd of=/dev/null 2>/dev/null ;;
    *) tar -C "$MOCK_ASSET_DIR" -czf - . ;;
  esac
  exit 0
fi
echo "Unexpected docker invocation: $*" >&2
exit 1
MOCK
chmod +x "$fixture/bin/docker"

run_with_mocks() {
  PATH="$fixture/bin:$PATH"
  MOCK_ASSET_DIR=$fixture/assets
  MOCK_STATE=$fixture/state
  TMPDIR=$fixture
  MOCK_APP_EXIT_CODE=${MOCK_APP_EXIT_CODE:-}
  MOCK_DATABASE_URL=${MOCK_DATABASE_URL:-}
  MOCK_FAIL_READY=${MOCK_FAIL_READY:-}
  export PATH MOCK_ASSET_DIR MOCK_STATE TMPDIR MOCK_APP_EXIT_CODE MOCK_DATABASE_URL MOCK_FAIL_READY
  "$@"
}

run_with_mocks "$repository_root/ops/backup.sh" "$fixture/backup"
test ! -e "$fixture/backup/.INCOMPLETE"
(cd "$fixture/backup" && shasum -a 256 -c SHA256SUMS >/dev/null)
run_with_mocks "$repository_root/ops/restore.sh" \
  --confirm-destroy-data "$fixture/backup"
test "$(cat "$fixture/state")" = true
test ! -e "$fixture/open-excalidraw-maintenance-alpha.lock"

printf '%s\n' true >"$fixture/state"
if MOCK_APP_EXIT_CODE=137 run_with_mocks \
  "$repository_root/ops/backup.sh" "$fixture/bad-drain" >/dev/null 2>&1; then
  echo "backup unexpectedly accepted an ungraceful app stop" >&2
  exit 1
fi
unset MOCK_APP_EXIT_CODE
test ! -e "$fixture/bad-drain"
test "$(cat "$fixture/state")" = true

printf '%s\n' true >"$fixture/state"
if MOCK_DATABASE_URL=postgresql://wrong:password@postgres:5432/wrong run_with_mocks \
  "$repository_root/ops/backup.sh" "$fixture/wrong-database" >/dev/null 2>&1; then
  echo "backup unexpectedly accepted a mismatched app database identity" >&2
  exit 1
fi
unset MOCK_DATABASE_URL
test ! -e "$fixture/wrong-database"

lock="$fixture/open-excalidraw-maintenance-alpha.lock"
mkdir "$lock"
if run_with_mocks "$repository_root/ops/backup.sh" "$fixture/locked" >/dev/null 2>&1; then
  echo "backup unexpectedly ignored the deployment maintenance lock" >&2
  exit 1
fi
test -d "$lock"
rmdir "$lock"

printf '%s\n' true >"$fixture/state"
if MOCK_FAIL_READY=true run_with_mocks "$repository_root/ops/restore.sh" \
  --confirm-destroy-data "$fixture/backup" >/dev/null 2>&1; then
  echo "restore unexpectedly accepted an app that never became ready" >&2
  exit 1
fi
test "$(cat "$fixture/state")" = false

printf '%s\n' "maintenance script checks passed"
