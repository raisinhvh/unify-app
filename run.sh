#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d node_modules ]; then
  echo "Installing Unify dependencies..."
  npm install
fi

exec node scripts/dev.mjs
