#!/usr/bin/env bash
# Runs the end-to-end demo story against a running server.
# Usage: scripts/smoke.sh [base-url]   (default http://localhost:3100)
set -euo pipefail
cd "$(dirname "$0")/.."
exec node scripts/smoke.mjs "${1:-http://localhost:3100}"
