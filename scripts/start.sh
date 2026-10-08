#!/usr/bin/env bash
# Starts the app on http://localhost:3100/intentchain
set -euo pipefail
cd "$(dirname "$0")/.."
[ -d .next ] || npm run build
exec npm run start
