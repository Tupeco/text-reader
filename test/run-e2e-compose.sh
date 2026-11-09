#!/usr/bin/env bash
# End-to-end test of the Docker Compose deployment, including the translation API with a mock DeepL.
# Usage: test/run-e2e-compose.sh   (from the repository root; needs Docker, Node and npm ci done)
set -euo pipefail
export HOST_PORT="${HOST_PORT:-8481}" BASE_PATH="${BASE_PATH:-/reader/}"
compose=(docker compose -p card-reader-e2e -f compose.yaml -f test/compose.test.yaml)
trap '"${compose[@]}" down >/dev/null 2>&1 || true' EXIT
"${compose[@]}" up -d --build
for _ in $(seq 60); do curl -sf "http://localhost:$HOST_PORT${BASE_PATH}api/health" > /dev/null && break; sleep 1; done
echo "engines: $(curl -s "http://localhost:$HOST_PORT${BASE_PATH}api/translate/engines")"
E2E_ONLINE=1 node test/e2e.mjs "http://localhost:$HOST_PORT$BASE_PATH"
