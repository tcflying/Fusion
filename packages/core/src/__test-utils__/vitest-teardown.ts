/**
 * Vitest globalSetup hook.
 *
 * We publish a per-invocation worker-root env var. Teardown removes that private
 * root after the project finishes so workspace isolation checks do not report
 * the run-local worker/home directories as leaks.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type ChildProcessModule = typeof import("node:child_process");

const requireFromHere = createRequire(import.meta.url);
const originalChildProcess = requireFromHere("node:child_process") as ChildProcessModule;

export const WORKER_ROOT_OWNER_FILE = ".fusion-test-worker-root-owner";
export const WORKER_ROOT_LIFECYCLE_DIR = ".fusion-test-worker-lifecycle";
const FUSION_TEST_RUN_TOKEN_ENV = "FUSION_TEST_RUN_TOKEN";
const LEGACY_TEST_HOME_PREFIX = "fn-test-home-";
const WINDOWS_NATIVE_RM_MAX_RETRIES = 2;
const WINDOWS_NATIVE_RM_RETRY_DELAY_MS = 25;

let workerRootRmSync = rmSync;

export function __setWorkerRootRmSyncForTests(nextRmSync: typeof rmSync): void {
  workerRootRmSync = typeof nextRmSync === "function" ? nextRmSync : rmSync;
}

export type WorkerRootLifecycleKind = "worker" | "child";

export type WorkerRootLifecycle = Readonly<{
  path: string;
  pid: number;
  kind: WorkerRootLifecycleKind;
}>;

export type WorkerRootCleanupFailure = Readonly<{
  code: string;
  path: string;
  syscall: string;
  attempts: number;
  elapsedMs: number;
  nativeMaxRetries: number;
}>;

export type TestProcessRecord = Readonly<{
  pid: number;
  parentPid: number;
  name: string;
  createdAtMs: number | null;
}>;

export type TestProcessTreeCleanupResult = Readonly<{
  rootPid: number;
  method: "windows-process-tree" | "direct-process";
  cleanupTimedOut: boolean;
  observedProcesses: readonly TestProcessRecord[];
  residualProcesses: readonly TestProcessRecord[];
  error?: string;
}>;

export type WindowsProcessTreeCleanupRequest = Readonly<{
  rootPid: number;
  startedAt: number;
  timeoutMs: number;
}>;

export interface TerminateTestProcessTreeOptions {
  readonly platform?: NodeJS.Platform;
  readonly startedAt?: number;
  readonly timeoutMs?: number;
  readonly windowsCleanup?: (
    request: WindowsProcessTreeCleanupRequest,
  ) => Promise<TestProcessTreeCleanupResult>;
  readonly commandRunner?: WindowsProcessTreeCleanupCommandRunner;
  readonly protectedPids?: readonly number[];
  readonly killRoot?: () => void;
}

export type WindowsProcessTreeCleanupCommand = Readonly<{
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}>;

export type WindowsProcessTreeCleanupCommandResult = Readonly<{
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}>;

export type WindowsProcessTreeCleanupCommandRunner = (
  command: WindowsProcessTreeCleanupCommand,
) => Promise<WindowsProcessTreeCleanupCommandResult>;

export type WindowsProcessTreeCleanupSyncCommandRunner = (
  command: WindowsProcessTreeCleanupCommand,
) => WindowsProcessTreeCleanupCommandResult;

export interface TerminateTestProcessTreeSyncOptions {
  readonly platform?: NodeJS.Platform;
  readonly startedAt?: number;
  readonly timeoutMs?: number;
  readonly commandRunner?: WindowsProcessTreeCleanupSyncCommandRunner;
  readonly protectedPids?: readonly number[];
  readonly killRoot?: () => void;
}

export type TestTimeoutArtifactInput = Readonly<{
  artifactDir: string;
  reason: "subprocess-timeout" | "test-timeout" | "left-running";
  testName: string | null;
  commandLine: string | null;
  timeoutMs: number;
  workerPid: number;
  rootPid: number | null;
  cleanup: TestProcessTreeCleanupResult | null;
  observedAt?: string;
}>;

export type TestTimeoutArtifactPaths = Readonly<{
  junitPath: string;
  residualProcessListPath: string;
}>;

const WINDOWS_PROCESS_TREE_CLEANUP_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$rootPidValue = [int]$env:FUSION_TEST_TREE_ROOT_PID",
  "$startedAtMs = [int64]$env:FUSION_TEST_TREE_STARTED_AT_MS",
  "$cleanupMs = [int]$env:FUSION_TEST_TREE_CLEANUP_MS",
  "$deadline = [DateTimeOffset]::UtcNow.AddMilliseconds($cleanupMs)",
  "$protected = [System.Collections.Generic.HashSet[int]]::new()",
  "foreach ($rawPid in ($env:FUSION_TEST_TREE_PROTECTED_PIDS -split ',')) {",
  "  $parsedPid = 0",
  "  if ([int]::TryParse($rawPid, [ref]$parsedPid) -and $parsedPid -gt 0) { [void]$protected.Add($parsedPid) }",
  "}",
  "$known = [System.Collections.Generic.HashSet[int]]::new()",
  "[void]$known.Add($rootPidValue)",
  "$observed = @{}",
  "function Get-CreatedAtMs {",
  "  param($row)",
  "  try { return ([DateTimeOffset]$row.CreationDate).ToUnixTimeMilliseconds() } catch { return 0 }",
  "}",
  "function Get-LiveOwnedProcesses {",
  "  $all = @(Get-CimInstance Win32_Process -ErrorAction Stop)",
  "  $eligible = @{}",
  "  foreach ($row in $all) {",
  "    $pidValue = [int]$row.ProcessId",
  "    if ($pidValue -le 0 -or $protected.Contains($pidValue)) { continue }",
  "    $createdAtMs = Get-CreatedAtMs $row",
  "    if ($createdAtMs -lt ($startedAtMs - 10000)) { continue }",
  "    $eligible[$pidValue] = [pscustomobject]@{",
  "      pid = $pidValue",
  "      parentPid = [int]$row.ParentProcessId",
  "      name = [string]$row.Name",
  "      createdAtMs = $createdAtMs",
  "    }",
  "  }",
  "  $changed = $true",
  "  while ($changed) {",
  "    $changed = $false",
  "    foreach ($entry in $eligible.Values) {",
  "      if (-not $known.Contains([int]$entry.pid) -and $known.Contains([int]$entry.parentPid)) {",
  "        [void]$known.Add([int]$entry.pid)",
  "        $changed = $true",
  "      }",
  "    }",
  "  }",
  "  $live = @()",
  "  foreach ($knownPid in $known) {",
  "    if ($eligible.ContainsKey($knownPid)) { $live += $eligible[$knownPid] }",
  "  }",
  "  return @($live)",
  "}",
  "$live = @(Get-LiveOwnedProcesses)",
  "foreach ($entry in $live) { $observed[[int]$entry.pid] = $entry }",
  "foreach ($entry in $live) {",
  "  if ([int]$entry.pid -eq $rootPidValue) { Stop-Process -Id ([int]$entry.pid) -Force -ErrorAction SilentlyContinue }",
  "}",
  "foreach ($entry in $live) {",
  "  if ([int]$entry.pid -ne $rootPidValue) { Stop-Process -Id ([int]$entry.pid) -Force -ErrorAction SilentlyContinue }",
  "}",
  "$residual = @()",
  "do {",
  "  $residual = @()",
  "  foreach ($entry in $observed.Values) {",
  "    $remaining = Get-Process -Id ([int]$entry.pid) -ErrorAction SilentlyContinue",
  "    if ($null -ne $remaining) { $residual += $entry }",
  "  }",
  "  if ($residual.Count -gt 0 -and [DateTimeOffset]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 50 }",
  "} while ($residual.Count -gt 0 -and [DateTimeOffset]::UtcNow -lt $deadline)",
  "$result = [pscustomobject]@{",
  "  rootPid = $rootPidValue",
  "  method = 'windows-process-tree'",
  "  cleanupTimedOut = ($residual.Count -gt 0)",
  "  observedProcesses = @($observed.Values)",
  "  residualProcesses = @($residual)",
  "}",
  "$result | ConvertTo-Json -Compress -Depth 5",
].join("\n");

export function buildWindowsProcessTreeCleanupCommand(
  request: WindowsProcessTreeCleanupRequest,
  protectedPids: readonly number[] = [],
): WindowsProcessTreeCleanupCommand {
  const timeoutMs = Math.max(1, Math.trunc(request.timeoutMs));
  const safeProtectedPids = Array.from(new Set(protectedPids))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
  return {
    command: "powershell.exe",
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(WINDOWS_PROCESS_TREE_CLEANUP_SCRIPT, "utf16le").toString("base64"),
    ],
    env: {
      FUSION_TEST_TREE_ROOT_PID: String(request.rootPid),
      FUSION_TEST_TREE_STARTED_AT_MS: String(Math.trunc(request.startedAt)),
      FUSION_TEST_TREE_CLEANUP_MS: String(timeoutMs),
      FUSION_TEST_TREE_PROTECTED_PIDS: safeProtectedPids.join(","),
    },
    timeoutMs,
  };
}

export function buildWindowsTaskkillCommand(
  request: WindowsProcessTreeCleanupRequest,
): WindowsProcessTreeCleanupCommand {
  return {
    command: "taskkill.exe",
    args: ["/PID", String(request.rootPid), "/T", "/F"],
    env: {},
    timeoutMs: Math.max(1, Math.min(3_000, Math.trunc(request.timeoutMs))),
  };
}

const MAX_TREE_HELPER_OUTPUT_CHARS = 64 * 1024;

function appendBoundedOutput(current: string, chunk: unknown): string {
  if (current.length >= MAX_TREE_HELPER_OUTPUT_CHARS) return current;
  const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
  return (current + text).slice(0, MAX_TREE_HELPER_OUTPUT_CHARS);
}

async function runWindowsProcessTreeCleanupCommand(
  command: WindowsProcessTreeCleanupCommand,
): Promise<WindowsProcessTreeCleanupCommandResult> {
  return new Promise((resolveCommand) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const controller = new AbortController();
    const child = originalChildProcess.spawn(command.command, [...command.args], {
      env: { ...process.env, ...command.env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      signal: controller.signal,
    });
    const settle = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveCommand({ exitCode, timedOut, stdout, stderr });
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
      try {
        child.kill("SIGKILL");
      } catch {
        // The helper may have completed at the timeout boundary.
      }
    }, command.timeoutMs);
    timeout.unref?.();
    child.stdout?.on("data", (chunk) => {
      stdout = appendBoundedOutput(stdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = appendBoundedOutput(stderr, chunk);
    });
    child.once("error", (error) => {
      stderr = appendBoundedOutput(stderr, error instanceof Error ? error.message : error);
      settle(null);
    });
    child.once("close", (code) => settle(code));
  });
}

function runWindowsProcessTreeCleanupCommandSync(
  command: WindowsProcessTreeCleanupCommand,
): WindowsProcessTreeCleanupCommandResult {
  const result = originalChildProcess.spawnSync(command.command, [...command.args], {
    env: { ...process.env, ...command.env },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: command.timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: MAX_TREE_HELPER_OUTPUT_CHARS,
  });
  const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  return {
    exitCode: result.status,
    timedOut: errorCode === "ETIMEDOUT",
    stdout: appendBoundedOutput("", result.stdout ?? ""),
    stderr: appendBoundedOutput(
      "",
      result.stderr ?? result.error?.message ?? "",
    ),
  };
}

function toTestProcessRecord(value: unknown): TestProcessRecord | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<TestProcessRecord>;
  if (!Number.isInteger(candidate.pid) || (candidate.pid ?? 0) <= 0) return null;
  if (!Number.isInteger(candidate.parentPid) || (candidate.parentPid ?? -1) < 0) return null;
  return {
    pid: candidate.pid!,
    parentPid: candidate.parentPid!,
    name: typeof candidate.name === "string" ? candidate.name : "<unknown>",
    createdAtMs: typeof candidate.createdAtMs === "number" && Number.isFinite(candidate.createdAtMs)
      ? candidate.createdAtMs
      : null,
  };
}

function normalizeProcessRecords(value: unknown): readonly TestProcessRecord[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values
    .map(toTestProcessRecord)
    .filter((record): record is TestProcessRecord => record !== null);
}

function parseWindowsProcessTreeCleanupResult(
  request: WindowsProcessTreeCleanupRequest,
  commandResult: WindowsProcessTreeCleanupCommandResult,
): TestProcessTreeCleanupResult {
  const lines = commandResult.stdout.trim().split(/\r?\n/).filter(Boolean);
  const jsonLine = lines.at(-1);
  try {
    const parsed = JSON.parse(jsonLine ?? "") as Partial<TestProcessTreeCleanupResult>;
    if (parsed.rootPid !== request.rootPid || parsed.method !== "windows-process-tree") {
      throw new Error("helper result identity mismatch");
    }
    return {
      rootPid: request.rootPid,
      method: "windows-process-tree",
      cleanupTimedOut: commandResult.timedOut || parsed.cleanupTimedOut === true,
      observedProcesses: normalizeProcessRecords(parsed.observedProcesses),
      residualProcesses: normalizeProcessRecords(parsed.residualProcesses),
      ...(commandResult.exitCode === 0
        ? {}
        : { error: `process-tree helper exited ${commandResult.exitCode ?? "without a code"}` }),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const helperDetail = commandResult.stderr.trim().slice(0, 1_000);
    return {
      rootPid: request.rootPid,
      method: "windows-process-tree",
      cleanupTimedOut: commandResult.timedOut,
      observedProcesses: [],
      residualProcesses: [],
      error: `process-tree helper result unavailable: ${detail}${helperDetail ? `; ${helperDetail}` : ""}`,
    };
  }
}

function redactTimeoutArtifactText(value: string | null): string {
  if (!value) return "";
  return value
    .replace(
      /([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s/]+@/gi,
      "$1<redacted>@",
    )
    .replace(
      /\b(password|passwd|token|secret|api[_-]?key|pgpassword)\s*=\s*(?:"[^"]*"|'[^']*'|\S+)/gi,
      "$1=<redacted>",
    );
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/*
FNXC:PostgresTestTimeoutEvidence 2026-07-27-06:05:
Every timed-out PostgreSQL fixture or temporary test runner must leave durable,
machine-readable evidence after cleanup: one failing JUnit testcase and one
redacted residual-process inventory. The files live outside the worker root so
normal Vitest teardown cannot erase the timeout diagnosis.
*/
export function writeTestTimeoutArtifacts(
  input: TestTimeoutArtifactInput,
): TestTimeoutArtifactPaths {
  mkdirSync(input.artifactDir, { recursive: true });
  const observedAt = input.observedAt ?? new Date().toISOString();
  const timestamp = observedAt.replace(/[^0-9]/g, "").slice(0, 17);
  const rootLabel = input.rootPid ?? "none";
  const suffix = randomUUID().replace(/-/g, "").slice(0, 8);
  const stem = `${input.reason}-${timestamp}-${input.workerPid}-${rootLabel}-${suffix}`;
  const residualProcessListPath = join(input.artifactDir, `${stem}.processes.json`);
  const junitPath = join(input.artifactDir, `${stem}.junit.xml`);
  const commandLine = redactTimeoutArtifactText(input.commandLine);
  const residualProcesses = input.cleanup?.residualProcesses ?? [];
  const inventory = {
    schemaVersion: 1,
    reason: input.reason,
    observedAt,
    testName: input.testName,
    commandLine,
    timeoutMs: input.timeoutMs,
    workerPid: input.workerPid,
    rootPid: input.rootPid,
    cleanup: input.cleanup,
    residualProcesses,
  };
  writeFileSync(
    residualProcessListPath,
    `${JSON.stringify(inventory, null, 2)}\n`,
    "utf8",
  );

  const testName = input.testName ?? "<unknown test>";
  const failureMessage = [
    `${input.reason} after ${input.timeoutMs}ms`,
    commandLine ? `command: ${commandLine}` : "command: <none>",
    `cleanup: ${input.cleanup?.method ?? "not-applicable"}`,
    `residual processes: ${residualProcesses.length}`,
  ].join("; ");
  const durationSeconds = Math.max(0, input.timeoutMs) / 1_000;
  const junit = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="fusion-test-timeouts" tests="1" failures="1" errors="0" skipped="0" time="${durationSeconds}">`,
    `  <testsuite name="fusion-test-timeouts" tests="1" failures="1" errors="0" skipped="0" time="${durationSeconds}" timestamp="${escapeXml(observedAt)}">`,
    `    <testcase classname="fusion.test-infrastructure" name="${escapeXml(testName)}" time="${durationSeconds}">`,
    `      <failure type="TestInfrastructureTimeout" message="${escapeXml(failureMessage)}">${escapeXml(failureMessage)}</failure>`,
    `      <system-out>${escapeXml(`Residual process list: ${residualProcessListPath}`)}</system-out>`,
    "    </testcase>",
    "  </testsuite>",
    "</testsuites>",
    "",
  ].join("\n");
  writeFileSync(junitPath, junit, "utf8");
  return { junitPath, residualProcessListPath };
}

/*
FNXC:PostgresTestProcessCleanup 2026-07-27-06:01:
PostgreSQL test binaries and temporary runners must be terminated through one
bounded process-tree seam on Windows. Keeping the seam injectable gives the
regression tests deterministic RED/GREEN evidence without targeting unrelated
machine processes or the operator's live Fusion/Happier instances.
*/
export async function terminateTestProcessTree(
  rootPid: number,
  options: TerminateTestProcessTreeOptions = {},
): Promise<TestProcessTreeCleanupResult> {
  if (!Number.isInteger(rootPid) || rootPid <= 0) {
    throw new Error(`Invalid test process-tree root pid: ${rootPid}`);
  }
  const request: WindowsProcessTreeCleanupRequest = {
    rootPid,
    startedAt: options.startedAt ?? Date.now(),
    timeoutMs: options.timeoutMs ?? 5_000,
  };
  if ((options.platform ?? process.platform) === "win32") {
    if (options.windowsCleanup) {
      return options.windowsCleanup(request);
    }
    const commandRunner = options.commandRunner ?? runWindowsProcessTreeCleanupCommand;
    const deadline = Date.now() + request.timeoutMs;
    const taskkillResult = await commandRunner(buildWindowsTaskkillCommand(request));
    if (taskkillResult.exitCode === 0 && !taskkillResult.timedOut) {
      return {
        rootPid,
        method: "windows-process-tree",
        cleanupTimedOut: false,
        observedProcesses: [{
          pid: rootPid,
          parentPid: 0,
          name: "<process-tree-root>",
          createdAtMs: request.startedAt,
        }],
        residualProcesses: [],
      };
    }

    const remainingMs = Math.max(1, deadline - Date.now());
    const fallbackRequest = { ...request, timeoutMs: remainingMs };
    const fallbackCommand = buildWindowsProcessTreeCleanupCommand(
      fallbackRequest,
      options.protectedPids ?? [process.pid, process.ppid],
    );
    const fallbackResult = parseWindowsProcessTreeCleanupResult(
      fallbackRequest,
      await commandRunner(fallbackCommand),
    );
    if (!fallbackResult.error) return fallbackResult;
    options.killRoot?.();
    const taskkillDetail = taskkillResult.stderr.trim().slice(0, 500);
    return {
      ...fallbackResult,
      cleanupTimedOut: taskkillResult.timedOut || fallbackResult.cleanupTimedOut,
      error: [
        `taskkill exited ${taskkillResult.exitCode ?? "without a code"}`,
        taskkillDetail,
        fallbackResult.error,
      ].filter(Boolean).join("; "),
    };
  }

  options.killRoot?.();
  return {
    rootPid,
    method: "direct-process",
    cleanupTimedOut: false,
    observedProcesses: [],
    residualProcesses: [],
  };
}

export function terminateTestProcessTreeSync(
  rootPid: number,
  options: TerminateTestProcessTreeSyncOptions = {},
): TestProcessTreeCleanupResult {
  if (!Number.isInteger(rootPid) || rootPid <= 0) {
    throw new Error(`Invalid test process-tree root pid: ${rootPid}`);
  }
  const request: WindowsProcessTreeCleanupRequest = {
    rootPid,
    startedAt: options.startedAt ?? Date.now(),
    timeoutMs: options.timeoutMs ?? 5_000,
  };
  if ((options.platform ?? process.platform) !== "win32") {
    options.killRoot?.();
    return {
      rootPid,
      method: "direct-process",
      cleanupTimedOut: false,
      observedProcesses: [],
      residualProcesses: [],
    };
  }

  const commandRunner = options.commandRunner ?? runWindowsProcessTreeCleanupCommandSync;
  const deadline = Date.now() + request.timeoutMs;
  const taskkillResult = commandRunner(buildWindowsTaskkillCommand(request));
  if (taskkillResult.exitCode === 0 && !taskkillResult.timedOut) {
    return {
      rootPid,
      method: "windows-process-tree",
      cleanupTimedOut: false,
      observedProcesses: [{
        pid: rootPid,
        parentPid: 0,
        name: "<process-tree-root>",
        createdAtMs: request.startedAt,
      }],
      residualProcesses: [],
    };
  }

  const fallbackRequest = {
    ...request,
    timeoutMs: Math.max(1, deadline - Date.now()),
  };
  const fallbackResult = parseWindowsProcessTreeCleanupResult(
    fallbackRequest,
    commandRunner(buildWindowsProcessTreeCleanupCommand(
      fallbackRequest,
      options.protectedPids ?? [process.pid, process.ppid],
    )),
  );
  if (!fallbackResult.error) return fallbackResult;
  options.killRoot?.();
  const taskkillDetail = taskkillResult.stderr.trim().slice(0, 500);
  return {
    ...fallbackResult,
    cleanupTimedOut: taskkillResult.timedOut || fallbackResult.cleanupTimedOut,
    error: [
      `taskkill exited ${taskkillResult.exitCode ?? "without a code"}`,
      taskkillDetail,
      fallbackResult.error,
    ].filter(Boolean).join("; "),
  };
}

export class WorkerRootCleanupError extends Error {
  readonly code: string;
  readonly path: string;
  readonly syscall: string;
  readonly attempts: number;
  readonly elapsedMs: number;
  readonly nativeMaxRetries: number;

  constructor(details: WorkerRootCleanupFailure, cause?: unknown) {
    super(`[vitest-teardown] worker-root cleanup failed ${JSON.stringify(details)}`, { cause });
    this.name = "WorkerRootCleanupError";
    this.code = details.code;
    this.path = details.path;
    this.syscall = details.syscall;
    this.attempts = details.attempts;
    this.elapsedMs = details.elapsedMs;
    this.nativeMaxRetries = details.nativeMaxRetries;
  }

  toJSON(): WorkerRootCleanupFailure {
    return {
      code: this.code,
      path: this.path,
      syscall: this.syscall,
      attempts: this.attempts,
      elapsedMs: this.elapsedMs,
      nativeMaxRetries: this.nativeMaxRetries,
    };
  }
}

function nativeWorkerRootRetryOptions(): { maxRetries: number; retryDelay: number } {
  if (process.platform !== "win32") {
    return { maxRetries: 0, retryDelay: 0 };
  }
  return {
    maxRetries: WINDOWS_NATIVE_RM_MAX_RETRIES,
    retryDelay: WINDOWS_NATIVE_RM_RETRY_DELAY_MS,
  };
}

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function toWorkerRootCleanupError(
  error: unknown,
  workerRoot: string,
  attempts: number,
  startedAt: number,
  fallback: Pick<WorkerRootCleanupFailure, "code" | "syscall"> = { code: "UNKNOWN", syscall: "rmSync" },
): WorkerRootCleanupError {
  if (error instanceof WorkerRootCleanupError) return error;
  const errno = error && typeof error === "object" ? error as NodeJS.ErrnoException : null;
  const retryOptions = nativeWorkerRootRetryOptions();
  return new WorkerRootCleanupError({
    code: errno?.code ?? fallback.code,
    path: workerRoot,
    syscall: errno?.syscall ?? fallback.syscall,
    attempts,
    elapsedMs: Math.max(0, Date.now() - startedAt),
    nativeMaxRetries: retryOptions.maxRetries,
  }, error);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM proves neither that the process is gone nor that it released its
    // cwd/handles, so fail closed and leave the invocation-owned root intact.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export function registerWorkerRootLifecycle(
  workerRoot: string,
  kind: WorkerRootLifecycleKind,
  pid = process.pid,
): WorkerRootLifecycle {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Invalid managed ${kind} lifecycle pid: ${pid}`);
  }
  const lifecycleDir = join(workerRoot, WORKER_ROOT_LIFECYCLE_DIR);
  const path = join(lifecycleDir, `${kind}-${pid}.json`);
  // A worker that cannot publish its lease cannot prove it released the shared
  // root later, so fail its setup rather than allowing a false-green cleanup.
  mkdirSync(lifecycleDir, { recursive: true });
  writeFileSync(path, JSON.stringify({ pid, kind }));
  return { path, pid, kind };
}

export function releaseWorkerRootLifecycle(lifecycle: WorkerRootLifecycle | null | undefined): void {
  if (!lifecycle) return;
  try {
    unlinkSync(lifecycle.path);
  } catch {
    // The finalizer validates remaining records before deleting the root.
  }
}

function assertWorkerRootLifecycleSettled(workerRoot: string, startedAt: number): void {
  const lifecycleDir = join(workerRoot, WORKER_ROOT_LIFECYCLE_DIR);
  let entries: string[];
  try {
    entries = readdirSync(lifecycleDir);
  } catch (error) {
    if (isEnoent(error)) return;
    throw toWorkerRootCleanupError(error, workerRoot, 0, startedAt, {
      code: "EIO",
      syscall: "readdir",
    });
  }

  const unresolved: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) {
      unresolved.push(entry);
      continue;
    }
    const path = join(lifecycleDir, entry);
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<WorkerRootLifecycle>;
      const pid = parsed.pid;
      const kind = parsed.kind;
      if (typeof pid !== "number" || !Number.isInteger(pid) || (kind !== "worker" && kind !== "child")) {
        unresolved.push(entry);
        continue;
      }
      if (isProcessAlive(pid)) {
        unresolved.push(`${kind}-${pid}`);
        continue;
      }
      unlinkSync(path);
    } catch {
      // An unreadable record cannot prove its process released the root.
      unresolved.push(entry);
    }
  }

  if (unresolved.length > 0) {
    throw new WorkerRootCleanupError({
      code: "EBUSY",
      path: workerRoot,
      syscall: "worker-lifecycle",
      attempts: 0,
      elapsedMs: Math.max(0, Date.now() - startedAt),
      nativeMaxRetries: nativeWorkerRootRetryOptions().maxRetries,
    }, new Error(`Managed worker/child lifecycle remains active or unproven: ${unresolved.join(", ")}`));
  }
}

export function removeLegacyTopLevelHomeRoots(tempRoot = tmpdir()): void {
  /*
  FNXC:TestIsolation 2026-06-14-00:36:
  FN-6430 found stale top-level `fn-test-home-*` roots after CLI package-load runs; current workers create HOME under `fusion-test-workers-*`, so top-level homes are legacy leftovers that can bleed settings/cache state into nested lanes.
  Sweep only a single temp-root level by prefix during setup/teardown, never a recursive temp-tree walk.
  */
  let entries: string[] = [];
  try {
    entries = readdirSync(tempRoot);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.startsWith(LEGACY_TEST_HOME_PREFIX)) continue;
    try {
      workerRootRmSync(join(tempRoot, entry), { recursive: true, force: true });
    } catch {
      // Best effort only. A future invocation will retry the bounded prefix sweep.
    }
  }
}

export function removeWorkerRootWithRetry(workerRoot: string, startedAt = Date.now()): void {
  /*
  FNXC:TestIsolation 2026-07-19-19:47:
  Vitest 4 closes globalSetup before it closes the fork pool, so retrying a
  shared root while a fork still has cwd inside it turns Windows EPERM into a
  false-green warning. Lifecycle proof gates deletion first; Node's bounded
  native recursive-rm retry is only a final guard for a just-released handle.
  */
  try {
    workerRootRmSync(workerRoot, {
      recursive: true,
      force: true,
      ...nativeWorkerRootRetryOptions(),
    });
  } catch (error) {
    if (isEnoent(error)) return;
    throw toWorkerRootCleanupError(error, workerRoot, 1, startedAt);
  }
}

export function finalizeWorkerRootCleanup(workerRoot: string): void {
  const startedAt = Date.now();
  assertWorkerRootLifecycleSettled(workerRoot, startedAt);
  removeWorkerRootWithRetry(workerRoot, startedAt);
}

export interface WorkerRootLifecycleWaitOptions {
  readonly maxWaitMs?: number;
  readonly pollIntervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

export interface WorkerRootLifecycleSyncWaitOptions {
  readonly maxWaitMs?: number;
  readonly pollIntervalMs?: number;
  readonly sleep?: (ms: number) => void;
  readonly now?: () => number;
}

/*
FNXC:TestWorkerLifecycleCleanup 2026-07-27-02:41:
Vitest can emit the main process beforeExit while its Windows fork is in the
last milliseconds of shutdown. Wait only for the invocation-owned lifecycle
record, with a hard deadline, then perform the existing fail-closed cleanup.
Persistent or unproven workers still fail the run; this only removes the race
between pool shutdown and the worker's exit hook.
*/
export async function finalizeWorkerRootCleanupAfterLifecycle(
  workerRoot: string,
  options: WorkerRootLifecycleWaitOptions = {},
): Promise<void> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  }));
  const maxWaitMs = options.maxWaitMs ?? 5_000;
  const pollIntervalMs = options.pollIntervalMs ?? 25;
  const startedAt = now();

  while (true) {
    try {
      finalizeWorkerRootCleanup(workerRoot);
      return;
    } catch (error) {
      const isLifecycleRace = error instanceof WorkerRootCleanupError
        && error.code === "EBUSY"
        && error.syscall === "worker-lifecycle";
      if (!isLifecycleRace || now() - startedAt >= maxWaitMs) {
        throw error;
      }
      await sleep(pollIntervalMs);
    }
  }
}

export function finalizeWorkerRootCleanupAfterLifecycleSync(
  workerRoot: string,
  options: WorkerRootLifecycleSyncWaitOptions = {},
): void {
  const now = options.now ?? Date.now;
  const sleeper = options.sleep ?? ((ms: number) => {
    const gate = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    Atomics.wait(gate, 0, 0, ms);
  });
  const maxWaitMs = options.maxWaitMs ?? 5_000;
  const pollIntervalMs = options.pollIntervalMs ?? 25;
  const startedAt = now();

  while (true) {
    try {
      finalizeWorkerRootCleanup(workerRoot);
      return;
    } catch (error) {
      const isLifecycleRace = error instanceof WorkerRootCleanupError
        && error.code === "EBUSY"
        && error.syscall === "worker-lifecycle";
      if (!isLifecycleRace || now() - startedAt >= maxWaitMs) {
        throw error;
      }
      sleeper(pollIntervalMs);
    }
  }
}

function reportWorkerRootCleanupFailure(error: unknown): void {
  const failure = error instanceof WorkerRootCleanupError
    ? error
    : toWorkerRootCleanupError(error, "<unknown-worker-root>", 0, Date.now());
  try {
    process.stderr.write(`${failure.message}\n`);
  } catch {
    // Throwing from the synchronous exit fallback below still makes the run fail.
  }
}

function installFinalWorkerRootCleanup(workerRoot: string): void {
  let finalized = false;
  let failure: WorkerRootCleanupError | null = null;
  // `beforeExit` runs after Vitest has closed its pool during normal CLI exit.
  // Keep the `exit` fallback for runners that call process.exit() directly.
  process.once("beforeExit", () => {
    void finalizeWorkerRootCleanupAfterLifecycle(workerRoot)
      .then(() => {
        finalized = true;
      })
      .catch((error) => {
        failure = toWorkerRootCleanupError(error, workerRoot, 0, Date.now());
        finalized = true;
        reportWorkerRootCleanupFailure(failure);
        process.exitCode = 1;
      });
  });
  process.once("exit", () => {
    if (finalized) return;
    try {
      finalizeWorkerRootCleanupAfterLifecycleSync(workerRoot);
      finalized = true;
    } catch (error) {
      failure = toWorkerRootCleanupError(error, workerRoot, 0, Date.now());
      finalized = true;
      reportWorkerRootCleanupFailure(failure);
      process.exitCode = 1;
    }
  });
}

export default function setup(): () => Promise<void> {
  removeLegacyTopLevelHomeRoots();
  // Use a fresh root for each Vitest invocation. A static shared root makes the
  // setup-time redirect sweep proportional to stale directories left by every
  // prior interrupted run.
  const workerRoot = resolve(mkdtempSync(join(tmpdir(), "fusion-test-workers-")));
  try {
    const runToken = process.env[FUSION_TEST_RUN_TOKEN_ENV];
    const tokenLine = runToken && runToken.trim().length > 0 ? `runToken=${runToken}\n` : "";
    writeFileSync(join(workerRoot, WORKER_ROOT_OWNER_FILE), `${process.pid}\n${tokenLine}`);
  } catch {
    // Best effort only. The marker protects active roots from external orphan
    // pruning; FN-6396 adds the runner token so stale pid reuse cannot keep an
    // orphaned root alive. Teardown still owns this root by absolute path.
  }
  process.env.FUSION_TEST_WORKER_ROOT = workerRoot;
  installFinalWorkerRootCleanup(workerRoot);

  return async function teardown() {
    try {
      process.chdir(tmpdir());
    } catch {
      // Ignore — cleanup below is best-effort and uses an absolute path.
    }
    // Do not delete the shared root here. Vitest calls global teardown before
    // it closes the fork pool, so a Windows worker can still have cwd inside it.
    // The final process hook validates worker/child lifecycle records after the
    // pool closes, then performs the bounded native deletion.
    removeLegacyTopLevelHomeRoots();
  };
}
