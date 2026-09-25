#!/usr/bin/env bash
# Start Smart Book AI for development: Ollama (if it isn't running), the backend API and the
# Vite UI with hot reload. Anything already running is reused; Ctrl+C stops only what this started.
#   ./start.sh        then open http://127.0.0.1:5173
set -euo pipefail
cd "$(dirname "$0")"

API=http://127.0.0.1:${SMARTBOOK_PORT:-8000}
WEB=http://127.0.0.1:${SMARTBOOK_WEB_PORT:-5173}
OLLAMA=http://127.0.0.1:11434
pids=()

up() { curl -s -o /dev/null -m 2 "$1"; }

stop() {
  for pid in "${pids[@]}"; do
    if [[ -r /proc/$pid/winpid ]]; then  # Windows: end the whole tree (uv -> python, npm -> node -> vite)
      taskkill //F //T //PID "$(cat "/proc/$pid/winpid")" >/dev/null 2>&1 || true
    else
      kill "$pid" 2>/dev/null || true
    fi
  done
}
trap stop EXIT
trap 'echo; echo "Stopping..."; exit 130' INT TERM

wait_for() {  # wait_for <name> <url> <pid|-> : poll until the URL answers, bail if the process died
  until up "$2"; do
    if [[ $3 != - ]] && ! kill -0 "$3" 2>/dev/null; then echo "$1 exited - see the output above."; exit 1; fi
    sleep 1
  done
}

if up "$OLLAMA/api/version"; then
  echo "Ollama: already running"
else
  exe=$(command -v ollama || echo "${LOCALAPPDATA:-}/Programs/Ollama/ollama.exe")
  [[ -x $exe ]] || { echo "Ollama not found - install it from https://ollama.com"; exit 1; }
  mkdir -p backend/.data
  echo "Ollama: starting (log: backend/.data/ollama.log)"
  OLLAMA_FLASH_ATTENTION=${OLLAMA_FLASH_ATTENTION:-1} OLLAMA_KV_CACHE_TYPE=${OLLAMA_KV_CACHE_TYPE:-q8_0} \
    "$exe" serve >backend/.data/ollama.log 2>&1 &
  pids+=($!)
  wait_for Ollama "$OLLAMA/api/version" $!
fi

if up "$API/api/health"; then
  echo "Backend: already running at $API"
else
  echo "Backend: starting on $API"
  (cd backend && exec uv run smartbook) &
  pids+=($!)
  api_pid=$!
fi

if up "$WEB"; then
  echo "Frontend: already running at $WEB"
else
  [[ -d frontend/node_modules ]] || (cd frontend && npm install)
  echo "Frontend: starting on $WEB"
  (cd frontend && exec npm run dev) &
  pids+=($!)
  web_pid=$!
fi

wait_for Backend "$API/api/health" "${api_pid:--}"
wait_for Frontend "$WEB" "${web_pid:--}"
echo
echo "Smart Book AI is ready: $WEB   (Ctrl+C to stop)"

if ((${#pids[@]})); then
  wait -n  # if any of our servers stops, stop the rest
  echo "A server stopped - shutting down the others."
else
  echo "Everything was already running; nothing to stop."
fi
