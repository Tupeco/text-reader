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

npx vite preview --port 4173 --strictPort > /tmp/card-reader-preview.log 2>&1 &
preview=$!
trap 'kill $preview 2>/dev/null' EXIT
for _ in $(seq 30); do curl -sf http://localhost:4173/ > /dev/null && break; sleep 1; done

node test/e2e.mjs http://localhost:4173
