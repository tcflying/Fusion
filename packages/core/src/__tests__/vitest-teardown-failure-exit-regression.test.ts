import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const fixtureDirectory = fileURLToPath(new URL("./fixtures/vitest-teardown-persistent-eperm/", import.meta.url));
const fixtureConfig = fileURLToPath(new URL("./fixtures/vitest-teardown-persistent-eperm/vitest.config.ts", import.meta.url));
const vitestEntrypoint = fileURLToPath(new URL("../../node_modules/vitest/vitest.mjs", import.meta.url));
const fixtureRoots: string[] = [];

function rememberFixtureRoot(path: string): string {
  fixtureRoots.push(path);
  return path;
}

function assertPathIsInsideFixtureRoot(path: string, fixtureRoot: string): void {
  const resolvedFixtureRoot = resolve(fixtureRoot);
  const resolvedPath = resolve(path);
  const pathFromFixtureRoot = relative(resolvedFixtureRoot, resolvedPath);

  expect(pathFromFixtureRoot).not.toBe("");
  expect(pathFromFixtureRoot.startsWith("..")).toBe(false);
  expect(isAbsolute(pathFromFixtureRoot)).toBe(false);
}

afterEach(() => {
  for (const fixtureRoot of fixtureRoots.splice(0).reverse()) {
    // FNXC:TestIsolation 2026-07-19-21:15: This regression may remove only the mkdtemp root it created; a persistent EPERM fixture must never target a real temp directory.
    rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 0 });
  }
});

describe("vitest global teardown persistent-EPERM exit regression", () => {
  it("exits nonzero after an otherwise passing child test and still removes its legacy HOME", () => {
    const fixtureRoot = rememberFixtureRoot(mkdtempSync(join(tmpdir(), "fusion-vitest-teardown-eperm-")));
    const passMarker = join(fixtureRoot, "ordinary-test-passed.txt");
    const legacyPathMarker = join(fixtureRoot, "legacy-home-path.txt");
    const workerRootMarker = join(fixtureRoot, "worker-root-path.txt");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      FUSION_VITEST_TEARDOWN_FIXTURE_ROOT: fixtureRoot,
      FUSION_VITEST_TEARDOWN_PASS_MARKER: passMarker,
      FUSION_VITEST_TEARDOWN_LEGACY_PATH_MARKER: legacyPathMarker,
      FUSION_VITEST_TEARDOWN_WORKER_ROOT_MARKER: workerRootMarker,
      TEMP: fixtureRoot,
      TMP: fixtureRoot,
      TMPDIR: fixtureRoot,
    };
    delete env.FUSION_TEST_WORKER_ROOT;

    const result = spawnSync(
      process.execPath,
      [
        vitestEntrypoint,
        "run",
        "--config",
        fixtureConfig,
        "--pool=forks",
        "--maxWorkers=1",
        "--no-file-parallelism",
        "--silent=passed-only",
        "--reporter=dot",
      ],
      {
        cwd: fixtureDirectory,
        encoding: "utf8",
        env,
        timeout: 15_000,
        windowsHide: true,
      },
    );
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    const workerRoot = readFileSync(workerRootMarker, "utf8").trim();
    const legacyHome = readFileSync(legacyPathMarker, "utf8").trim();

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(readFileSync(passMarker, "utf8")).toBe("ordinary test executed\n");
    expect(output).toContain("[vitest-teardown] worker-root cleanup failed");
    expect(output).toContain('"code":"EPERM"');

    assertPathIsInsideFixtureRoot(workerRoot, fixtureRoot);
    assertPathIsInsideFixtureRoot(legacyHome, fixtureRoot);
    expect(basename(workerRoot)).toMatch(/^fusion-test-workers-/);
    expect(basename(legacyHome)).toMatch(/^fn-test-home-/);
    expect(existsSync(workerRoot)).toBe(true);
    expect(existsSync(legacyHome)).toBe(false);
  });
});
