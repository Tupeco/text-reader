#!/usr/bin/env bash
# Sets up a fresh checkout and runs the end-to-end test against the production build.
# Needs Node 22+ and ~4 GB of free RAM. Downloads ~230 MB of models and a headless Chromium.
# Usage: test/run-e2e.sh   (from the repository root)
set -euo pipefail

npm ci
npx playwright-core install chromium
npm run assets
npm test
npm run build

if curl -sf http://localhost:4173/ > /dev/null; then
  echo "Port 4173 is already serving something (a leftover preview server?). Stop it and rerun." >&2
  exit 1
fi
node_modules/.bin/vite preview --port 4173 --strictPort > /tmp/card-reader-preview.log 2>&1 &
preview=$!
# vite is started directly (not via npx) so $preview is the server itself; cleanup never changes the exit code.
trap 'kill $preview 2>/dev/null; true' EXIT
for _ in $(seq 30); do curl -sf http://localhost:4173/ > /dev/null && break; sleep 1; done
if ! kill -0 $preview 2>/dev/null; then
  cat /tmp/card-reader-preview.log >&2
  exit 1
fi

node test/e2e.mjs http://localhost:4173
