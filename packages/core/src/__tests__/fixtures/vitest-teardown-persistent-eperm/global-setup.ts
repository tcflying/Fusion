import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import setup, {
  __setWorkerRootRmSyncForTests,
} from "../../../__test-utils__/vitest-teardown.js";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name} for the persistent-EPERM fixture.`);
  return value;
}

function assertPathIsInsideFixtureRoot(path: string, fixtureRoot: string): string {
  const resolvedFixtureRoot = resolve(fixtureRoot);
  const resolvedPath = resolve(path);
  const pathFromFixtureRoot = relative(resolvedFixtureRoot, resolvedPath);
  if (
    pathFromFixtureRoot.length === 0 ||
    pathFromFixtureRoot.startsWith("..") ||
    isAbsolute(pathFromFixtureRoot)
  ) {
    throw new Error(`Fixture path escaped its temporary root: ${resolvedPath}`);
  }
  return resolvedPath;
}

export default function setupPersistentEpermFixture(): () => Promise<void> {
  const fixtureRoot = resolve(requireEnv("FUSION_VITEST_TEARDOWN_FIXTURE_ROOT"));
  if (resolve(tmpdir()) !== fixtureRoot) {
    throw new Error("Persistent-EPERM fixture requires TEMP/TMP/TMPDIR to resolve to its temporary root.");
  }

  const teardown = setup();
  const workerRoot = assertPathIsInsideFixtureRoot(
    requireEnv("FUSION_TEST_WORKER_ROOT"),
    fixtureRoot,
  );
  if (!basename(workerRoot).startsWith("fusion-test-workers-")) {
    throw new Error(`Fixture refused non-worker-root target: ${workerRoot}`);
  }

  const legacyHome = assertPathIsInsideFixtureRoot(
    join(fixtureRoot, `fn-test-home-persistent-eperm-${process.pid}`),
    fixtureRoot,
  );
  mkdirSync(legacyHome, { recursive: true });
  writeFileSync(join(legacyHome, "fixture.txt"), "legacy HOME must be swept after teardown failure\n");
  writeFileSync(requireEnv("FUSION_VITEST_TEARDOWN_LEGACY_PATH_MARKER"), `${legacyHome}\n`);
  writeFileSync(requireEnv("FUSION_VITEST_TEARDOWN_WORKER_ROOT_MARKER"), `${workerRoot}\n`);

  /*
  FNXC:TestIsolation 2026-07-19-21:15:
  This nested Vitest fixture injects EPERM only for its freshly minted worker root under a parent-created temp root.
  It exercises the real global teardown/CLI exit path while keeping legacy fn-test-home cleanup live and safely scoped.

  FNXC:TestIsolation 2026-07-19-22:22:
  The rmSync seam accepts Node PathLike values, so narrow to the teardown's absolute string path before matching the protected worker root.
  */
  __setWorkerRootRmSyncForTests((path, options) => {
    if (typeof path === "string" && path === workerRoot) {
      const error = new Error("simulated persistent EPERM") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    }
    rmSync(path, options);
  });

  return async () => {
    await teardown();
  };
}
