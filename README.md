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
parser was the production trigger. But anything that does
`child_process.spawn(..., {stdio: 'inherit'})` inside an eslint
rule/parser/formatter has the same effect — and the production stack
clearly contained one.
