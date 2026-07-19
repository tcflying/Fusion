import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  it("settles an awaited availability check before a one-shot process exits", async () => {
    const directory = mkdtempSync(join(tmpdir(), "fusion-qmd-availability-"));
    tempDirectories.push(directory);
    const fixturePath = join(directory, "availability.ts");
    writeFileSync(
      fixturePath,
      `import { isQmdAvailable } from ${JSON.stringify(memoryBackendUrl)};\nisQmdAvailable().then((available) => process.stdout.write(\`resolved:\${available}\`));\n`,
      "utf8",
    );

    const result = await new Promise<{ code: number | null; stderr: string; stdout: string }>((resolvePromise, reject) => {
      const child = spawn(process.execPath, [tsxCliPath, fixturePath], {
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
        resolvePromise({ code, stderr, stdout });
      });
    });

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^resolved:(true|false)$/);
  }, 10_000);
});
