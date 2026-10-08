#!/usr/bin/env bash
# One-step install: dependencies, .env, production build.
set -euo pipefail
cd "$(dirname "$0")/.."

node -e 'const [a,b]=process.versions.node.split(".").map(Number); if (a<22||(a===22&&b<13)) { console.error("Node.js 22.13 or newer is required (found "+process.versions.node+")"); process.exit(1) }'

npm ci
[ -f .env ] || { cp .env.example .env; echo "Created .env from .env.example — add your PayPal sandbox credentials."; }
npm run build
echo "Installed. Start with: scripts/start.sh"
