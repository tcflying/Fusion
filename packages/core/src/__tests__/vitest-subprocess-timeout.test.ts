import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

import { __fusionSubprocessTimeoutTestHooks } from "../__test-utils__/vitest-setup.js";
import {
  buildWindowsTaskkillCommand,
  buildWindowsProcessTreeCleanupCommand,
  terminateTestProcessTree,
  terminateTestProcessTreeSync,
  writeTestTimeoutArtifacts,
} from "../__test-utils__/vitest-teardown.js";

describe("Vitest subprocess timeout classification", () => {
  it("routes Windows cleanup through a bounded process-tree helper", async () => {
    const requests: Array<{ rootPid: number; startedAt: number; timeoutMs: number }> = [];

    const result = await terminateTestProcessTree(42_424, {
      platform: "win32",
      startedAt: 1_234,
      timeoutMs: 5_000,
      windowsCleanup: async (request) => {
        requests.push(request);
        return {
          rootPid: request.rootPid,
          method: "windows-process-tree",
          cleanupTimedOut: false,
          observedProcesses: [],
          residualProcesses: [],
        };
      },
    });

    expect(requests).toEqual([{
      rootPid: 42_424,
      startedAt: 1_234,
      timeoutMs: 5_000,
    }]);
    expect(result).toMatchObject({
      rootPid: 42_424,
      method: "windows-process-tree",
      cleanupTimedOut: false,
      residualProcesses: [],
    });
  });

  it("builds a bounded Windows process-tree command without command-line interpolation", () => {
    const command = buildWindowsProcessTreeCleanupCommand({
      rootPid: 43_434,
      startedAt: 9_876,
      timeoutMs: 4_000,
    }, [101, 202]);
    const encodedScript = command.args.at(-1);
    expect(encodedScript).toBeTruthy();
    const script = Buffer.from(encodedScript!, "base64").toString("utf16le");

    expect(command.command).toMatch(/powershell(?:\.exe)?$/i);
    expect(command.args.slice(0, -1)).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
    ]);
    expect(command.timeoutMs).toBe(4_000);
    expect(command.env).toMatchObject({
      FUSION_TEST_TREE_ROOT_PID: "43434",
      FUSION_TEST_TREE_STARTED_AT_MS: "9876",
      FUSION_TEST_TREE_CLEANUP_MS: "4000",
      FUSION_TEST_TREE_PROTECTED_PIDS: "101,202",
    });
    expect(script).toContain("Get-CimInstance Win32_Process");
    expect(script).toContain("Stop-Process");
    expect(script).toContain("residualProcesses");
  });

  it("builds a bounded native taskkill tree command as the Windows fast path", () => {
    const command = buildWindowsTaskkillCommand({
      rootPid: 43_435,
      startedAt: 9_877,
      timeoutMs: 5_000,
    });

    expect(command).toMatchObject({
      command: "taskkill.exe",
      args: ["/PID", "43435", "/T", "/F"],
      timeoutMs: 3_000,
    });
  });

  it("uses native taskkill as the default Windows process-tree fast path", async () => {
    const commands: Array<{ command: string; timeoutMs: number }> = [];
    const result = await terminateTestProcessTree(44_444, {
      platform: "win32",
      startedAt: 2_468,
      timeoutMs: 3_000,
      commandRunner: async (command) => {
        commands.push({ command: command.command, timeoutMs: command.timeoutMs });
        return {
          exitCode: 0,
          timedOut: false,
          stdout: "SUCCESS: process tree terminated",
          stderr: "",
        };
      },
    });

    expect(commands).toEqual([{ command: "taskkill.exe", timeoutMs: 3_000 }]);
    expect(result).toMatchObject({
      rootPid: 44_444,
      method: "windows-process-tree",
      cleanupTimedOut: false,
      residualProcesses: [],
    });
  });

  it("falls back to a bounded orphan inventory when the Windows root already exited", async () => {
    const commands: string[] = [];
    const result = await terminateTestProcessTree(45_454, {
      platform: "win32",
      startedAt: 3_579,
      timeoutMs: 4_000,
      commandRunner: async (command) => {
        commands.push(command.command);
        if (command.command === "taskkill.exe") {
          return {
            exitCode: 128,
            timedOut: false,
            stdout: "",
            stderr: "process not found",
          };
        }
        return {
          exitCode: 0,
          timedOut: false,
          stdout: JSON.stringify({
            rootPid: 45_454,
            method: "windows-process-tree",
            cleanupTimedOut: false,
            observedProcesses: [{
              pid: 45_455,
              parentPid: 45_454,
              name: "initdb.exe",
              createdAtMs: 3_580,
            }],
            residualProcesses: [],
          }),
          stderr: "",
        };
      },
    });

    expect(commands).toEqual(["taskkill.exe", "powershell.exe"]);
    expect(result).toMatchObject({
      rootPid: 45_454,
      cleanupTimedOut: false,
      observedProcesses: [{ pid: 45_455, name: "initdb.exe" }],
      residualProcesses: [],
    });
  });

  it("uses the same bounded taskkill tree path for synchronous PG runners", () => {
    const commands: string[] = [];
    const result = terminateTestProcessTreeSync(46_464, {
      platform: "win32",
      startedAt: 4_680,
      timeoutMs: 2_000,
      commandRunner: (command) => {
        commands.push(command.command);
        return {
          exitCode: 0,
          timedOut: false,
          stdout: "SUCCESS",
          stderr: "",
        };
      },
    });

    expect(commands).toEqual(["taskkill.exe"]);
    expect(result).toMatchObject({
      rootPid: 46_464,
      method: "windows-process-tree",
      cleanupTimedOut: false,
      residualProcesses: [],
    });
  });

  it("writes a redacted JUnit failure and a structured residual-process list", () => {
    const artifactDir = mkdtempSync(join(tmpdir(), "fusion-timeout-artifacts-"));
    try {
      const paths = writeTestTimeoutArtifacts({
        artifactDir,
        reason: "subprocess-timeout",
        testName: "PG fixture <timeout>",
        commandLine: "psql postgresql://postgres:super-secret@127.0.0.1:5432/postgres",
        timeoutMs: 1_500,
        workerPid: 101,
        rootPid: 202,
        cleanup: {
          rootPid: 202,
          method: "windows-process-tree",
          cleanupTimedOut: true,
          observedProcesses: [{
            pid: 202,
            parentPid: 101,
            name: "psql.exe",
            createdAtMs: 10,
          }],
          residualProcesses: [{
            pid: 303,
            parentPid: 202,
            name: "postgres.exe",
            createdAtMs: 20,
          }],
          error: "bounded cleanup helper unavailable",
        },
        observedAt: "2026-07-27T06:05:00.000Z",
      });
      const junit = readFileSync(paths.junitPath, "utf8");
      const processList = JSON.parse(
        readFileSync(paths.residualProcessListPath, "utf8"),
      ) as {
        cleanup: { cleanupTimedOut: boolean; error?: string };
        residualProcesses: Array<{ pid: number; name: string }>;
        commandLine: string;
      };

      expect(junit).toContain("<testsuite");
      expect(junit).toContain('failures="1"');
      expect(junit).toContain("PG fixture &lt;timeout&gt;");
      expect(junit).not.toContain("super-secret");
      expect(processList.commandLine).toContain("<redacted>");
      expect(processList.commandLine).not.toContain("super-secret");
      expect(processList).toMatchObject({
        cleanup: {
          cleanupTimedOut: true,
          error: "bounded cleanup helper unavailable",
        },
      });
      expect(processList.residualProcesses).toEqual([{
        pid: 303,
        parentPid: 202,
        name: "postgres.exe",
        createdAtMs: 20,
      }]);
    } finally {
      rmSync(artifactDir, { recursive: true, force: true });
    }
  });

  it("classifies only explicit synchronous timeout errors and records cleanup failures", () => {
    const hooks = __fusionSubprocessTimeoutTestHooks;

    expect(hooks.isSynchronousSubprocessTimeout({ code: "ETIMEDOUT" })).toBe(true);
    expect(hooks.isSynchronousSubprocessTimeout(new Error("runner timed out"))).toBe(true);
    expect(hooks.isSynchronousSubprocessTimeout({ signal: "SIGKILL" })).toBe(false);
    expect(hooks.failedTestProcessTreeCleanup(50_505, new Error("helper failed"))).toMatchObject({
      rootPid: 50_505,
      cleanupTimedOut: true,
      residualProcesses: [],
      error: "helper failed",
    });
  });

  it.runIf(process.platform === "win32")(
    "terminates a real invocation-owned Windows parent and grandchild",
    async () => {
      const parentScript = [
        'const { spawn } = require("node:child_process");',
        'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });',
        'process.stdout.write(String(child.pid) + "\\n");',
        "setInterval(() => {}, 1000);",
      ].join("");
      const startedAt = Date.now();
      const parent = spawn(process.execPath, ["-e", parentScript], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const [pidChunk] = await once(parent.stdout!, "data");
      const childPid = Number.parseInt(String(pidChunk).trim(), 10);
      expect(parent.pid).toBeTypeOf("number");
      expect(childPid).toBeGreaterThan(0);

      try {
        const result = await terminateTestProcessTree(parent.pid!, { startedAt });
        expect(result.error).toBeUndefined();
        expect(result.cleanupTimedOut).toBe(false);
        expect(result.observedProcesses.map((entry) => entry.pid)).toEqual(
          expect.arrayContaining([parent.pid!]),
        );
        expect(result.residualProcesses).toEqual([]);
        expect(() => process.kill(parent.pid!, 0)).toThrow();
        expect(() => process.kill(childPid, 0)).toThrow();
      } finally {
        for (const pid of [parent.pid, childPid]) {
          if (!pid) continue;
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // The process-tree helper should already have reaped this owned PID.
          }
        }
      }
    },
  );

  it("widens only embedded PostgreSQL commands", () => {
    const hooks = __fusionSubprocessTimeoutTestHooks;
    expect(hooks.testSubprocessTimeoutMs("git status --short")).toBe(hooks.defaultTimeoutMs);
    expect(hooks.testSubprocessTimeoutMs("node worker.js")).toBe(hooks.defaultTimeoutMs);
    expect(hooks.testSubprocessTimeoutMs("node C:\\tmp\\postgres")).toBe(hooks.defaultTimeoutMs);
    expect(hooks.testSubprocessTimeoutMs("git -C C:\\tmp\\postgres status")).toBe(
      hooks.defaultTimeoutMs,
    );
    expect(hooks.testSubprocessTimeoutMs("node C:\\tmp\\initdb.exe")).toBe(
      hooks.defaultTimeoutMs,
    );
    expect(hooks.testSubprocessTimeoutMs("C:\\tools\\initdb.exe --pgdata test")).toBe(
      Math.max(hooks.defaultTimeoutMs, hooks.embeddedPostgresTimeoutMs),
    );
    expect(hooks.testSubprocessTimeoutMs("/opt/postgres/bin/pg_ctl start")).toBe(
      Math.max(hooks.defaultTimeoutMs, hooks.embeddedPostgresTimeoutMs),
    );
    expect(hooks.testSubprocessTimeoutMs("postgres -D test-data")).toBe(
      Math.max(hooks.defaultTimeoutMs, hooks.embeddedPostgresTimeoutMs),
    );
  });
});
