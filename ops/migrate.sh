#!/bin/sh
set -eu

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is required" >&2
  exit 64
fi

container_migrator=/app/packages/database/src/migrate.mjs
if [ -f "$container_migrator" ]; then
  node "$container_migrator"
else
  script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
  repository_root=$(dirname "$script_directory")
  cd "$repository_root"

  if command -v pnpm >/dev/null 2>&1; then
    pnpm --filter @open-excalidraw/database db:migrate
  elif command -v corepack >/dev/null 2>&1; then
    corepack pnpm --filter @open-excalidraw/database db:migrate
  else
    echo "pnpm (or Corepack) is required to run repository migrations" >&2
    exit 69
  fi
fi

if [ "$#" -gt 0 ]; then
  exec "$@"
fi
