#!/usr/bin/env bash
# The compose check: the whole stack from a clean checkout on a machine with only Docker, as research IT would run it.
#   scripts/compose-check.sh [--keep]
#  1. builds the images and brings the stack up (compose.yaml + compose.check.yaml, project aliquot-check)
#  2. compiles and publishes the lab0 handbook with the kb command, asks the web door a pre-registered question
#     and requires an answer citing the expected entry, an intact hash chain and a stored answer that decrypts
#  3. backs up, wipes the database volume, brings the stack up empty, restores, and requires the same run again
# Every step prints PASS or FAIL. --keep leaves the stack running for a look; otherwise it is removed at the end.
set -euo pipefail
cd "$(dirname "$0")/.."
keep="${1:-}"
work="$(mktemp -d)"
export COMPOSE_PROJECT_NAME=aliquot-check COMPOSE_FILE="compose.yaml:compose.check.yaml" ALIQUOT_ENV="$work/check.env"
compose=(docker compose --env-file "$ALIQUOT_ENV")
web=http://127.0.0.1:3000

pass() { echo "PASS $*"; }
fail() { echo "FAIL $*" >&2; exit 1; }
cleanup() {
  local code=$?
  if [[ $code -ne 0 ]]; then "${compose[@]}" logs --no-color --tail 40 worker web studio 2>&1 | cut -c1-240 >&2 || true; fi
  [[ "$keep" == "--keep" ]] || "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$work"
  exit $code
}
trap cleanup EXIT

hex() { od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }
{
  echo "POSTGRES_PASSWORD=$(hex 16)"
  echo "LABH_PAYLOAD_KEY=$(hex 32)"
  echo "PAYLOAD_SECRET=$(hex 24)"
  echo "LABH_WEB_PORT=${LABH_WEB_PORT:-3000}"
  echo "LABH_STUDIO_PORT=${LABH_STUDIO_PORT:-3001}"
} > "$ALIQUOT_ENV"

"${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
"${compose[@]}" build --quiet worker
"${compose[@]}" up -d --no-build --wait || fail "the stack did not come up healthy"
pass "stack up: $("${compose[@]}" ps --format '{{.Service}}={{.Health}}{{if not .Health}}{{.State}}{{end}}' | sort | tr '\n' ' ')"

kb() { "${compose[@]}" exec -T worker aliquot-kb "$@" 2>/dev/null | grep '^{' | tail -1; }
compiled="$(kb compile --definition /app/fixtures/lab0/kb.json --wait --timeout-ms 120000)"
snapshot="$(printf '%s' "$compiled" | sed -n 's/.*"snapshot":"\([0-9a-f]\{64\}\)".*/\1/p')"
[[ -n "$snapshot" ]] || fail "kb compile: $compiled"
[[ "$(kb publish --snapshot "$snapshot")" == '{"ok":true}' ]] || fail "kb publish $snapshot"
pass "lab0 handbook compiled and published as snapshot ${snapshot:0:12}"

ask() { local mode="$1"; shift; "${compose[@]}" exec -T web node --disable-warning=ExperimentalWarning scripts/compose-ask.ts "$mode" "$web" "$@"; }
# Assigned before pass, never inside its arguments, so a failed step stops the script instead of printing PASS.
run="$(ask ask | tail -1)" || fail "ask: $run"
out="$(ask verify "$run" | tail -1)" || fail "verify $run: $out"
pass "$out"

"${compose[@]}" exec -T studio node -e "fetch('http://127.0.0.1:3001/admin/login').then(r => process.exit(r.status === 200 ? 0 : 1), () => process.exit(1))" || fail "studio /admin/login"
pass "studio answers /admin/login on its production build"

scripts/backup.sh "$work/backup" >/dev/null || fail "backup"
pass "backup: $(wc -c < "$work/backup/labh.dump" | tr -d ' ') byte dump and the payload key"

"${compose[@]}" down -v >/dev/null 2>&1
"${compose[@]}" up -d --no-build --wait >/dev/null 2>&1 || fail "the wiped stack did not come up"
if ask verify "$run" >/dev/null 2>&1; then fail "run $run is still there after the volume was wiped"; fi
pass "wiped: the database volume was removed and run ${run:0:8} is gone"

printf 'LABH_PAYLOAD_KEY=%s\n' "$(hex 32)" > "$work/wrong-key"
if scripts/restore.sh "$work/backup" "$work/wrong-key" >/dev/null 2>&1; then fail "restore accepted a key the backup was not made with"; fi
pass "restore refuses a payload key that is not the backup's"

scripts/restore.sh "$work/backup" > "$work/restore.log" 2>&1 || { cat "$work/restore.log" >&2; fail "restore"; }
grep -q "$run" "$work/restore.log" || fail "aliquot runs after restore does not list $run"
pass "restored: aliquot runs checked $(grep -c ' intact$' "$work/restore.log") run chain(s), all intact"
out="$(ask verify "$run" | tail -1)" || fail "verify $run after restore: $out"
pass "$out (after restore)"

echo "compose check passed"
