# MRE: lint-staged wedge from grandchild pipe inheritance

Deterministic reproduction of the wedge in
[lint-staged/lint-staged#1800](https://github.com/lint-staged/lint-staged/issues/1800):

> lint-staged hangs indefinitely on `eslint --cache --fix`. The eslint
> process runs and exits, but the async iterator in `getSpawnedTask`
> never completes because stdout/stderr pipes stay open.

The reporter named `tsserver` as the grandchild that holds the pipes open.
This MRE shows the mechanism is plugin-agnostic — *any* unref-less spawn
inside eslint reproduces the same hang — and isolates the bug to
lint-staged's `getSpawnedTask` blocking on stream EOF without falling
back to the child's `exit` event.

## Layered diagnosis

The MRE reproduces the wedge at four layers, plus a control and a
working fix demonstration. Each runs in its own CI scenario.

| Scenario | What it shows | Script |
|----------|---------------|--------|
| `matrix` | Bare-Node root cause: `child_process.spawn` without `.unref()` keeps the parent alive | `verify-parent-exit-matrix.sh` |
| `tinyexec` | tinyexec's async iterator wedges when the spawned child never exits | `verify-tinyexec.sh` |
| `wedge` | Full chain wedge: husky → pnpm exec → lint-staged → tinyexec → eslint | `verify-wedge.sh` |
| `control` | Same chain without the grandchild-spawning rule completes normally | `verify-control.sh` |
| `fix` | Defensive race against `child.process.exit` unwedges the iterator | `verify-fix.sh` |

```sh
pnpm install
pnpm verify   # runs all five back to back
```

Or one at a time:

```sh
pnpm verify:matrix     # ~10s, no deps needed
pnpm verify:tinyexec   # ~3s
pnpm verify:wedge      # ~25s (timeout-bounded)
pnpm verify:control    # ~10s
pnpm verify:fix        # ~3s
```

## Layer 1 — bare Node root cause

`probes/parent-exit-cases.mjs` spawns a one-hour-sleeping grandchild for
every combination of `{stdio: inherit | ignore | pipe} × {unref | no unref}`.
After spawning, the parent reaches end-of-script. Watch what happens:

```
case|stdio|unref|verdict|expect|ms
A_inherit_no_unref | inherit | false | HUNG    | HUNG   | 1502
B_inherit_unref    | inherit | true  | exited  | exited |  105
C_ignore_no_unref  | ignore  | false | HUNG    | HUNG   | 1502
D_ignore_unref     | ignore  | true  | exited  | exited |   45
E_pipe_no_unref    | pipe    | false | HUNG    | HUNG   | 1500
F_pipe_unref       | pipe    | true  | HUNG    | HUNG   | 1502
```

Three things to notice:

1. **No-unref always hangs**, regardless of stdio mode. The child handle
   keeps the parent's event loop alive until the child exits — which
   never happens, because the grandchild is sleeping for an hour.
2. **Unref releases the loop for `inherit` and `ignore` stdio** — the
   parent exits cleanly. Stdio inheritance has no bearing on whether
   the parent exits.
3. **Unref does NOT release the loop for `pipe` stdio** — Node holds
   the loop for the open pipe handles even after `unref()`.

Translation to the lint-staged stack: when an eslint plugin calls
`child_process.spawn(...)` without `.unref()`, eslint never exits.
tinyexec waits for stdout/stderr EOF, which requires eslint to exit
(among other things). lint-staged waits for tinyexec's iterator,
which waits for the streams to end.

## Layer 2 — tinyexec iterator wedge

`probes/tinyexec-direct.mjs` calls tinyexec directly against a child
that spawns one non-unref'd grandchild and then exits. No husky, no
lint-staged, no eslint, no git.

```sh
timeout 25 pnpm probe:tinyexec ; echo "exit=$?"
pkill -KILL -f 'setTimeout.*1000.*60.*60'
```

Expected output:

```
[parent] spawning child via tinyexec…
[parent] line: child pid=… grandchild pid=…
exit=124
```

The iterator yields the child's one printed line, then never returns
because the grandchild keeps the parent (and therefore tinyexec's read
end of the pipes) alive forever.

The wedge is therefore a property of how tinyexec's async iterator
interacts with un-unref'd grandchildren, not anything specific to
lint-staged or ESLint. lint-staged is where it becomes user-visible
and where a defensive fix has the most leverage.

## Layer 3 — full chain wedge

`verify-wedge.sh` drives a real `git commit` through husky → `pnpm exec
lint-staged` → tinyexec → eslint. The eslint config loads a synthetic
plugin (`eslint-plugin-grandchild.cjs`) that performs the unref-less
spawn from inside an eslint rule.

```sh
pnpm install
echo "// trigger" >> src/hello.ts
git add src/hello.ts
timeout 25 git commit -m wedge
echo "exit=$?"  # expect 124
pkill -KILL -f 'setTimeout.*1000.*60.*60'   # clean up the leaked grandchild
```

Expected output between the trigger line and the timeout:

```
[STARTED] Backing up original state...
[COMPLETED] Backed up original state in git stash (…)
[STARTED] Running tasks for staged files...
[STARTED] lint-staged.config.ts — 1 file
[STARTED] *.ts — 1 file
[STARTED] node node_modules/eslint/bin/eslint.js — fix
```

…and then nothing, until `timeout 25` fires.

## Layer 4 — control (negative case)

`verify-control.sh` runs the exact same chain with one change: the
`grandchild/spawn-grandchild` rule is commented out. The commit
completes in a few seconds. Same lint-staged, same tinyexec, same
eslint, same projectService config; only the grandchild spawn differs.

This rules out everything else as the trigger.

## Layer 5 — fix demonstration

`probes/lint-staged-fix-demo.mjs` runs the same tinyexec call as Layer 2,
but consumes the iterator with a defensive pattern:

1. Subscribe to `result.process.once('exit', …)` — `exit` fires when the
   immediate child terminates, regardless of whether grandchildren still
   hold its stdio FDs.
2. On exit, wait `EXIT_GRACE_MS` (100ms) for trailing buffered output
   to drain.
3. Then `result.process.stdout?.destroy()` and `…stderr?.destroy()`.
   This rejects tinyexec's internal `pipeline(...)` calls, which routes
   through `.catch(maybeEmitEnd)` in `combineStreams` and ends the
   PassThrough merger via `combined.end()`.
4. The async iterator returns naturally with the captured output.

Expected output:

```
[fix] line at +Nms: child pid=… grandchild pid=…
[fix] child exit code=0 signal=null at +Nms
[fix] iterator returned after Nms
[fix] PASS: iterator unwedged in Nms with output captured
```

Typical elapsed: ~150ms instead of ∞.

This is the pattern `lint-staged/lib/getSpawnedTask.js:124` should apply
to its `for await (const line of result)` loop.

## What doesn't help

Common deflections, none of which break the wedge:

- **`--no-stash`**: lint-staged still spawns the eslint task through
  tinyexec and still consumes via the iterator. The hang is in the
  iterator, not in the stash mechanism. `--no-stash` was tried in the
  original report and didn't help.
- **`pnpm exec lint-staged` vs `node node_modules/.bin/lint-staged`**:
  the pnpm exec chain is irrelevant. Bypassing it with a direct node
  invocation in the husky hook leaves the wedge intact.
- **Pinning newer tinyexec**: 1.2.3 added a destroy-on-exit fix that
  introduced a buffer-drain race on Linux (tinylibs/tinyexec#139);
  1.2.4 reverted the fix. The wedge applies to every version because
  the underlying `combineStreams` logic still waits on stream EOF.
- **`--no-verify`** "fixes" the hang only because it skips the hook
  entirely — no lint-staged runs, no tinyexec call, no iterator. Not
  a fix; just an escape hatch.

## Versions pinned by `package.json`

| package                 | version |
| ----------------------- | ------- |
| lint-staged             | 16.4.0  |
| tinyexec (pnpm-workspace override)| 1.1.2 |
| eslint                  | 10.3.0  |
| typescript-eslint       | 8.59.1  |
| typescript              | 6.0.3   |
| husky                   | 9.1.7   |
| node (tested)           | 22, 24, 26 |
| pnpm (tested)           | 10.33.1 |

## Mechanism

`lint-staged/lib/getSpawnedTask.js` consumes the task output with

```js
for await (const line of result) {
  output += line + '\n'
}
```

`result` is a tinyexec `ExecProcess` whose async iterator merges
`_streamOut` and `_streamErr` (the child's piped stdout and stderr) into
a readline interface. The iterator yields lines until both streams hit
EOF *and* the child process closes.

The unref-less grandchild keeps eslint's Node event loop alive. eslint
never exits, so its stdout/stderr never close, so tinyexec's
`combineStreams` PassThrough never ends, so readline never ends, so the
iterator never completes.

`getSpawnedTask` doesn't subscribe to the child's `exit` event to bound
the wait — it relies solely on stream EOF — so there is no timeout and
nothing to break the deadlock except an external signal.

## Why this matters for #1800

The bug is in lint-staged. A consumer with a misbehaving plugin can
wedge the entire commit indefinitely with no error message and no path
to recover except an out-of-band SIGTERM.

Subscribing to the child's `exit` event and bounding the iterator on
the process-exit signal — independently of stream EOF — would break
the deadlock for any grandchild shape. `verify-fix.sh` shows the
pattern working in 150ms.

The MRE uses a synthetic plugin because that's the cleanest way to
force the grandchild. Plausible real-world triggers that would have the
same effect:

- `child_process.exec(cmd, callback)` — the callback form, with no
  `.unref()`, when the caller doesn't care about waiting on the result.
- `child_process.spawn(cmd, args)` with defaults, where the spawner
  assumes "when I exit, the OS will reap it" — which it doesn't, if
  the child is sleeping on a syscall.
- A worker thread with `stdio: 'pipe'` (Node 22+) or a hand-rolled
  worker that doesn't override `process.stdout._writev` the way synckit
  does.
- An LSP probe — a plugin that talks to a language server it spawned
  itself, doesn't kill it on rule completion because the server is
  reusable across files.
- A subprocess attached to a tool like `tsc --watch`, `node --inspect`,
  or a custom transpiler that backgrounds itself.

None of these are confirmed as the production trigger; they're the
patterns that exist in real ESLint extensions. The synthetic plugin in
this MRE is the smallest stand-in for the class.
