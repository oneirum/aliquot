#!/usr/bin/env bash
# Back up an Aliquot compose stack: the Postgres database (records, knowledge bases, the studio) and every payload key.
#   scripts/backup.sh [dir]        default: backups/<UTC time>
# Writes <dir>/labh.dump (pg_dump custom format), <dir>/payload-key (one ENV=value line per key, mode 0600),
# <dir>/key-ids (one "id ENV" line per key) and SHA256SUMS.
# The keys are every key lab.toml's [store] names that .env holds, as `aliquot keys env` in the worker lists them. A key
# that still holds bodies but is missing from .env stops the backup, because those bodies could not be read after a
# restore. The dump holds payloads encrypted under those keys and is useless without them. Store the keys apart from
# the dump: anyone holding both can read every stored question and answer.
# Honours COMPOSE_PROJECT_NAME, COMPOSE_FILE and ALIQUOT_ENV (the env file, default .env) like docker compose does.
set -euo pipefail
cd "$(dirname "$0")/.."
env_file="${ALIQUOT_ENV:-.env}"
dir="${1:-backups/$(date -u +%Y%m%dT%H%M%SZ)}"
compose=(docker compose --env-file "$env_file")

[[ -e "$dir/labh.dump" ]] && { echo "backup: $dir already holds a backup" >&2; exit 2; }
listed="$("${compose[@]}" exec -T worker aliquot keys env)" || { echo "backup: could not list the payload keys (aliquot keys env in the worker)" >&2; exit 2; }

carried=()
while read -r id env bodies; do
  [[ -n "$id" ]] || continue
  value=""
  [[ "$env" == "-" ]] || value="$(sed -n "s/^${env}=//p" "$env_file" | tail -1)"
  if [[ "$value" =~ ^[0-9a-fA-F]{64}$ ]]; then
    carried+=("$id $env $value")
  elif (( bodies > 0 )); then
    if [[ "$env" == "-" ]]; then echo "backup: key $id holds $bodies bodies, but lab.toml no longer names it" >&2
    else echo "backup: key $id holds $bodies bodies, but $env_file has no $env of 64 hex characters" >&2; fi
    exit 2
  fi
done <<< "$listed"
(( ${#carried[@]} )) || { echo "backup: $env_file holds none of the payload keys lab.toml names" >&2; exit 2; }

mkdir -p "$dir"
"${compose[@]}" exec -T postgres pg_dump -U postgres -d labh --format=custom > "$dir/labh.dump.partial"
mv "$dir/labh.dump.partial" "$dir/labh.dump"
(
  umask 077
  for line in "${carried[@]}"; do read -r id env value <<< "$line"; printf '%s=%s\n' "$env" "$value"; done > "$dir/payload-key"
  for line in "${carried[@]}"; do read -r id env value <<< "$line"; printf '%s %s\n' "$id" "$env"; done > "$dir/key-ids"
)
(cd "$dir" && sha256sum labh.dump payload-key key-ids > SHA256SUMS 2>/dev/null || shasum -a 256 labh.dump payload-key key-ids > SHA256SUMS)
ids="$(for line in "${carried[@]}"; do printf '%s ' "${line%% *}"; done)"
echo "backup: $dir ($(wc -c < "$dir/labh.dump" | tr -d ' ') byte dump, keys ${ids% }). Move $dir/payload-key somewhere other than the dump."
