#!/usr/bin/env bash
# The compose check: the whole stack from a clean checkout on a machine with only Docker, as research IT would run it.
#   scripts/compose-check.sh [--keep]
#  1. builds the images and brings the stack up (compose.yaml + compose.check.yaml, project aliquot-check)
#  2. compiles and publishes the lab0 handbook with the kb command, asks the web door a pre-registered question
#     and requires an answer citing the expected entry, an intact hash chain and a stored answer that decrypts
#  3. reads a LaTeX PDF and a Word PDF with the kb command through the sandbox container, and requires a scanned
#     page to fail with the no-OCR message
#  4. backs up, wipes the database volume, brings the stack up empty, restores, and requires the same run again
# Every step prints PASS or FAIL. --keep leaves the stack running for a look; otherwise it is removed at the end.
set -euo pipefail
cd "$(dirname "$0")/.."
keep="${1:-}"
work="$(mktemp -d)"
export COMPOSE_PROJECT_NAME=aliquot-check COMPOSE_FILE="compose.yaml:compose.check.yaml:compose.sandbox.yaml" ALIQUOT_ENV="$work/check.env"
export ALIQUOT_CHECK_CONFIG="$work/config"
compose=(docker compose --env-file "$ALIQUOT_ENV")
web=http://127.0.0.1:3000

pass() { echo "PASS $*"; }
fail() { echo "FAIL $*" >&2; exit 1; }
cleanup() {
  local code=$?
  if [[ $code -ne 0 ]]; then "${compose[@]}" logs --no-color --tail 40 worker web studio 2>&1 | cut -c1-240 >&2 || true; fi
  if [[ "$keep" == "--keep" ]]; then
    echo "kept: the stack (project $COMPOSE_PROJECT_NAME) and $work, which holds its env file and config"
  else
    "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
    rm -rf "$work"
  fi
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
sandbox_image="$(docker build -q -t aliquot-sandbox sandbox)"
mkdir -p "$work/config"
cp deploy/check/* test/pdf-fixtures/latex.pdf test/pdf-fixtures/nist-cswp-27.pdf test/pdf-fixtures/scanned.pdf "$work/config/"
printf '\n[sandbox]\nimage = "%s"\n' "$sandbox_image" >> "$work/config/lab.toml"
echo "DOCKER_GID=$(docker run --rm -v /var/run/docker.sock:/s --entrypoint stat aliquot-app:0.5.1 -c %g /s)" >> "$ALIQUOT_ENV"
"${compose[@]}" up -d --no-build --wait || fail "the stack did not come up healthy"
pass "stack up: $("${compose[@]}" ps --format '{{.Service}}={{.Health}}{{if not .Health}}{{.State}}{{end}}' | sort | tr '\n' ' ')"

# The last JSON line the kb command printed, or its last line of any kind, so a refusal reaches the FAIL message.
kb() { local out; out="$("${compose[@]}" exec -T worker aliquot-kb "$@" 2>&1 || true)"; { grep '^{' <<<"$out" || grep -v Warning <<<"$out"; } | tail -1; }
compiled="$(kb compile --definition /app/fixtures/lab0/kb.json --wait --timeout-ms 120000)"
snapshot="$(printf '%s' "$compiled" | sed -n 's/.*"snapshot":"\([0-9a-f]\{64\}\)".*/\1/p')"
[[ -n "$snapshot" ]] || fail "kb compile: $compiled"
[[ "$(kb publish --snapshot "$snapshot")" == '{"ok":true}' ]] || fail "kb publish $snapshot"
pass "lab0 handbook compiled and published as snapshot ${snapshot:0:12}"

pdf="$(kb compile --definition /etc/aliquot/kb-pdf.json --wait --timeout-ms 120000)"
pdf_snapshot="$(printf '%s' "$pdf" | sed -n 's/.*"snapshot":"\([0-9a-f]\{64\}\)".*/\1/p')"
[[ -n "$pdf_snapshot" ]] || fail "kb compile of the LaTeX and Word PDFs: $pdf"
for term in "café" "satellite"; do
  hit="$(kb search --snapshot "$pdf_snapshot" --query "$term" --k 1)"
  [[ "$hit" == *'"path"'* ]] || fail "no entry of the PDF snapshot matches $term: $hit"
done
pass "the kb command read latex.pdf and nist-cswp-27.pdf in the sandbox container (sandbox ${sandbox_image:7:12}); search finds café and satellite"
scan="$(kb compile --definition /etc/aliquot/kb-scan.json --wait)"
[[ "$scan" == "scanned.pdf: page 1 is a scanned image with no text. Aliquot does not do OCR."* ]] || scan=""
[[ -n "$scan" ]] || fail "a scanned page did not fail with the no-OCR message"
pass "the scanned page fails: $scan"

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
