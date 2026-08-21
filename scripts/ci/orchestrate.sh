#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

COMMAND="${1:-}"

case "$COMMAND" in
  secret)
    bash scripts/security/run-gitleaks.sh
    ;;
  env)
    npm run env:check
    ;;
  retirement)
    npm run migration:retirement:check
    ;;
  web)
    npm run test
    npx tsc --noEmit
    npm run build:web
    ;;
  lint)
    npm run lint:ci
    ;;
  smoke)
    npm run smoke:ci
    ;;
  queue)
    npm run migration:retirement:check
    npm run env:check
    npm run lint:ci
    npm run test
    npx tsc --noEmit
    npm run build:web
    npm run smoke:ci
    ;;
  *)
    echo "Usage: bash scripts/ci/orchestrate.sh {secret|env|retirement|web|lint|smoke|queue}"
    exit 1
    ;;
esac
