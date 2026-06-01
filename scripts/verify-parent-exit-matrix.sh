#!/bin/bash
# Bare-Node demonstration of the wedge's root cause.
#
# For each (stdio, unref) combination, spawn a grandchild that sleeps
# for an hour. Observe whether the parent script exits cleanly or hangs.
#
# Expected outcomes:
#   inherit + no unref → HUNG    (child handle keeps event loop alive)
#   inherit + unref    → exited  (unref releases the loop)
#   ignore  + no unref → HUNG
#   ignore  + unref    → exited
#   pipe    + no unref → HUNG
#   pipe    + unref    → HUNG    (pipe handles also keep the loop alive)
#
# No tinyexec, no lint-staged, no eslint, no git. Just plain Node.
#
# This isolates the wedge's root cause to plain Node spawn semantics:
# any fire-and-forget spawn keeps the parent alive until the child exits,
# which can never happen if the child is sleeping. Inside eslint, this
# means eslint never exits, tinyexec never sees EOF, lint-staged wedges.
set -uo pipefail

cd "$(dirname "$0")/.."

cleanup() {
  pkill -KILL -f 'setTimeout.*1000.*60.*60' 2>/dev/null || true
}
trap cleanup EXIT

OUT=$(mktemp)
node probes/parent-exit-cases.mjs >"$OUT" 2>&1
EC=$?

echo "exit_code=$EC"
echo "---full output---"
cat "$OUT"
echo "---"

if [ "$EC" -eq 0 ] && tail -1 "$OUT" | grep -q "^PASS:"; then
  echo "PASS: parent-exit matrix matches expectations across all 6 cases"
  exit 0
fi
echo "FAIL: parent-exit matrix probe deviated from expectations (exit=$EC)"
exit 1
