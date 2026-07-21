import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const tsxPackageJsonPath = createRequire(import.meta.url).resolve("tsx/package.json");
const tsxCliPath = join(tsxPackageJsonPath, "..", "dist", "cli.mjs");
const memoryBackendUrl = pathToFileURL(join(fileURLToPath(new URL("..", import.meta.url)), "memory-backend.ts")).href;
const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("qmd availability process boundary", () => {
  /*
  FNXC:ProjectMemory 2026-07-19-22:17:
  Availability is an awaited foreground probe, so a delayed qmd child must keep
  a one-shot CLI process alive until the boolean result is observable. Background
  refresh children remain intentionally unreferenced on their separate executor.
  */
  it("waits for delayed qmd to resolve before a one-shot process exits", async () => {
    const directory = mkdtempSync(join(tmpdir(), "fusion-qmd-availability-"));
    tempDirectories.push(directory);
    const qmdPath = join(directory, process.platform === "win32" ? "qmd.cmd" : "qmd");
    const markerPath = join(directory, "delayed-qmd-invoked");
    writeFileSync(
      qmdPath,
      process.platform === "win32"
        ? `@echo off\r\n> "${markerPath}" echo invoked\r\nping 127.0.0.1 -n 2 >nul\r\nexit /b 0\r\n`
        : `#!/usr/bin/env sh\nprintf invoked > ${JSON.stringify(markerPath)}\nsleep 1\nexit 0\n`,
      "utf8",
    );
    if (process.platform !== "win32") {
      chmodSync(qmdPath, 0o755);
    }

    const fixturePath = join(directory, "availability.ts");
    writeFileSync(
      fixturePath,
      `import { isQmdAvailable } from ${JSON.stringify(memoryBackendUrl)};\nisQmdAvailable().then((available) => process.stdout.write(\`resolved:\${available}\`));\n`,
      "utf8",
    );

    const startedAt = Date.now();
    const result = await new Promise<{ code: number | null; elapsedMs: number; stderr: string; stdout: string }>((resolvePromise, reject) => {
      const child = spawn(process.execPath, [tsxCliPath, fixturePath], {
        env: {
          ...process.env,
          PATH: `${directory}${delimiter}${process.env.PATH ?? ""}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", reject);
      child.on("close", (code) => {
        resolvePromise({ code, elapsedMs: Date.now() - startedAt, stderr, stdout });
      });
    });

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe("resolved:true");
    expect(readFileSync(markerPath, "utf8").trim()).toBe("invoked");
    expect(result.elapsedMs).toBeGreaterThanOrEqual(900);
  }, 10_000);
});
