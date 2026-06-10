#!/bin/sh
set -e

# Fetch the schema.org vocabulary dump on first start (volume is empty)
# or after a volume wipe. The dump is large (~1.5 MB) so we cache it.
if [ ! -f "${SCHEMA_DUMP_PATH:-/app/data/schemaorg-current-https.jsonld}" ]; then
  echo "[entrypoint] schema dump not found — fetching from schema.org …"
  pnpm run fetch:schema
fi

exec pnpm web
