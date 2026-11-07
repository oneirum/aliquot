#!/usr/bin/env bash
# Restore an Aliquot compose stack from scripts/backup.sh output, then check every run record.
#   scripts/restore.sh <dir> [key-file]     key-file default: <dir>/payload-key
# Refuses unless the env file holds every key the backup was made with (<dir>/key-ids, or LABH_PAYLOAD_KEY alone for a
# backup from before key ids), each the same value: restored payloads under a missing key would not decrypt. The
# refusal names the missing key id. On a new machine, put the backup's keys in .env before docker compose up.
# Replaces the labh database. The worker, web door and studio are stopped while it runs and started after.
set -euo pipefail
cd "$(dirname "$0")/.."
env_file="${ALIQUOT_ENV:-.env}"
dir="${1:?usage: scripts/restore.sh <backup dir> [key file]}"
key_file="${2:-$dir/payload-key}"
compose=(docker compose --env-file "$env_file")

[[ -f "$dir/labh.dump" ]] || { echo "restore: no $dir/labh.dump" >&2; exit 2; }
if [[ -f "$dir/SHA256SUMS" && "$key_file" == "$dir/payload-key" ]]; then
  (cd "$dir" && { sha256sum -c --quiet SHA256SUMS 2>/dev/null || shasum -a 256 -c --quiet SHA256SUMS; }) || { echo "restore: $dir fails its SHA256SUMS" >&2; exit 2; }
fi
manifest="k1 LABH_PAYLOAD_KEY"
[[ -f "$dir/key-ids" ]] && manifest="$(cat "$dir/key-ids")"
while read -r id env; do
  [[ -n "$id" ]] || continue
  backup_key="$(sed -n "s/^${env}=//p" "$key_file" | tail -1)"
  live_key="$(sed -n "s/^${env}=//p" "$env_file" | tail -1)"
  [[ "$backup_key" =~ ^[0-9a-fA-F]{64}$ ]] || { echo "restore: $key_file holds no $env for key $id" >&2; exit 2; }
  if [[ "$backup_key" != "$live_key" ]]; then
    echo "restore: key $id is not supplied: $env_file's $env is not the key this backup was made with." >&2
    echo "Set $env=<the value in $key_file> in $env_file, then run this again." >&2
    exit 2
  fi
done <<< "$manifest"

"${compose[@]}" up -d --wait postgres
"${compose[@]}" stop worker web studio
"${compose[@]}" exec -T postgres psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q -c "drop database if exists labh with (force)" -c "create database labh"
"${compose[@]}" exec -T postgres pg_restore -U postgres -d labh --exit-on-error < "$dir/labh.dump"
"${compose[@]}" up -d --wait worker web studio
"${compose[@]}" exec -T worker aliquot runs --limit 1000
