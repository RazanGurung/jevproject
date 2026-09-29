#!/bin/bash
# PEZ$ Trading Terminal - Go Backend Launcher
# Double-click to start

set -u

cd "$(dirname "$0")" || exit 1
clear

export PORT="${PORT:-5001}"
SERVER_BIN="./hyperliquid-server"
ROOT_DIR="$(pwd -P)"
PID_FILE="$ROOT_DIR/.pez-server.pid"
SERVER_PID=""

echo "╔══════════════════════════════════════════════════╗"
echo "║       PEZ$ Trading Terminal - Go Backend         ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

is_numeric_pid() {
  case "${1:-}" in
    ''|*[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

is_owned_server_pid() {
  local pid="${1:-}"
  local command=""
  local cwd=""

  is_numeric_pid "$pid" || return 1
  kill -0 "$pid" 2>/dev/null || return 1

  command="$(ps -p "$pid" -o command= 2>/dev/null)"
  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)"
  [ "$cwd" = "$ROOT_DIR" ] || return 1

  case "$command" in
    "$ROOT_DIR/hyperliquid-server"*|"./hyperliquid-server"*) return 0 ;;
    *) return 1 ;;
  esac
}

stop_owned_server() {
  local pid="$1"

  echo "Stopping existing PEZ server (pid $pid)..."
  kill -TERM "$pid" 2>/dev/null || true
  # Snapshot save on SIGTERM can take several seconds (50MB+ gzip). Killing
  # at 2s drops the movers/watchlist history just warmed this session.
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.5
  done
  if is_owned_server_pid "$pid"; then
    echo "PEZ server did not stop within 15s; forcing shutdown..."
    kill -KILL "$pid" 2>/dev/null || true
  fi
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM HUP
  if [ -n "$SERVER_PID" ] && is_owned_server_pid "$SERVER_PID"; then
    echo ""
    echo "Stopping PEZ server..."
    kill -TERM "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [ -f "$PID_FILE" ] && [ "$(sed -n '1p' "$PID_FILE" 2>/dev/null)" = "$SERVER_PID" ]; then
    rm -f "$PID_FILE"
  fi
  exit "$status"
}

# Restart only a server previously launched by this exact checkout. A stale or
# foreign PID file is discarded; an unrelated process is never signaled.
if [ -f "$PID_FILE" ]; then
  RECORDED_PID="$(sed -n '1p' "$PID_FILE" 2>/dev/null)"
  if is_owned_server_pid "$RECORDED_PID"; then
    stop_owned_server "$RECORDED_PID"
  else
    echo "Removing stale PEZ pid file."
  fi
  rm -f "$PID_FILE"
fi

PORT_PIDS="$(lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null)"
if [ -n "$PORT_PIDS" ]; then
  echo "❌ Port $PORT is already in use by a process this launcher does not own."
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true
  echo "Stop that process or launch PEZ with another PORT value."
  if [ -t 0 ]; then
    echo "Press any key to exit..."
    read -n 1
  fi
  exit 1
fi

# Build the bundled frontend and the vendor-only Go server together. The server
# prefers web/dist when present, so a Go-only build could otherwise serve stale
# browser code.
echo "Starting server..."
echo "Building production release..."
if ! make release; then
  echo "❌ Build failed! Check errors above."
  if [ -t 0 ]; then
    echo "Press any key to exit..."
    read -n 1
  fi
  exit 1
fi
echo "✓ Build successful"

echo "Starting server on http://127.0.0.1:$PORT"
echo "Press Ctrl+C to stop"
echo ""

trap cleanup EXIT INT TERM HUP
"$SERVER_BIN" &
SERVER_PID=$!
printf '%s\n' "$SERVER_PID" > "$PID_FILE"

# Wait for full server readiness. /healthz reports only process liveness while
# /readyz remains unavailable until the retained candle snapshot is restored and
# every selectable market's default chart dependencies have been verified. A
# first run against an older snapshot can legitimately exceed two minutes;
# process liveness, not an arbitrary wall-clock timeout, is the failure signal.
echo "Waiting for full server readiness (warming chart histories)..."
i=0
while true; do
  if curl -fsS "http://127.0.0.1:$PORT/readyz" > /dev/null 2>&1; then
    echo "✓ Server fully ready"
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "❌ Server exited during startup!"
    exit 1
  fi
  i=$((i + 1))
  if [ $((i % 20)) -eq 0 ]; then
    if curl -fsS "http://127.0.0.1:$PORT/healthz" > /dev/null 2>&1; then
      echo "Server is live; still warming chart histories before opening the browser..."
    else
      echo "Still waiting for server liveness..."
    fi
  fi
  sleep 0.5
done

if ! curl -fsS "http://127.0.0.1:$PORT/readyz" > /dev/null 2>&1; then
  echo "❌ Server lost readiness before browser launch!"
  exit 1
fi

open "http://127.0.0.1:$PORT"

echo "✓ Browser opened"
echo "✓ Keep this window open while trading"

wait "$SERVER_PID"
