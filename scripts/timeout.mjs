// Portable timeout wrapper: exits 124 if the command runs longer than N
// seconds, otherwise forwards the child's exit code. Mimics GNU coreutils
// `timeout(1)`. Used because macOS GitHub runners don't ship `timeout`.
//
// Usage:
//   node scripts/timeout.mjs <seconds> <command> [args...]

import { spawn } from "node:child_process";

const [, , secsArg, cmd, ...args] = process.argv;
const secs = Number(secsArg);

if (!Number.isFinite(secs) || !cmd) {
  console.error("usage: node scripts/timeout.mjs <seconds> <command> [args...]");
  process.exit(2);
}

const child = spawn(cmd, args, { stdio: "inherit" });

const timer = setTimeout(() => {
  child.kill("SIGTERM");
  setTimeout(() => {
    try { child.kill("SIGKILL"); } catch {}
  }, 2000);
  // Mark "timeout" outcome explicitly; the actual process.exit happens
  // when the child fires its own 'exit' event below.
  timedOut = true;
}, secs * 1000);

let timedOut = false;
child.on("exit", (code, signal) => {
  clearTimeout(timer);
  if (timedOut) process.exit(124);
  if (signal) process.exit(128);
  process.exit(code ?? 1);
});
