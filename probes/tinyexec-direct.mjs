// Reproduces the wedge from lint-staged#1800 with tinyexec called
// directly — no lint-staged, no eslint, no git, no husky.
//
// Matches lint-staged 16.4.0's tinyexec invocation shape exactly:
//   exec(cmd, args, { nodeOptions: { stdio: ['ignore'] } })
// and consumes via the async iterator, the same way
// `lint-staged/lib/getSpawnedTask.js` does:
//   for await (const line of result) { ... }
//
// Shows the wedge is a property of how tinyexec's iterator interacts
// with a stdio-inheriting grandchild, not of anything specific to
// lint-staged or eslint.
//
// Usage:
//   timeout 25 node probes/tinyexec-direct.mjs ; echo "exit=$?"   # → exit=124
//   pkill -KILL -f 'setTimeout.*1000.*60.*60'                     # cleanup

import { exec } from "tinyexec";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const child = resolve(here, "child-spawns-grandchild.mjs");

console.error("[parent] spawning child via tinyexec…");
const started = Date.now();
const result = exec(process.execPath, [child], {
  nodeOptions: { stdio: ["ignore"] },
});

let output = "";
for await (const line of result) {
  output += line + "\n";
  console.error(`[parent] line: ${line}`);
}

const wall = Date.now() - started;
console.error(`[parent] iterator returned after ${wall}ms exit=${result.exitCode}`);
console.error(`[parent] captured output: ${JSON.stringify(output)}`);
