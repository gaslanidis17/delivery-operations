#!/bin/bash
# Portfolio / demo setup — bundled fictional data, no external data sign-in required.
set -e

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO"

echo "=== Delivery Operations (Synthetic Delivery Network demo) — setup ==="
echo ""

pick_python() {
  for c in python3.13 python3.12 python3.11 python3.10 python3; do
    if command -v "$c" >/dev/null 2>&1 \
       && "$c" -c 'import sys; sys.exit(0 if sys.version_info[:2] >= (3,10) else 1)' 2>/dev/null; then
      echo "$c"; return 0
    fi
  done
  return 1
}
if ! PY="$(pick_python)"; then
  echo "ERROR: Python 3.10+ required."
  exit 1
fi
echo "[ok] using $("$PY" --version 2>&1) at $(command -v "$PY")"
echo ""

if [ ! -f .env ]; then
  cp .env.example .env
  echo "[ok] wrote .env (DATA_SOURCE=synthetic)"
else
  echo "[skip] .env already exists"
fi

if [ ! -f users.json ]; then
  if [ -f users.json.example ]; then
    cp users.json.example users.json
    echo "[ok] copied users.json.example → users.json (edit passwords locally)"
  else
    cat > users.json <<'JSON'
{
  "users": [
    { "username": "admin", "password": "CHANGE_ME", "name": "Admin", "role": "admin" },
    { "username": "analyst", "password": "CHANGE_ME", "name": "Analyst", "role": "analyst" }
  ]
}
JSON
    echo "[ok] wrote users.json — set passwords before use"
  fi
else
  echo "[skip] users.json already exists"
fi

if [ ! -d backend/venv ]; then
  echo "[..] backend venv + deps"
  "$PY" -m venv backend/venv
  ./backend/venv/bin/pip install --quiet -r backend/requirements.txt
  echo "[ok] backend/venv ready"
else
  echo "[skip] backend/venv already exists"
fi

if [ ! -d frontend/node_modules ]; then
  echo "[..] npm install"
  (cd frontend && npm install --silent)
  echo "[ok] frontend deps ready"
else
  echo "[skip] frontend/node_modules already exists"
fi

echo ""
echo "=== Setup complete ==="
echo "  ./run.sh          → http://localhost:5173 (login: users.json)"
echo "  Demo data is generated locally; no external system is contacted"
echo ""
echo "Safe to publish: fictional regions/cities, renamed metrics, randomized synthetic data."
