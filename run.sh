#!/bin/bash
# run.sh - command-line launcher for the Delivery Operations Dashboard.
#
# Same behavior as double-clicking start.command (start backend :8000 +
# frontend :5173, auto-free stale ports, create venv / install deps on first
# run, Ctrl+C stops both) minus the double-click "press Enter to close" pause.
# Shared logic lives in launch_common.sh.
set -euo pipefail

# cd to this script's own directory so it works from any working directory.
cd "$(dirname "$0")"

# shellcheck source=launch_common.sh
source "./launch_common.sh"

# Under `set -e`, a failed pre-flight (missing .env) aborts with a non-zero exit,
# preserving run.sh's original "error out if .env is missing" contract.
preflight_checks
launch_dashboard
