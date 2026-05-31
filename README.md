# MRE: lint-staged wedge from grandchild pipe inheritance

Deterministic reproduction of the wedge in
[lint-staged/lint-staged#1800](https://github.com/lint-staged/lint-staged/issues/1800):

> lint-staged hangs indefinitely on `eslint --cache --fix`. The eslint
> process runs and exits, but the async iterator in `getSpawnedTask`
> never completes because stdout/stderr pipes stay open.

The reporter named `tsserver` as the grandchild that holds the pipes open.
This MRE shows the mechanism is plugin-agnostic — *any* grandchild that
inherits eslint's stdio reproduces the same hang — and isolates the bug
to lint-staged's `getSpawnedTask` blocking on stream EOF without falling
back to the child's `close` event.

The original report claimed the wedge only reproduced in submodule
checkouts. That was incorrect. The submodule observation was a coincidence
of where the original author was working; the wedge reproduces in any
clone where the husky hook is wired and an ESLint plugin spawns a
stdio-inheriting subprocess.

## Reproducing

```sh
pnpm install
pnpm verify        # runs verify:wedge, verify:control, verify:tinyexec back-to-back
```

`pnpm verify:wedge` is the headline scenario. The bare-hands form:

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
[STARTED] node node_modules/.bin/eslint --cache --fix
```

…and then nothing, until `timeout 25` fires.

## Control

Comment out the rule and the commit completes in a few seconds:

```sh
sed -i.bak 's|"grandchild/spawn-grandchild": "error"|// "grandchild/spawn-grandchild": "error"|' eslint.config.ts
echo "// control" >> src/hello.ts
git add src/hello.ts eslint.config.ts
timeout 25 git commit -m control
```

Same lint-staged, same tinyexec, same eslint, same projectService config;
only the rule that spawns the stdio-inheriting grandchild differs.

## What doesn't help

Common deflections, none of which break the wedge:

- **`--no-stash`**: lint-staged still spawns the eslint task through
  tinyexec and still consumes via the iterator. The hang is in the
  iterator, not in the stash mechanism. `--no-stash` was tried in the
  original report and didn't help.
- **`pnpm exec lint-staged` vs `node node_modules/.bin/lint-staged`**:
  the pnpm exec chain is irrelevant. Bypassing it with a direct node
  invocation in the husky hook leaves the wedge intact. Same for
  switching `lint-staged.config.ts` between `"eslint --cache --fix"`
  and `"node node_modules/.bin/eslint --cache --fix"`.
- **Pinning newer tinyexec**: 1.2.3 added a destroy-on-exit fix that
  introduced a buffer-drain race on Linux (tinylibs/tinyexec#139);
  1.2.4 reverted the fix. The wedge applies to every version. The
  `exitDrainTimeout` branch at
  `github.com/Mearman/tinyexec/tree/fix/buffer-drain-race` resolves
  both, but hasn't been picked up upstream.
- **`--no-verify`** "fixes" the hang only because it skips the hook
  entirely — no lint-staged runs, no tinyexec call, no iterator. Not a
  fix; just an escape hatch.

## Versions pinned by `package.json`

| package                 | version |
| ----------------------- | ------- |
| lint-staged             | 16.4.0  |
| tinyexec (pnpm override)| 1.1.2   |
| eslint                  | 10.3.0  |
| typescript-eslint       | 8.59.1  |
| typescript              | 6.0.3   |
| husky                   | 9.1.7   |
| node (tested)           | 26.1.0  |
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

The grandchild spawned by the plugin is

```js
spawn(process.execPath,
      ['-e', 'setTimeout(() => {}, 1000 * 60 * 60)'],
      {stdio: ['ignore', 'inherit', 'inherit']})
```

so its fds 1 and 2 are dup'd from eslint's fds 1 and 2 — which are
themselves the writable ends of the pipes tinyexec opened. When eslint
exits, the kernel keeps each pipe alive until every writer closes its
end. The grandchild is still a writer. EOF never arrives. The iterator
in `getSpawnedTask` never returns. lint-staged hangs.

`getSpawnedTask` doesn't subscribe to the child's `exit` or `close` event
to bound the wait — it relies solely on stream EOF — so there is no
timeout and nothing to break the deadlock except an external signal.

## Same wedge without lint-staged

`probes/tinyexec-direct.mjs` calls tinyexec directly against a child
that spawns one stdio-inheriting node grandchild and then exits — same
shape as the ESLint plugin in the main reproduction, no lint-staged or
git involved.

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
because the grandchild keeps fds 1 and 2 open. The wedge is therefore a
property of how tinyexec's async iterator interacts with stdio-inheriting
grandchildren, not anything specific to lint-staged or ESLint. lint-staged
is where it becomes user-visible and where a defensive fix has the most
leverage (it owns the "run this task to completion" semantics), but the
mechanism sits one layer below it.

## Why this matters for #1800

The bug is in lint-staged. Same `getSpawnedTask`, same iterator pattern;
the difference between hanging and not hanging is whether some descendant
of eslint kept the pipe open. A consumer with a misbehaving plugin can
wedge the entire commit indefinitely with no error message and no path
to recover except an out-of-band SIGTERM.

Subscribing to `child.close` and bounding the iterator on the
process-closed signal — independently of stream EOF — would break the
deadlock for any grandchild shape.

The MRE uses a synthetic plugin because that's the cleanest way to force
the grandchild; we have not pinned down which real-world plugin or
parser was the production trigger. But anything inside an ESLint
rule, parser, formatter, or transitively-loaded helper that produces a
stdio-inheriting child outlives the parent has the same effect.
Plausible shapes that wouldn't surprise me:

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
patterns I can think of that exist in real ESLint extensions. The
synthetic plugin in this MRE is the smallest stand-in for the class.
