#!/bin/bash
# Verifies the defensive fix lint-staged could apply in getSpawnedTask.
#
# Same wedge setup as verify-tinyexec.sh: tinyexec calling a child that
# spawns a stdio-inheriting grandchild. But the consumer races the
# iterator against the child's `exit` event and force-destroys stdout/
# stderr after a short grace window, which unwedges combineStreams via
# its `.catch(maybeEmitEnd)` path.
#
# Expected: iterator completes in <2 seconds with the child's output
# line captured. No lint-staged-side hang.
set -uo pipefail

cd "$(dirname "$0")/.."

cleanup() {
  pkill -KILL -f 'setTimeout.*1000.*60.*60' 2>/dev/null || true
}
trap cleanup EXIT

OUT=$(mktemp)
node probes/lint-staged-fix-demo.mjs >"$OUT" 2>&1
EC=$?

echo "exit_code=$EC"
echo "---full output---"
cat "$OUT"
echo "---"

if [ "$EC" -eq 0 ] && grep -q '\[fix\] PASS:' "$OUT"; then
  echo "PASS: defensive fix unwedges the iterator while capturing output"
  exit 0
fi
echo "FAIL: fix probe failed (exit=$EC)"
exit 1
