#!/usr/bin/env bash
# Deploys to the demo host: sync sources, install, build, restart under pm2.
# Usage: DEPLOY_HOST=user@host DEPLOY_PORT=22 DEPLOY_DIR=/path scripts/deploy.sh
# The remote .env is never overwritten; it is created from .env.example once.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${DEPLOY_HOST:?Set DEPLOY_HOST, e.g. user@host}"
: "${DEPLOY_DIR:?Set DEPLOY_DIR, e.g. /var/www/intentchain}"
PORT="${DEPLOY_PORT:-22}"
RUN_AS="${DEPLOY_USER:-www}"

rsync -az --delete \
  -e "ssh -p $PORT" \
  --exclude node_modules --exclude .next --exclude data --exclude .env --exclude .git \
  --exclude docs/internal --exclude video --exclude '*.tsbuildinfo' --exclude .DS_Store \
  ./ "$DEPLOY_HOST:$DEPLOY_DIR/"

ssh -p "$PORT" "$DEPLOY_HOST" "DIR='$DEPLOY_DIR' RUN_AS='$RUN_AS' bash -s" <<'REMOTE'
set -euo pipefail
cd "$DIR"
[ -f .env ] || cp .env.example .env
chmod 600 .env
npm ci --no-audit --no-fund
npm run build
mkdir -p data
chown -R "$RUN_AS":"$RUN_AS" "$DIR"
if pm2 describe intentchain >/dev/null 2>&1; then
  pm2 restart intentchain --update-env
else
  pm2 start npm --name intentchain --uid "$RUN_AS" --gid "$RUN_AS" --cwd "$DIR" -- run start
fi
pm2 save
REMOTE
echo "Deployed to $DEPLOY_HOST:$DEPLOY_DIR"
