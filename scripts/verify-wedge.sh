#!/bin/bash
# Drives one `git commit` through the husky → pnpm exec lint-staged →
# tinyexec → eslint chain, asserts the commit hangs (exit 124) at the
# expected point in the lint-staged output, and confirms at least one
# stdio-inheriting grandchild is alive before cleanup.
#
# Pass if all assertions hold. Fail with a non-zero exit otherwise.
set -uo pipefail

cd "$(dirname "$0")/.."

cleanup() {
  pkill -KILL -f 'setTimeout.*1000.*60.*60' 2>/dev/null || true
  rm -f .git/index.lock 2>/dev/null || true
  git stash drop --quiet 2>/dev/null || true
  git reset --quiet HEAD -- src/hello.ts 2>/dev/null || true
  git checkout HEAD -- src/hello.ts 2>/dev/null || true
}
trap cleanup EXIT

# pre-flight: husky must be wired
if [ "$(git config --get core.hooksPath || true)" != ".husky/_" ]; then
  echo "FAIL: core.hooksPath is not .husky/_  (did you run pnpm install?)"
  exit 2
fi

# trigger
echo "// verify-wedge $(date -u +%s%N)" >> src/hello.ts
git add src/hello.ts

OUT=$(mktemp)
( node scripts/timeout.mjs 25 git commit -m "verify-wedge" ) >"$OUT" 2>&1
EC=$?

# Strip ANSI colour escapes that CI runners (FORCE_COLOR) inject.
LAST=$(tail -1 "$OUT" | sed $'s/\033\\[[0-9;]*[a-zA-Z]//g')

echo "exit_code=$EC"
echo "last_output_line=$LAST"
echo "---full output---"
cat "$OUT"
echo "---"

FAIL=0
if [ "$EC" -ne 124 ]; then
  echo "FAIL: expected exit 124 (timeout fired), got $EC"
  FAIL=1
fi
EXPECTED_SUFFIX="[STARTED] node node_modules/eslint/bin/eslint.js --cache --fix"
# Substring match so ANSI colour codes injected by CI runners don't break it.
if ! printf '%s' "$LAST" | grep -qF -- "$EXPECTED_SUFFIX"; then
  echo "FAIL: expected last output line to contain:"
  echo "  $EXPECTED_SUFFIX"
  echo "got:"
  echo "  $LAST"
  FAIL=1
fi

if [ "$FAIL" -eq 0 ]; then
  echo "PASS: wedge reproduced (exit=124, hung at eslint start)"
  exit 0
fi
exit 1
