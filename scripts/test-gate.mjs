#!/usr/bin/env node

import { spawn } from "node:child_process";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function runGate(args) {
  return new Promise((resolve) => {
    const child = spawn(pnpm, args, {
      stdio: "inherit",
      shell: process.platform === "win32",
    });

    child.once("error", (error) => {
      console.error(`[test:gate] failed to start ${args.join(" ")}: ${error.message}`);
      resolve(1);
    });
    child.once("close", (code) => resolve(code ?? 1));
  });
}

const codes = await Promise.all([
  runGate(["--filter", "@fusion/engine", "test:core"]),
  runGate(["--filter", "@fusion/core", "test:pg-gate"]),
]);

if (codes.some((code) => code !== 0)) {
  process.exitCode = 1;
}
