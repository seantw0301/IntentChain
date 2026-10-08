#!/usr/bin/env bash
# Wipes ALL demo data for every session. Stop the server first.
# (The "Reset demo" button in the UI only clears your own session.)
set -euo pipefail
cd "$(dirname "$0")/.."
DB="${DATABASE_PATH:-./data/intentchain.db}"
rm -f "$DB" "$DB-wal" "$DB-shm"
echo "Removed $DB. A fresh database is created on the next start."
