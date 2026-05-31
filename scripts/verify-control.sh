#!/bin/bash
# Disables the grandchild-spawning ESLint rule and confirms the same
# commit completes without hanging. Same lint-staged, same tinyexec,
# same eslint, same projectService config; only the rule differs.
set -uo pipefail

cd "$(dirname "$0")/.."

ORIG_HEAD=$(git rev-parse HEAD)

cleanup() {
  pkill -KILL -f 'setTimeout.*1000.*60.*60' 2>/dev/null || true
  rm -f .git/index.lock eslint.config.ts.bak 2>/dev/null || true
  git stash drop --quiet 2>/dev/null || true
  # If the control commit landed, rewind HEAD without touching unrelated
  # working-tree changes (a previous --hard reset wiped uncommitted edits
  # to scripts/). --soft preserves index + worktree; we then explicitly
  # restore only the two files this script touches.
  if [ "$(git rev-parse HEAD 2>/dev/null)" != "$ORIG_HEAD" ]; then
    git reset --quiet --soft "$ORIG_HEAD" 2>/dev/null || true
  fi
  git reset --quiet HEAD -- src/hello.ts eslint.config.ts 2>/dev/null || true
  git checkout HEAD -- src/hello.ts eslint.config.ts 2>/dev/null || true
}
trap cleanup EXIT

if [ "$(git config --get core.hooksPath || true)" != ".husky/_" ]; then
  echo "FAIL: core.hooksPath is not .husky/_  (did you run pnpm install?)"
  exit 2
fi

# disable the rule (in-place, sed -i.bak for cross-BSD/GNU portability)
sed -i.bak 's|"grandchild/spawn-grandchild": "error"|// "grandchild/spawn-grandchild": "error"|' eslint.config.ts
rm -f eslint.config.ts.bak

echo "// verify-control $(date -u +%s%N)" >> src/hello.ts
git add src/hello.ts eslint.config.ts

OUT=$(mktemp)
( node scripts/timeout.mjs 25 git commit -m "verify-control" ) >"$OUT" 2>&1
EC=$?

echo "exit_code=$EC"
echo "---full output---"
cat "$OUT"
echo "---"

if [ "$EC" -eq 124 ]; then
  echo "FAIL: commit still hung (exit 124) with the rule disabled"
  exit 1
fi

# Any non-timeout exit is acceptable: 0 if eslint passes, non-zero (e.g. 1) if
# the project's own typed rules reject the trigger change. The control is that
# it does not hang.
echo "PASS: commit completed without hanging (exit=$EC)"
exit 0
