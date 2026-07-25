#!/bin/bash
# Shared launcher logic for the Delivery Operations Dashboard (macOS / Linux).
#
# This file is SOURCED by:
#   - start.command  (double-click launcher for macOS Finder)
#   - run.sh         (command-line launcher)
# It is not meant to be executed directly; doing so is a harmless no-op because
# it only defines functions (nothing runs at source time except resolving paths).
#
# Provides two functions:
#   preflight_checks  -> verify required config (.env) exists; returns non-zero if not
#   launch_dashboard  -> free stale ports, start backend + frontend, print URLs, wait
#
# Keep the two thin wrappers (start.command / run.sh) in sync by editing ONLY
# this file for shared behavior.

# Absolute repo root = the directory containing THIS file, resolved even when the
# caller sourced it from a different working directory. Every path below is built
# from REPO_ROOT so the scripts work no matter where they are launched from.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Kill any process LISTENing on the given TCP port. macOS/BSD-safe: PIDs are
# captured into a variable (instead of piping lsof into xargs) so an empty result
# never errors, and `|| true` keeps `set -e` from aborting when nothing matches.
free_port() {
  local port="$1"
  local pids
  pids="$(lsof -t -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    echo "  Port $port already in use -> killing stale listener(s): $(echo "$pids" | tr '\n' ' ')"
    # Intentional word-splitting: $pids may contain several PIDs (one per line).
    # shellcheck disable=SC2086
    kill -9 $pids 2>/dev/null || true
  else
    echo "  Port $port is free."
  fi
}

# Pre-flight configuration checks. Returns non-zero (without exiting) so callers
# can decide whether to pause (double-click) or just exit (CLI).
preflight_checks() {
  echo "=== Delivery Operations Dashboard ==="
  if [ ! -f "$REPO_ROOT/.env" ]; then
    cp "$REPO_ROOT/.env.example" "$REPO_ROOT/.env"
    echo "[ok] Created .env in synthetic demo mode."
  fi
  if [ ! -f "$REPO_ROOT/users.json" ]; then
    cp "$REPO_ROOT/users.json.example" "$REPO_ROOT/users.json"
    echo "[ok] Created local demo login accounts."
  fi
  return 0
}

# Stop both child servers. Reset the trap first so it only runs once, and guard
# every reference so it is safe under `set -u` even if a PID was never assigned.
_launch_cleanup() {
  trap - INT TERM HUP EXIT
  echo ""
  echo "Shutting down dashboard..."
  if [ -n "${BACKEND_PID:-}" ]; then kill "$BACKEND_PID" 2>/dev/null || true; fi
  if [ -n "${FRONTEND_PID:-}" ]; then kill "$FRONTEND_PID" 2>/dev/null || true; fi
}

# Free ports, start backend (uvicorn :8000) and frontend (Vite :5173) in the
# background, print URLs, then wait. Closing the window / Ctrl+C stops both.
launch_dashboard() {
  # --- free stale ports first (avoids the "address already in use" hang) -----
  echo "Checking ports..."
  free_port 8000
  free_port 5173

  # --- backend (FastAPI / uvicorn) ------------------------------------------
  echo "[1/2] Starting backend (FastAPI on :8000)..."
  cd "$REPO_ROOT/backend"
  if [ ! -d venv ]; then
    echo "  First run: creating backend/venv and installing requirements..."
    python3 -m venv venv
    # shellcheck disable=SC1091
    source venv/bin/activate
    pip install -r requirements.txt
  else
    # shellcheck disable=SC1091
    source venv/bin/activate
  fi
  uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload &
  BACKEND_PID=$!
  cd "$REPO_ROOT"

  # --- frontend (Vite) ------------------------------------------------------
  echo "[2/2] Starting frontend (Vite on :5173)..."
  cd "$REPO_ROOT/frontend"
  if [ ! -d node_modules ]; then
    echo "  First run: installing frontend deps (npm install)..."
    npm install
  fi
  npm run dev &
  FRONTEND_PID=$!
  cd "$REPO_ROOT"

  # Open the dashboard once Vite is ready. This runs in the background so the
  # normal launcher remains responsible for the two server processes.
  (
    attempt=0
    while [ "$attempt" -lt 60 ]; do
      if curl -fsS "http://127.0.0.1:5173" >/dev/null 2>&1; then
        if command -v open >/dev/null 2>&1; then
          open "http://127.0.0.1:5173"
        elif command -v xdg-open >/dev/null 2>&1; then
          xdg-open "http://127.0.0.1:5173" >/dev/null 2>&1
        fi
        break
      fi
      attempt=$((attempt + 1))
      sleep 1
    done
  ) &

  # --- stop both servers on exit / Ctrl+C / window close --------------------
  # Trap HUP too so closing the Terminal window also stops the servers.
  trap _launch_cleanup INT TERM HUP EXIT

  echo ""
  echo "Dashboard running:"
  echo "  Frontend:  http://localhost:5173"
  echo "  Backend:   http://localhost:8000"
  echo "  API docs:  http://localhost:8000/docs"
  echo "  Demo login: demo / delivery-demo"
  echo ""
  echo "Press Ctrl+C (or close this window) to stop both servers."

  # Block until a child exits or a signal fires; cleanup runs via the trap.
  wait
}
