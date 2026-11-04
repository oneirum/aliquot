#!/usr/bin/env bash
# Back up an Aliquot compose stack: the Postgres database (records, knowledge bases, the studio) and the payload key.
#   scripts/backup.sh [dir]        default: backups/<UTC time>
# Writes <dir>/labh.dump (pg_dump custom format) and <dir>/payload-key (LABH_PAYLOAD_KEY, mode 0600), plus SHA256SUMS.
# The dump holds payloads encrypted under that key and is useless without it. Store the key apart from the dump:
# anyone holding both can read every stored question and answer.
# Honours COMPOSE_PROJECT_NAME, COMPOSE_FILE and ALIQUOT_ENV (the env file, default .env) like docker compose does.
set -euo pipefail
cd "$(dirname "$0")/.."
env_file="${ALIQUOT_ENV:-.env}"
dir="${1:-backups/$(date -u +%Y%m%dT%H%M%SZ)}"

key="$(sed -n 's/^LABH_PAYLOAD_KEY=//p' "$env_file" | tail -1)"
[[ "$key" =~ ^[0-9a-fA-F]{64}$ ]] || { echo "backup: $env_file has no LABH_PAYLOAD_KEY of 64 hex characters" >&2; exit 2; }
[[ -e "$dir/labh.dump" ]] && { echo "backup: $dir already holds a backup" >&2; exit 2; }

mkdir -p "$dir"
docker compose --env-file "$env_file" exec -T postgres pg_dump -U postgres -d labh --format=custom > "$dir/labh.dump.partial"
mv "$dir/labh.dump.partial" "$dir/labh.dump"
(umask 077; printf 'LABH_PAYLOAD_KEY=%s\n' "$key" > "$dir/payload-key")
(cd "$dir" && sha256sum labh.dump payload-key > SHA256SUMS 2>/dev/null || shasum -a 256 labh.dump payload-key > SHA256SUMS)
echo "backup: $dir ($(wc -c < "$dir/labh.dump" | tr -d ' ') byte dump). Move $dir/payload-key somewhere other than the dump."
