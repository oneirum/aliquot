#!/usr/bin/env bash
# Lays out a lab's Aliquot processes as one tmux session a person can attach to:
# the worker, the web door, the studio when asked, and a shell for `aliquot ask`.
#
#   scripts/tmux.sh [--config lab.toml] [--session aliquot] [--port 3000] [--studio] [--attach]
#   scripts/tmux.sh --stop [--session aliquot]
#
# It reads .env when there is one (DATABASE_URL, LABH_PAYLOAD_KEY, PAYLOAD_SECRET, ALIQUOT_STUDIO_TOKEN) and passes
# only those and LABH_CONFIG into the session. A window whose process exits stays open with
# its last lines, so a crash can be read. ALIQUOT_TMUX_SOCKET names a private tmux server
# (tmux -L) instead of the default one; the tests use it.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
config="lab.toml"
session="aliquot"
port=""
studio=0
attach=0
stop=0
while [ $# -gt 0 ]; do
  case "$1" in
    --config) config="$2"; shift 2 ;;
    --session) session="$2"; shift 2 ;;
    --port) port="$2"; shift 2 ;;
    --studio) studio=1; shift ;;
    --attach) attach=1; shift ;;
    --stop) stop=1; shift ;;
    -h|--help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1 (try --help)" >&2; exit 2 ;;
  esac
done

command -v tmux >/dev/null || { echo "tmux is not installed (brew install tmux, or apt install tmux)" >&2; exit 2; }
tm() { if [ -n "${ALIQUOT_TMUX_SOCKET:-}" ]; then tmux -L "$ALIQUOT_TMUX_SOCKET" "$@"; else tmux "$@"; fi; }

if [ "$stop" = 1 ]; then
  tm kill-session -t "$session" 2>/dev/null && echo "stopped tmux session $session" || echo "no tmux session $session"
  exit 0
fi
if tm has-session -t "=$session" 2>/dev/null; then
  echo "tmux session $session is already running. Attach with: tmux attach -t $session (or stop it with --stop)" >&2
  exit 1
fi

case "$config" in /*) ;; *) config="$PWD/$config" ;; esac
[ -f "$config" ] || { echo "$config does not exist. Write one with pnpm aliquot:init." >&2; exit 2; }
if [ -f "$root/.env" ]; then set -a; . "$root/.env"; set +a; fi
: "${DATABASE_URL:?DATABASE_URL is not set: put it in .env or export it}"

env_args=(-e "DATABASE_URL=$DATABASE_URL" -e "LABH_CONFIG=$config" -e "NODE_NO_WARNINGS=1")
[ -n "${LABH_PAYLOAD_KEY:-}" ] && env_args+=(-e "LABH_PAYLOAD_KEY=$LABH_PAYLOAD_KEY")
[ -n "${PAYLOAD_SECRET:-}" ] && env_args+=(-e "PAYLOAD_SECRET=$PAYLOAD_SECRET")

node_bin="node --disable-warning=ExperimentalWarning --permission '--allow-fs-read=*' --allow-net"
web_port_arg=""
[ -n "$port" ] && web_port_arg="--port $port"
door="http://127.0.0.1:${port:-3000}"

# The session starts on an idle shell so remain-on-exit is set before the worker runs: a worker that fails at once still leaves its lines.
tm new-session -d -s "$session" -n worker -c "$root" -x 200 -y 50 "${env_args[@]}"
tm set-option -t "$session" remain-on-exit on >/dev/null
tm respawn-pane -k -t "$session:worker" -c "$root" "${env_args[@]}" "$node_bin packages/core/bin/worker.ts --config '$config'"
tm new-window -t "$session:" -n web -c "$root" "${env_args[@]}" "$node_bin packages/core/bin/web.ts --config '$config' $web_port_arg"
if [ "$studio" = 1 ]; then
  # The studio holds no payload key, which the tmux server may carry from .env: it reaches core through the door.
  tm new-window -t "$session:" -n studio -c "$root" "${env_args[@]}" "env -u LABH_PAYLOAD_KEY LABH_DOOR_URL='$door' pnpm --filter @labh/studio dev --port 3001"
fi
tm new-window -t "$session:" -n ask -c "$root" "${env_args[@]}" -e "ALIQUOT_DOOR=$door" \
  "echo 'Ask the door at $door:  pnpm aliquot ask --user <member> \"your question\"   (--json for one JSON line per event)'; exec \"\${SHELL:-sh}\""
tm select-window -t "$session:web"

echo "tmux session $session: windows worker, web$([ "$studio" = 1 ] && echo ", studio"), ask"
echo "  attach:  tmux attach -t $session"
echo "  stop:    scripts/tmux.sh --stop --session $session"
if [ "$attach" = 1 ]; then tm attach -t "$session"; fi
