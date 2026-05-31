/**
 * MRE shim: on every Program node, spawn one node grandchild that inherits
 * stdout/stderr from the eslint process. The grandchild sleeps for an hour
 * so it stays alive long after eslint exits.
 *
 * This is a synthetic stand-in for whatever real-world plugin/parser code
 * is forking a stdio-inheriting subprocess inside eslint in production
 * (typescript-eslint helper, synckit worker with default stdio, language
 * server probe, etc.). The synthetic version is deterministic on every run.
 */
const { spawn } = require("node:child_process");

module.exports = {
  rules: {
    "spawn-grandchild": {
      meta: { type: "problem", schema: [] },
      create() {
        let spawned = false;
        return {
          Program() {
            if (spawned) return;
            spawned = true;
            spawn(
              process.execPath,
              ["-e", "setTimeout(() => {}, 1000 * 60 * 60)"],
              { stdio: ["ignore", "inherit", "inherit"], detached: false }
            );
            // Don't unref — the parent eslint shouldn't be aware the
            // grandchild is even there. That matches the production
            // mechanism.
          },
        };
      },
    },
  },
};
