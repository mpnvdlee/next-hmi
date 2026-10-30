#!/usr/bin/env bash
# Idempotent Playwright setup in a PERSISTENT cache dir, not the scratchpad —
# a scratchpad is session-scoped, so installing there re-downloads on every
# session. This survives, so second and later sessions cost ~0s.
#
#   bash .claude/skills/visual-check/setup.sh
#
# Prints the resolved PW_HOME on stdout (last line) for the caller to reuse.
set -euo pipefail

PW_HOME="${PW_HOME:-$HOME/.cache/nexthmi-visual-check}"

if [ ! -d "$PW_HOME/node_modules/playwright" ]; then
  mkdir -p "$PW_HOME"
  cd "$PW_HOME"
  [ -f package.json ] || npm init -y >/dev/null 2>&1
  npm install playwright >/dev/null 2>&1
fi

# Browser binaries live in ~/Library/Caches/ms-playwright (macOS), shared across
# every PW_HOME. `install` is a no-op once they are present.
cd "$PW_HOME"
npx --yes playwright install chromium >/dev/null 2>&1

echo "$PW_HOME"
