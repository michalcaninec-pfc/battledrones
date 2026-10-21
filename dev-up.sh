#!/usr/bin/env bash
# Start the Vite dev server detached, so it outlives the terminal / agent session.
# Usage: ./dev-up.sh [port]   (default 8150). No-op if the port is already listening.
set -euo pipefail
PORT="${1:-8150}"
DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="/tmp/battledrones-$PORT.log"

if lsof -iTCP:"$PORT" -sTCP:LISTEN -nP >/dev/null 2>&1; then
  echo "already running: http://localhost:$PORT/"
  exit 0
fi

cd "$DIR"
nohup npx vite --port "$PORT" --strictPort --host 127.0.0.1 </dev/null >"$LOG" 2>&1 &
disown
for _ in $(seq 1 40); do
  if lsof -iTCP:"$PORT" -sTCP:LISTEN -nP >/dev/null 2>&1; then
    echo "started: http://localhost:$PORT/  (log: $LOG)"
    exit 0
  fi
  sleep 0.25
done
echo "server did not come up, see $LOG" >&2
exit 1
