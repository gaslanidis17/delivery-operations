#!/bin/bash
# start.command - double-clickable macOS launcher for the Delivery Analytics
# Dashboard. Double-clicking it in Finder opens Terminal and runs this script.
#
# It starts BOTH halves of the app (backend FastAPI :8000 + frontend Vite :5173),
# auto-freeing stale ports and creating the venv / installing deps on first run.
# Closing this Terminal window (or Ctrl+C) stops both servers.
#
# The shared logic lives in launch_common.sh (also used by run.sh).
set -euo pipefail

# cd to this script's own directory so it works no matter where it is launched
# from (Finder double-click starts in the user's home dir, not the repo).
cd "$(dirname "$0")"

# shellcheck source=launch_common.sh
source "./launch_common.sh"

# If required config is missing, keep the window open so the error is readable
# after a double-click (otherwise Terminal would flash and vanish).
if ! preflight_checks; then
  echo ""
  read -r -p "Press Enter to close this window..." _ || true
  exit 1
fi

launch_dashboard
