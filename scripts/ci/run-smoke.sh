#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

SMOKE_SUITES=(
  "tests/oauthStart.test.ts"
  "tests/authHost.test.ts"
  "tests/deleteAccountApiRoute.test.ts"
  "tests/publicInvestorProfileApiRoute.test.ts"
  "tests/mainWebRuntime.test.ts"
)

write_smoke_report() {
  local exit_code=$?
  trap - EXIT
  if [ -n "${SMOKE_REPORT_PATH:-}" ]; then
    if ! node -e '
    const fs = require("fs");
    const { dirname } = require("path");
    const path = process.argv[1];
    const exitCode = Number(process.argv[2]);
    const suites = process.argv.slice(3);
    fs.mkdirSync(dirname(path), { recursive: true });
    fs.writeFileSync(
      path,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          suites,
          status: exitCode === 0 ? "passed" : "failed"
        },
        null,
        2
      )
    );
    ' "$SMOKE_REPORT_PATH" "$exit_code" "${SMOKE_SUITES[@]}"; then
      echo "Failed to write smoke report." >&2
      if [ "$exit_code" -eq 0 ]; then
        exit_code=1
      fi
    fi
  fi
  exit "$exit_code"
}
trap write_smoke_report EXIT

# An earlier dependency-install failure must not trigger an unpinned npx download.
if [ ! -f node_modules/vitest/vitest.mjs ]; then
  echo "Smoke dependencies are unavailable; run npm ci first." >&2
  exit 1
fi

echo "Running compact smoke suite..."
npx vitest run "${SMOKE_SUITES[@]}"

# Keep diagnostics truthful when this step runs after an earlier blocking failure.
if [ "${SMOKE_UPSTREAM_STATUS:-success}" != "success" ]; then
  echo "An earlier smoke gate step failed; the gate remains failed." >&2
  exit 1
fi
