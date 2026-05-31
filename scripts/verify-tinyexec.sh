#!/bin/bash
# Runs the tinyexec-direct probe and confirms tinyexec's async iterator
# wedges when the child it spawns leaves behind a stdio-inheriting
# grandchild. No lint-staged, no eslint, no git, no husky involved.
set -uo pipefail

cd "$(dirname "$0")/.."

cleanup() {
  pkill -KILL -f 'setTimeout.*1000.*60.*60' 2>/dev/null || true
}
trap cleanup EXIT

OUT=$(mktemp)
( timeout 25 node probes/tinyexec-direct.mjs ) >"$OUT" 2>&1
EC=$?

LAST=$(tail -1 "$OUT")

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
# The iterator should have yielded the child's "child pid=… grandchild pid=…"
# line and then blocked, so the last printed line is that one.
if ! printf '%s' "$LAST" | grep -qE '^\[parent\] line: child pid=[0-9]+ grandchild pid=[0-9]+$'; then
  echo "FAIL: expected last output line to be the child/grandchild pid line"
  FAIL=1
fi

if [ "$FAIL" -eq 0 ]; then
  echo "PASS: tinyexec wedged on stdio-inheriting grandchild"
  exit 0
fi
exit 1
