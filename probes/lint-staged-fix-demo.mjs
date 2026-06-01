#!/usr/bin/env node
/**
 * Demonstrates that the lint-staged-side defensive fix unwedges the
 * iterator while still capturing all output.
 *
 * Setup is identical to probes/tinyexec-direct.mjs: tinyexec spawns a
 * child that spawns a non-unref'd stdio-inheriting grandchild and exits.
 * That setup wedges tinyexec's async iterator because the parent never
 * exits and the pipes never EOF.
 *
 * Fix pattern (suitable for landing in getSpawnedTask.js):
 *   1. Listen for the underlying child's `exit` event (NOT `close`,
 *      which waits on stdio EOF — same problem we're working around).
 *   2. On exit, wait a short grace window for buffered output to drain.
 *   3. Then forcibly destroy stdout and stderr. This makes tinyexec's
 *      internal `pipeline(stream, combined, {end: false})` calls reject,
 *      which routes through `.catch(maybeEmitEnd)` in combineStreams
 *      and ends the merger via `combined.end()`.
 *   4. The async iterator over the merger completes naturally.
 *
 * Output captured up to the grace point is preserved.
 */

import { exec } from "tinyexec";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const childScript = resolve(here, "child-spawns-grandchild.mjs");
const EXIT_GRACE_MS = 100;
const HARD_TIMEOUT_MS = 5_000;

const result = exec(process.execPath, [childScript], {
    nodeOptions: { stdio: ["ignore"] },
});

const startedAt = Date.now();

// Hard timeout: if the fix doesn't work, we should hit this. CI treats
// this as failure.
const hardTimer = setTimeout(() => {
    console.error(`[fix] FAIL: hard timeout fired after ${HARD_TIMEOUT_MS}ms`);
    process.exit(124);
}, HARD_TIMEOUT_MS);

// Wait for tinyexec to actually spawn before we can subscribe to exit.
await new Promise((r) => {
    const id = setInterval(() => {
        if (result.process) {
            clearInterval(id);
            r();
        }
    }, 1);
});

const proc = result.process;
let exitFired = false;

proc.once("exit", (code, signal) => {
    exitFired = true;
    console.error(`[fix] child exit code=${code} signal=${signal} at +${Date.now() - startedAt}ms`);
    // Give buffered output a brief window to drain, then force-end the
    // pipes so combineStreams resolves via its .catch(maybeEmitEnd) path.
    setTimeout(() => {
        proc.stdout?.destroy();
        proc.stderr?.destroy();
    }, EXIT_GRACE_MS);
});

let output = "";
try {
    for await (const line of result) {
        output += line + "\n";
        console.error(`[fix] line at +${Date.now() - startedAt}ms: ${line}`);
    }
} catch (e) {
    // Forcing destroy() may surface as an iterator error. That's part
    // of the fix path; the captured output up to that point is still valid.
    console.error(`[fix] iterator threw (expected on force-end): ${e.message}`);
}

clearTimeout(hardTimer);

const elapsed = Date.now() - startedAt;
console.error(`[fix] iterator returned after ${elapsed}ms`);
console.error(`[fix] captured output: ${JSON.stringify(output)}`);

if (!exitFired) {
    console.error("[fix] FAIL: child exit event never fired");
    process.exit(2);
}
if (elapsed > HARD_TIMEOUT_MS - 500) {
    console.error("[fix] FAIL: iterator completed close to hard timeout");
    process.exit(3);
}
if (!output.includes("child pid=") || !output.includes("grandchild pid=")) {
    console.error("[fix] FAIL: expected output line missing from capture");
    process.exit(4);
}

console.error(`[fix] PASS: iterator unwedged in ${elapsed}ms with output captured`);
process.exit(0);
