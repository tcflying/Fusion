/*
FNXC:CliRedirectedOutput 2026-07-27-17:28:
Run the built production CLI behind ordinary Node pipes. The opt-in process
test builds first, then keeps the CLI and logger emitter under one bounded
process-tree root.
*/
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const command = process.env.FUSION_CLI_OUTPUT_PROOF_COMMAND;

if (!["dashboard", "serve", "daemon"].includes(command)) {
  throw new Error(`Unsupported CLI output proof command: ${String(command)}`);
}

const tsxImport = pathToFileURL(
  createRequire(import.meta.url).resolve("tsx"),
).href;
const emitterPath = fileURLToPath(
  new URL("./process-output-severity-emitter.ts", import.meta.url),
);
const emitter = spawn(
  process.execPath,
  ["--conditions=source", "--import", tsxImport, emitterPath],
  {
    env: process.env,
    stdio: ["ignore", "inherit", "inherit"],
    windowsHide: true,
  },
);
const waitForChild = (child) =>
  new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({ code, signal });
    });
  });
const emitterExit = await waitForChild(emitter);
if (emitterExit.code !== 0) {
  throw new Error(
    `Severity emitter failed (code=${emitterExit.code}, signal=${emitterExit.signal})`,
  );
}

await import("../../dist/bin.js");
