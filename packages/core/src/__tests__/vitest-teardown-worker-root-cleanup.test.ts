import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { __fusionWorkerRootCleanupTestHooks } from "../__test-utils__/vitest-setup";
import setup, {
  __setWorkerRootRmSyncForTests,
  finalizeWorkerRootCleanup,
  removeWorkerRootWithRetry,
  removeLegacyTopLevelHomeRoots,
} from "../__test-utils__/vitest-teardown";

const createdPaths: string[] = [];
const originalWorkerRoot = process.env.FUSION_TEST_WORKER_ROOT;
const originalProcessExitCode = process.exitCode;

function remember(path: string): string {
  createdPaths.push(path);
  return path;
}

function makeWorkerChild(root: string, label: string): void {
  const workerDir = join(root, `w-${process.pid}-${label}`);
  mkdirSync(workerDir, { recursive: true });
  writeFileSync(join(workerDir, "file.txt"), "worker temp payload");
}

function restoreWorkerRootEnv(): void {
  if (originalWorkerRoot === undefined) {
    delete process.env.FUSION_TEST_WORKER_ROOT;
  } else {
    process.env.FUSION_TEST_WORKER_ROOT = originalWorkerRoot;
  }
}

afterEach(() => {
  __setWorkerRootRmSyncForTests(rmSync);
  process.exitCode = originalProcessExitCode;
  restoreWorkerRootEnv();
  for (const path of createdPaths.splice(0).reverse()) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("vitest global teardown worker-root cleanup", () => {
  it("removes the per-invocation worker root after deferred finalization", async () => {
    const teardown = setup();
    const workerRoot = remember(process.env.FUSION_TEST_WORKER_ROOT!);
    makeWorkerChild(workerRoot, "clean");

    await teardown();

    expect(existsSync(workerRoot)).toBe(true);
    finalizeWorkerRootCleanup(workerRoot);

    expect(existsSync(workerRoot)).toBe(false);
  });

  it("uses only bounded native retries once the worker lifecycle is settled", async () => {
    const teardown = setup();
    const workerRoot = remember(process.env.FUSION_TEST_WORKER_ROOT!);
    makeWorkerChild(workerRoot, "busy");
    let observedOptions: Parameters<typeof rmSync>[1] | undefined;

    __setWorkerRootRmSyncForTests((path, options) => {
      observedOptions = options;
      rmSync(path, options);
    });

    await teardown();
    finalizeWorkerRootCleanup(workerRoot);

    expect(observedOptions).toMatchObject({
      recursive: true,
      force: true,
      maxRetries: process.platform === "win32" ? 2 : 0,
      retryDelay: process.platform === "win32" ? 25 : 0,
    });
    expect(existsSync(workerRoot)).toBe(false);
  });

  it("tolerates ENOENT when the worker root is already gone", async () => {
    const teardown = setup();
    const workerRoot = remember(process.env.FUSION_TEST_WORKER_ROOT!);
    makeWorkerChild(workerRoot, "enoent");
    rmSync(workerRoot, { recursive: true, force: true });

    await teardown();

    finalizeWorkerRootCleanup(workerRoot);
    expect(existsSync(workerRoot)).toBe(false);
  });

  it("defers shared-root removal until worker lifecycle records are cleared", async () => {
    const teardown = setup();
    const workerRoot = remember(process.env.FUSION_TEST_WORKER_ROOT!);
    const lifecycleDir = join(workerRoot, ".fusion-test-worker-lifecycle");
    const lifecycleRecord = join(lifecycleDir, `worker-${process.pid}.json`);
    const childLifecycleRecord = join(lifecycleDir, `child-${process.pid}.json`);
    mkdirSync(lifecycleDir, { recursive: true });
    writeFileSync(lifecycleRecord, JSON.stringify({ pid: process.pid, kind: "worker" }));
    writeFileSync(childLifecycleRecord, JSON.stringify({ pid: process.pid, kind: "child" }));

    await teardown();

    expect(existsSync(workerRoot)).toBe(true);

    rmSync(lifecycleRecord, { force: true });
    let lifecycleFailure: unknown;
    try {
      finalizeWorkerRootCleanup(workerRoot);
    } catch (error) {
      lifecycleFailure = error;
    }
    expect(lifecycleFailure).toMatchObject({
      code: "EBUSY",
      path: workerRoot,
      syscall: "worker-lifecycle",
    });
    expect(existsSync(workerRoot)).toBe(true);

    rmSync(childLifecycleRecord, { force: true });
    finalizeWorkerRootCleanup(workerRoot);
    expect(existsSync(workerRoot)).toBe(false);
  });

  it.runIf(process.platform === "win32")(
    "reports a final EPERM worker-root cleanup failure with structured native-retry evidence",
    () => {
      const workerRoot = remember(mkdtempSync(join(tmpdir(), "fusion-test-workers-eperm-")));
      makeWorkerChild(workerRoot, "eperm");
      let observedOptions: Parameters<typeof rmSync>[1] | undefined;
      __setWorkerRootRmSyncForTests((_path, options) => {
        observedOptions = options;
        const error = Object.assign(new Error("access denied"), {
          code: "EPERM",
          path: workerRoot,
          syscall: "rmdir",
        }) as NodeJS.ErrnoException;
        throw error;
      });

      let failure: unknown;
      try {
        removeWorkerRootWithRetry(workerRoot);
      } catch (error) {
        failure = error;
      }

      expect(failure).toMatchObject({
        code: "EPERM",
        path: workerRoot,
        syscall: "rmdir",
        attempts: 1,
        elapsedMs: expect.any(Number),
        nativeMaxRetries: 2,
      });
      expect(observedOptions).toMatchObject({
        recursive: true,
        force: true,
        maxRetries: 2,
        retryDelay: 25,
      });
    },
  );

  it("sweeps legacy top-level temp HOME roots without walking unrelated temp entries", () => {
    const tempRoot = remember(mkdtempSync(join(tmpdir(), "fusion-test-home-sweep-root-")));
    const legacyHome = join(tempRoot, "fn-test-home-stale");
    const unrelated = join(tempRoot, "fusion-test-workers-current");
    mkdirSync(legacyHome, { recursive: true });
    mkdirSync(unrelated, { recursive: true });
    writeFileSync(join(legacyHome, "payload.txt"), "legacy home state");

    removeLegacyTopLevelHomeRoots(tempRoot);

    expect(existsSync(legacyHome)).toBe(false);
    expect(existsSync(unrelated)).toBe(true);
  });

  it("removes a self-minted fallback worker root during exit cleanup", () => {
    const workerRoot = remember(mkdtempSync(join(tmpdir(), "fusion-test-workers-self-minted-")));
    const workerDir = join(workerRoot, `w-${process.pid}-fallback`);
    const redirDir = join(workerRoot, `redir-${process.pid}`);
    mkdirSync(workerDir, { recursive: true });
    mkdirSync(redirDir, { recursive: true });
    writeFileSync(join(workerDir, "payload.txt"), "worker temp payload");
    writeFileSync(join(redirDir, "payload.txt"), "redirect temp payload");
    __fusionWorkerRootCleanupTestHooks.writeWorkerRootOwnerMarker(workerRoot);

    __fusionWorkerRootCleanupTestHooks.removeSelfMintedWorkerRootWithRetry(workerRoot, true);

    expect(existsSync(workerRoot)).toBe(false);
  });
});
