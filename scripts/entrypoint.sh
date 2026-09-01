#!/bin/sh
set -e

DUMP="${SCHEMA_DUMP_PATH:-/app/data/schemaorg-current-https.jsonld}"

# The schema.org vocabulary dump (~1.5 MB) is cached on the data volume.
# Fetch it on first start / after a volume wipe, and refresh it on deploy
# once it is older than 30 days. A failed refresh keeps the cached copy.
if [ ! -f "$DUMP" ]; then
  echo "[entrypoint] schema dump not found — fetching from schema.org …"
  pnpm run fetch:schema
elif [ -n "$(find "$DUMP" -mtime +30 2>/dev/null)" ]; then
  echo "[entrypoint] schema dump older than 30 days — refreshing …"
  pnpm run fetch:schema || echo "[entrypoint] refresh failed — keeping cached dump"
fi

exec pnpm web
