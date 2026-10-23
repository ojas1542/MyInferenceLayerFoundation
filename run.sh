#!/bin/bash
# Starts the personal agent stack: Postgres, Redis, Prometheus and Grafana in
# Docker, both llama-server workers, the inference layer, the Gmail and
# iMessage services when configured, and the agent itself. Each service logs
# to .logs/<name>.log. Ctrl-C stops everything. Run ./install.sh first.
set -euo pipefail

# Under Rosetta, Homebrew and llama.cpp would run as x86_64, so re-run
# natively.
if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = 1 ]; then
  exec arch -arm64 /bin/bash "$0" "$@"
fi

ROOT="$(cd "$(dirname "$0")" && pwd)"
AGENT="$ROOT/personal-agent"
LOGS="$ROOT/.logs"
BREW=/opt/homebrew/bin/brew

step() { printf '\033[1;34m==>\033[0m %s\n' "$1"; }
fail() { printf '\033[1;31merror:\033[0m %s\n' "$1" >&2; exit 1; }

[ -x "$BREW" ] || fail "Homebrew not found; run ./install.sh first"
eval "$("$BREW" shellenv)"
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"

[ -f "$AGENT/.env" ] || fail "personal-agent/.env is missing; run ./install.sh"
for model in Qwen3.5-9B-Q4_K_M.gguf Qwen3-Embedding-0.6B-Q8_0.gguf; do
  [ -f "$ROOT/$model" ] || fail "$model is missing; run ./install.sh"
done
docker info >/dev/null 2>&1 || fail "Docker is not running; open Docker Desktop"

# Reads one key from the agent's .env without sourcing it.
env_value() {
  sed -n "s/^$1=//p" "$AGENT/.env" | tail -1
}

# Fails early when a port is taken, usually by a copy of the stack that is
# still running, instead of letting a service start against the wrong peer.
check_port() {
  local pid
  pid="$(lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
  if [ -n "$pid" ]; then
    fail "port $1 is in use by PID $pid ($(ps -o comm= -p "$pid")).
Stop it first, for example: kill $pid"
  fi
}

# name:pid of every service started, for the monitor loop and shutdown.
SERVICES=""
LOG_TAIL=""
# Job control puts each service in its own process group, so stopping one
# also stops the processes it spawned, such as pnpm's node children.
set -m

stop_all() {
  trap '' INT TERM
  trap - EXIT
  [ -n "$SERVICES" ] || return 0
  echo
  step "Stopping"
  for service in $SERVICES; do
    kill -TERM -- "-${service#*:}" 2>/dev/null || true
  done
  [ -z "$LOG_TAIL" ] || kill "$LOG_TAIL" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap stop_all INT TERM EXIT

# start <name> <port> <command...> runs a service in the background.
start() {
  local name="$1" port="$2"
  shift 2
  check_port "$port"
  "$@" >"$LOGS/$name.log" 2>&1 &
  SERVICES="$SERVICES $name:$!"
}

# wait_for <name> <url> <seconds> waits until the url answers. Any HTTP
# status counts unless the url is a health check, which must return 200.
wait_for() {
  local name="$1" url="$2" deadline=$((SECONDS + $3)) code pid
  pid="$(echo "$SERVICES" | tr ' ' '\n' | sed -n "s/^$name://p")"
  while :; do
    code="$(curl -s -o /dev/null -w '%{http_code}' "$url" || true)"
    case "$url" in
      */health | */healthz) [ "$code" = 200 ] && return ;;
      *) [ "$code" != 000 ] && return ;;
    esac
    if ! kill -0 "$pid" 2>/dev/null; then
      tail -20 "$LOGS/$name.log" >&2
      fail "$name exited; full log in .logs/$name.log"
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      fail "$name did not come up in $3s; see .logs/$name.log"
    fi
    sleep 1
  done
}

mkdir -p "$LOGS"
for port in 8080 8081 9000 3200; do
  check_port "$port"
done

step "Postgres, Redis, Prometheus and Grafana"
docker compose -f "$AGENT/compose.local.yaml" up -d --wait --quiet-pull
docker compose -f "$ROOT/compose.yaml" up -d --wait --quiet-pull

step "Model workers"
# The chat window must match what the agent believes it has.
CONTEXT="$(env_value INFERENCE_CONTEXT_TOKENS)"
CONTEXT="${CONTEXT:-32768}"
start chat 8080 llama-server -m "$ROOT/Qwen3.5-9B-Q4_K_M.gguf" -ngl 99 \
  --jinja --port 8080 -c "$CONTEXT" -fa on -ctk q8_0 -ctv q8_0 -ub 2048 \
  --metrics --temp 1.0 --top-p 0.95 --top-k 20 --min-p 0 \
  --presence-penalty 1.5
start embed 8081 llama-server -m "$ROOT/Qwen3-Embedding-0.6B-Q8_0.gguf" \
  --embeddings --pooling last -ngl 99 -c 8192 -b 8192 -ub 8192 --port 8081
wait_for chat http://127.0.0.1:8080/health 300
wait_for embed http://127.0.0.1:8081/health 120

step "Inference layer"
(cd "$ROOT" && go build -o bin/inferencelayer .)
start inference 9000 \
  env REDIS_URL=redis://127.0.0.1:6379 "$ROOT/bin/inferencelayer"
wait_for inference http://127.0.0.1:9000/healthz 30

if [ -n "$(env_value GOOGLE_CLIENT_ID)" ] &&
  [ -f "$ROOT/gmail-mcp/.data/token.json" ]; then
  step "Gmail MCP server"
  start gmail 3202 npm --prefix "$ROOT/gmail-mcp" start
  wait_for gmail http://127.0.0.1:3202/mcp 30
else
  step "Gmail skipped: not set up (see README step 7)"
fi

if [ -n "$(env_value IMESSAGE_PROJECT_ID)" ]; then
  step "iMessage bridge"
  start imessage 3201 npm --prefix "$ROOT/imessage-bridge" start
  wait_for imessage http://127.0.0.1:3201/ 30
else
  step "iMessage skipped: IMESSAGE_PROJECT_ID is not set"
fi

step "Agent"
start agent 3200 env PORT=3200 corepack pnpm --dir "$AGENT" dev
wait_for agent http://localhost:3200/ 300

cat <<EOF

  Agent      http://localhost:3200
  Grafana    http://localhost:3001
  Logs       .logs/<service>.log

Showing the agent log. Press Ctrl-C to stop everything.

EOF
tail -n 0 -F "$LOGS/agent.log" &
LOG_TAIL=$!

# Stop everything as soon as any service dies, so a half-running stack never
# looks healthy.
while sleep 2; do
  for service in $SERVICES; do
    if ! kill -0 "${service#*:}" 2>/dev/null; then
      name="${service%%:*}"
      tail -20 "$LOGS/$name.log" >&2
      fail "$name exited; full log in .logs/$name.log"
    fi
  done
done
