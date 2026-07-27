#!/usr/bin/env node

import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateLauncherArtifacts } from "./build-info.mjs";

const packageDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(packageDir, "..", "..");
const distEntry = resolve(packageDir, "dist", "bin.js");
const buildInfoPath = resolve(packageDir, "dist", "build-info.json");
const compatibilityMatrixPath = resolve(
  packageDir,
  "dist",
  "compatibility-matrix.json",
);
const execFileAsync = promisify(execFile);

/*
FNXC:CliBuildGeneration 2026-07-27-04:56:
Every committed launcher invocation verifies the bundled bytes and compatibility
matrix before importing bin.js. Source checkouts additionally compare current
HEAD and the source PostgreSQL schema ceiling so stale dist fails before any
command can open a database or load Dashboard/plugin code.
*/
async function readCurrentSourceHead() {
  const override = globalThis.process.env.FUSION_SOURCE_HEAD?.trim();
  if (override) return override;

  try {
    await access(join(workspaceRoot, ".git"), constants.F_OK);
  } catch {
    return undefined;
  }

  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", workspaceRoot, "rev-parse", "HEAD"],
      { encoding: "utf8", timeout: 5_000, windowsHide: true },
    );
    return stdout.trim();
  } catch (error) {
    throw new Error(
      `Fusion CLI dist stale: unable to verify source HEAD for ${workspaceRoot}: `
      + `${error instanceof Error ? error.message : String(error)}.`,
    );
  }
}

async function readCurrentSourceSchemaVersion() {
  const sourcePath = join(
    workspaceRoot,
    "packages",
    "core",
    "src",
    "postgres",
    "schema-applier.ts",
  );
  let source;
  try {
    source = await readFile(sourcePath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  const match = source.match(
    /export\s+const\s+SCHEMA_BASELINE_VERSION\s*=\s*["']([^"']+)["']/,
  );
  if (!match) {
    throw new Error(
      `Fusion CLI dist stale: unable to read the source PostgreSQL schema ceiling from ${sourcePath}.`,
    );
  }
  return match[1];
}

try {
  await access(distEntry, constants.F_OK);
} catch {
  globalThis.console.error(
    `Fusion CLI build output is missing at ${distEntry}. Run \`pnpm build\` before invoking this source checkout.`,
  );
  globalThis.process.exit(1);
}

try {
  const [buildInfoJson, compatibilityMatrixJson, distBytes] = await Promise.all([
    readFile(buildInfoPath, "utf8"),
    readFile(compatibilityMatrixPath, "utf8"),
    readFile(distEntry),
  ]);
  const buildInfo = validateLauncherArtifacts({
    buildInfoJson,
    compatibilityMatrixJson,
    distBytes,
    sourceHead: await readCurrentSourceHead(),
    sourceSchemaVersion: await readCurrentSourceSchemaVersion(),
  });
  globalThis.process.env.FUSION_CLI_DIST_SCHEMA_VERSION = buildInfo.schemaVersion;
  globalThis.process.env.FUSION_CLI_DIST_GENERATION_ID = buildInfo.generationId;
} catch (error) {
  const detail =
    error && typeof error === "object" && "code" in error && error.code === "ENOENT"
      ? `required build metadata is missing (${error.path ?? "unknown path"})`
      : error instanceof Error
        ? error.message
        : String(error);
  globalThis.console.error(
    detail.startsWith("Fusion CLI dist stale:")
      ? detail
      : `Fusion CLI dist stale: ${detail}. Run \`pnpm --filter @runfusion/fusion build\` and retry.`,
  );
  globalThis.process.exit(1);
}

await import(pathToFileURL(distEntry).href);
