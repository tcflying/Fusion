/**
 * Vitest globalSetup hook.
 *
 * We publish a per-invocation worker-root env var. Teardown removes that private
 * root after the project finishes so workspace isolation checks do not report
 * the run-local worker/home directories as leaks.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
  const finalize = () => {
    if (finalized) {
      if (failure) throw failure;
      return;
    }
    finalized = true;
    try {
      finalizeWorkerRootCleanup(workerRoot);
    } catch (error) {
      failure = toWorkerRootCleanupError(error, workerRoot, 0, Date.now());
      throw failure;
    }
  };

  // `beforeExit` runs after Vitest has closed its pool during normal CLI exit.
  // Keep the `exit` fallback for runners that call process.exit() directly.
  process.once("beforeExit", () => {
    try {
      finalize();
    } catch (error) {
      reportWorkerRootCleanupFailure(error);
      process.exitCode = 1;
    }
  });
  process.once("exit", () => {
    if (finalized) return;
    try {
      finalize();
    } catch (error) {
      reportWorkerRootCleanupFailure(error);
      process.exitCode = 1;
      throw error;
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
