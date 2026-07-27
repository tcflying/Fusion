import { createHash } from "node:crypto";
import {
  lstat,
  readFile,
  readdir,
  readlink,
  writeFile,
} from "node:fs/promises";
import { join, relative, sep } from "node:path";

/*
FNXC:CliBuildGeneration 2026-07-27-04:56:
The committed launcher and build pipeline share one dependency-free freshness
contract so a source checkout cannot execute CLI bytes from another source HEAD.
*/

/**
 * @param {{
 *   buildInfo: {
 *     sourceHead: string;
 *     schemaVersion: string;
 *     cliDistSha256: string;
 *     compatibilityMatrixSha256: string;
 *   };
 *   actualDistSha256: string;
 *   actualCompatibilityMatrixSha256: string;
 *   sourceHead?: string;
 *   sourceSchemaVersion?: string;
 * }} input
 * @returns {{ ok: true } | { ok: false; reason: string }}
 */
export function assessDistFreshness(input) {
  if (input.sourceHead && input.sourceHead !== input.buildInfo.sourceHead) {
    return {
      ok: false,
      reason:
        `Fusion CLI dist stale: source HEAD ${input.sourceHead} does not match `
        + `dist build-info HEAD ${input.buildInfo.sourceHead}.`,
    };
  }

  if (
    input.sourceSchemaVersion
    && input.sourceSchemaVersion !== input.buildInfo.schemaVersion
  ) {
    return {
      ok: false,
      reason:
        `Fusion CLI dist stale: source schema ${input.sourceSchemaVersion} does not match `
        + `dist build-info schema ${input.buildInfo.schemaVersion}.`,
    };
  }

  if (input.actualDistSha256 !== input.buildInfo.cliDistSha256) {
    return {
      ok: false,
      reason: "Fusion CLI dist stale: dist/bin.js SHA-256 does not match dist/build-info.json.",
    };
  }

  if (
    input.actualCompatibilityMatrixSha256
    !== input.buildInfo.compatibilityMatrixSha256
  ) {
    return {
      ok: false,
      reason:
        "Fusion CLI dist stale: dist/compatibility-matrix.json SHA-256 does not match "
        + "dist/build-info.json.",
    };
  }

  return { ok: true };
}

/**
 * Validate the exact bytes the committed launcher is about to execute.
 * @param {{
 *   buildInfoJson: string;
 *   compatibilityMatrixJson: string;
 *   distBytes: Buffer;
 *   sourceHead?: string;
 *   sourceSchemaVersion?: string;
 * }} input
 */
export function validateLauncherArtifacts(input) {
  const buildInfo = JSON.parse(input.buildInfoJson);
  const compatibilityMatrix = JSON.parse(input.compatibilityMatrixJson);
  const freshness = assessDistFreshness({
    buildInfo,
    actualDistSha256: sha256(input.distBytes),
    actualCompatibilityMatrixSha256: sha256(input.compatibilityMatrixJson),
    sourceHead: input.sourceHead,
    sourceSchemaVersion: input.sourceSchemaVersion,
  });
  if (freshness.ok === false) {
    throw new Error(freshness.reason);
  }
  if (compatibilityMatrix.generationId !== buildInfo.generationId) {
    throw new Error(
      "Fusion CLI dist stale: build-info and compatibility matrix generation IDs differ.",
    );
  }
  if (compatibilityMatrix.sourceHead !== buildInfo.sourceHead) {
    throw new Error(
      "Fusion CLI dist stale: compatibility matrix source HEAD does not match "
      + "build-info source HEAD.",
    );
  }
  const matrixSchemaVersion = compatibilityMatrix.components?.schema?.version;
  if (matrixSchemaVersion !== buildInfo.schemaVersion) {
    throw new Error(
      `Fusion CLI dist stale: compatibility matrix schema ${matrixSchemaVersion ?? "missing"} `
      + `does not match build-info schema ${buildInfo.schemaVersion}.`,
    );
  }
  const matrixCliVersion = compatibilityMatrix.components?.cli?.version;
  if (matrixCliVersion !== buildInfo.cliVersion) {
    throw new Error(
      `Fusion CLI dist stale: compatibility matrix CLI ${matrixCliVersion ?? "missing"} `
      + `does not match build-info CLI ${buildInfo.cliVersion}.`,
    );
  }
  if (compatibilityMatrix.components?.cli?.sha256 !== buildInfo.cliDistSha256) {
    throw new Error(
      "Fusion CLI dist stale: compatibility matrix CLI SHA-256 does not match "
      + "build-info CLI SHA-256.",
    );
  }
  return buildInfo;
}

/** @param {string | Buffer} value */
export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** @param {string} path */
export async function sha256File(path) {
  return sha256(await readFile(path));
}

/**
 * Hash a directory as a stable sequence of relative paths, file bytes, and
 * symlink targets. This attests packaged bytes rather than host timestamps.
 * @param {string} root
 */
export async function sha256Tree(root) {
  const hash = createHash("sha256");

  /** @param {string} current */
  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const path = join(current, entry.name);
      const relativePath = relative(root, path).split(sep).join("/");
      if (entry.isDirectory()) {
        hash.update(`D\0${relativePath}\0`);
        await visit(path);
        continue;
      }
      if (entry.isSymbolicLink()) {
        hash.update(`L\0${relativePath}\0${await readlink(path)}\0`);
        continue;
      }
      if (entry.isFile()) {
        hash.update(`F\0${relativePath}\0`);
        hash.update(await readFile(path));
        hash.update("\0");
      }
    }
  }

  await visit(root);
  return hash.digest("hex");
}

/** @param {string} path */
async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

/** @param {string} path */
async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/**
 * Write the build-info and release compatibility matrix consumed by bin.mjs.
 *
 * @param {{
 *   cliRoot: string;
 *   workspaceRoot: string;
 *   sourceHead: string;
 *   schemaVersion: string;
 *   packagingMode: "fast" | "full";
 *   pluginIds: readonly string[];
 *   builtAt?: string;
 * }} input
 */
export async function writeBuildGenerationArtifacts(input) {
  const distRoot = join(input.cliRoot, "dist");
  const cliPackage = await readJson(join(input.cliRoot, "package.json"));
  const dashboardPackage = await readJson(
    join(input.workspaceRoot, "packages", "dashboard", "package.json"),
  );
  const cliEntryPath = join(distRoot, "bin.js");
  const dashboardPath = join(distRoot, "client");
  const migrationsPath = join(distRoot, "migrations");
  const cliDistSha256 = await sha256File(cliEntryPath);

  if (!(await pathExists(migrationsPath))) {
    throw new Error(
      `Cannot write Fusion build-info: PostgreSQL migrations are missing at ${migrationsPath}.`,
    );
  }

  const dashboardDirectoryPresent = await pathExists(dashboardPath);
  const dashboardIndexPath = join(dashboardPath, "index.html");
  const dashboardIncluded = dashboardDirectoryPresent
    && await pathExists(dashboardIndexPath);
  if (input.packagingMode === "full" && !dashboardIncluded) {
    throw new Error(
      `Cannot write full Fusion compatibility matrix: Dashboard entrypoint is missing at ${dashboardIndexPath}.`,
    );
  }
  const dashboardIsStub = dashboardIncluded
    && (await readFile(dashboardIndexPath, "utf8")).includes(
      "Dashboard assets not built",
    );
  if (input.packagingMode === "full" && dashboardIsStub) {
    throw new Error(
      "Cannot write full Fusion compatibility matrix: Dashboard assets are a build stub.",
    );
  }
  /*
  FNXC:CliBuildGeneration 2026-07-27-06:02:
  Dashboard's Vite build writes <short HEAD>-<content hash> to version.json.
  A full package must prove those assets came from this source generation,
  rather than merely hashing a stale dist/client left by an earlier build.
  */
  const dashboardVersionPath = join(dashboardPath, "version.json");
  const dashboardBuildVersion = dashboardDirectoryPresent
    && await pathExists(dashboardVersionPath)
    ? String((await readJson(dashboardVersionPath)).version ?? "").trim() || null
    : null;
  if (input.packagingMode === "full" && !dashboardBuildVersion) {
    throw new Error(
      "Cannot write full Fusion compatibility matrix: Dashboard build version is missing.",
    );
  }
  const dashboardSourcePrefix = dashboardBuildVersion?.split("-", 1)[0] ?? "";
  if (
    input.packagingMode === "full"
    && (
      dashboardSourcePrefix.length < 7
      || !input.sourceHead.startsWith(dashboardSourcePrefix)
    )
  ) {
    throw new Error(
      `Cannot write full Fusion compatibility matrix: Dashboard build ${dashboardBuildVersion} `
      + `does not match source HEAD ${input.sourceHead}.`,
    );
  }

  const plugins = [];
  for (const pluginId of [...input.pluginIds].sort()) {
    const stagedPath = join(distRoot, "plugins", pluginId);
    const included = input.packagingMode === "full" && await pathExists(stagedPath);
    if (input.packagingMode === "full" && !included) {
      throw new Error(
        `Cannot write full Fusion compatibility matrix: plugin ${pluginId} is missing at ${stagedPath}.`,
      );
    }

    const sourceManifestPath = join(
      input.workspaceRoot,
      "plugins",
      pluginId,
      "manifest.json",
    );
    const manifestPath = included
      ? join(stagedPath, "manifest.json")
      : sourceManifestPath;
    const manifest = await readJson(manifestPath);
    plugins.push({
      id: pluginId,
      version: String(manifest.version ?? "unknown"),
      included,
      path: included ? `dist/plugins/${pluginId}` : null,
      sha256: included ? await sha256Tree(stagedPath) : null,
    });
  }

  const components = {
    cli: {
      package: String(cliPackage.name),
      version: String(cliPackage.version),
      path: "dist/bin.js",
      sha256: cliDistSha256,
    },
    dashboard: {
      package: String(dashboardPackage.name),
      version: String(dashboardPackage.version),
      included: dashboardIncluded,
      buildVersion: dashboardBuildVersion,
      assetMode: dashboardIncluded
        ? dashboardIsStub
          ? "stub"
          : "built"
        : dashboardDirectoryPresent
          ? "incomplete"
          : "missing",
      path: dashboardIncluded ? "dist/client" : null,
      sha256: dashboardIncluded ? await sha256Tree(dashboardPath) : null,
    },
    schema: {
      version: input.schemaVersion,
      path: "dist/migrations",
      sha256: await sha256Tree(migrationsPath),
    },
    plugins,
  };
  const generationMaterial = JSON.stringify({
    formatVersion: 1,
    sourceHead: input.sourceHead,
    packagingMode: input.packagingMode,
    components,
  });
  const generationId = `sha256:${sha256(generationMaterial)}`;
  const compatibilityMatrix = {
    formatVersion: 1,
    generationId,
    sourceHead: input.sourceHead,
    packagingMode: input.packagingMode,
    components,
  };
  const compatibilityMatrixJson = `${JSON.stringify(compatibilityMatrix, null, 2)}\n`;
  const compatibilityMatrixPath = join(distRoot, "compatibility-matrix.json");
  await writeFile(compatibilityMatrixPath, compatibilityMatrixJson, "utf8");
  const compatibilityMatrixSha256 = sha256(compatibilityMatrixJson);

  const buildInfo = {
    formatVersion: 1,
    generationId,
    sourceHead: input.sourceHead,
    schemaVersion: input.schemaVersion,
    cliVersion: String(cliPackage.version),
    cliDistSha256,
    compatibilityMatrixSha256,
    builtAt: input.builtAt ?? new Date().toISOString(),
  };
  const buildInfoPath = join(distRoot, "build-info.json");
  await writeFile(buildInfoPath, `${JSON.stringify(buildInfo, null, 2)}\n`, "utf8");

  const validation = assessDistFreshness({
    buildInfo,
    actualDistSha256: await sha256File(cliEntryPath),
    actualCompatibilityMatrixSha256: await sha256File(compatibilityMatrixPath),
    sourceHead: input.sourceHead,
    sourceSchemaVersion: input.schemaVersion,
  });
  if (validation.ok === false) {
    throw new Error(validation.reason);
  }

  return { buildInfo, compatibilityMatrix };
}
