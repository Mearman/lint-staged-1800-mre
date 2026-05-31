// Stands in for what an ESLint process does when one of its plugins
// spawns a stdio-inheriting subprocess. The child itself prints a line
// and exits cleanly; the grandchild it spawned inherits fds 1 and 2
// from the child (which are tinyexec's pipe ends) and stays alive,
// holding those pipe ends open.
//
// This isolates the lint-staged-side mechanism from anything ESLint
// specific: no plugin, no projectService, no typescript-eslint — just
// the bare spawn shape that wedges tinyexec's iterator.

import { spawn } from "node:child_process";

const grandchild = spawn(
  process.execPath,
  ["-e", "setTimeout(() => {}, 1000 * 60 * 60)"],
  { stdio: ["ignore", "inherit", "inherit"], detached: false }
);

console.log(`child pid=${process.pid} grandchild pid=${grandchild.pid}`);
process.exit(0);
