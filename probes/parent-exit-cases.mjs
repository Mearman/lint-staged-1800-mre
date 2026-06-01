#!/usr/bin/env node
/**
 * Bare-Node demonstration of why the wedge happens at all.
 *
 * Node's child_process.spawn returns a ChildProcess that keeps the parent's
 * event loop alive until the child exits or `.unref()` is called. With
 * `stdio: 'pipe'`, even `.unref()` isn't enough — Node holds the loop for
 * the open pipe handles too.
 *
 * For each (stdio, unref) combination, spawn a grandchild that sleeps for
 * an hour and observe whether the parent script exits cleanly.
 *
 * Output format: one line per case, in pipe-delimited form, suitable for
 * grep-based assertions in the verification shell script.
 */

import { spawn } from "node:child_process";

const TIMEOUT_MS = 1500;

function runCase(label, stdio, callUnref) {
    return new Promise((resolve) => {
        const child = spawn(
            process.execPath,
            [
                "-e",
                `
                const { spawn } = require('node:child_process');
                const c = spawn(
                    process.execPath,
                    ['-e', 'setTimeout(() => {}, 1000 * 60 * 60)'],
                    { stdio: ${JSON.stringify(stdio)}, detached: false }
                );
                ${callUnref ? "c.unref();" : ""}
                `,
            ],
            { stdio: ["ignore", "ignore", "ignore"] },
        );

        const startedAt = Date.now();
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            resolve({ label, stdio, callUnref, verdict: "HUNG", ms: Date.now() - startedAt });
        }, TIMEOUT_MS);

        child.once("exit", (code) => {
            clearTimeout(timer);
            resolve({ label, stdio, callUnref, verdict: "exited", ms: Date.now() - startedAt });
        });
    });
}

const cases = [
    { label: "A_inherit_no_unref", stdio: ["ignore", "inherit", "inherit"], unref: false, expect: "HUNG" },
    { label: "B_inherit_unref",    stdio: ["ignore", "inherit", "inherit"], unref: true,  expect: "exited" },
    { label: "C_ignore_no_unref",  stdio: ["ignore", "ignore",  "ignore"],  unref: false, expect: "HUNG" },
    { label: "D_ignore_unref",     stdio: ["ignore", "ignore",  "ignore"],  unref: true,  expect: "exited" },
    { label: "E_pipe_no_unref",    stdio: ["ignore", "pipe",    "pipe"],    unref: false, expect: "HUNG" },
    { label: "F_pipe_unref",       stdio: ["ignore", "pipe",    "pipe"],    unref: true,  expect: "HUNG" },
];

console.log("case|stdio|unref|verdict|expect|ms");
let fail = 0;
for (const c of cases) {
    const r = await runCase(c.label, c.stdio, c.unref);
    const ok = r.verdict === c.expect ? "OK" : "MISMATCH";
    console.log(`${c.label}|${JSON.stringify(c.stdio)}|${c.unref}|${r.verdict}|${c.expect}|${r.ms}|${ok}`);
    if (r.verdict !== c.expect) fail++;
}

// Final sweep to clean up any leaked sleeping grandchildren.
const { spawnSync } = await import("node:child_process");
spawnSync("pkill", ["-KILL", "-f", "setTimeout..*1000..*60..*60"], { stdio: "ignore" });

if (fail === 0) {
    console.log("PASS: parent-exit matrix matches expectations");
    process.exit(0);
} else {
    console.log(`FAIL: ${fail} case(s) deviated from expectation`);
    process.exit(1);
}
