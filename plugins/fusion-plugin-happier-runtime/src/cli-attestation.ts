import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

import { buildHappierProcessEnv, resolveHappierCliSettings } from "./cli-spawn.js";
import { terminateHappierProcessTree } from "./process-lifecycle.js";
import { HAPPIER_SESSION_CONNECTOR_VERSION } from "./session-connector-contract.js";
import type { HappierCliSettings } from "./types.js";

export interface HappierCliCompatibilityPin {
  readonly cliVersion: string;
  readonly sourceCommit: string;
  readonly entrypointSha256: `sha256:${string}`;
}

export const HAPPIER_RUNTIME_COMPATIBILITY = Object.freeze({
  pluginVersion: HAPPIER_SESSION_CONNECTOR_VERSION,
  fusionSemver: ">=0.74.0-beta.3 <0.75.0",
  happierCliSemver: "0.2.10",
  happierSourceCommit: "f7a07c6f31694e0d435448b560f3386e1743c7e9",
  officialProtocolContract: "sessionControl/v1@6e059c41d865343c1efc9c98676e5af3882d85ff",
  entrypointRelativePath: "apps/cli/package-dist/index.mjs",
  entrypointSha256: "sha256:10fa0e53fe3f1c712b71bf75882ea80fe5801d6a31ac11449f4ab7b49d3752c0",
} as const);

export const HAPPIER_CLI_COMPATIBILITY_PIN: HappierCliCompatibilityPin = Object.freeze({
  cliVersion: HAPPIER_RUNTIME_COMPATIBILITY.happierCliSemver,
  sourceCommit: HAPPIER_RUNTIME_COMPATIBILITY.happierSourceCommit,
  entrypointSha256: HAPPIER_RUNTIME_COMPATIBILITY.entrypointSha256,
});

export type HappierCliAttestationFailureReason =
  | "cli_entrypoint_unbound"
  | "cli_allow_root_unbound"
  | "cli_executable_unpinned"
  | "cli_path_forbidden"
  | "cli_path_outside_allow_root"
  | "cli_package_mismatch"
  | "cli_reported_version_mismatch"
  | "cli_source_commit_mismatch"
  | "cli_artifact_hash_mismatch"
  | "cli_version_probe_failed";

export type HappierCliAttestation =
  | Readonly<{
    ok: true;
    trustLevel: "local_custom_pinned_source_build";
    sourceRoot: string;
    entrypointPath: string;
    cliVersion: string;
    sourceCommit: string;
    entrypointSha256: `sha256:${string}`;
    verifiedAt: string;
    evidence: Readonly<{
      version: "cli_--version";
      package: "package_json";
      source: "git_head";
      artifact: "sha256_file_bytes";
    }>;
  }>
  | Readonly<{
    ok: false;
    reasonCode: HappierCliAttestationFailureReason;
  }>;

interface HappierCliAttestationDependencies {
  readonly pin?: HappierCliCompatibilityPin;
  readonly probeVersion?: (
    settings: HappierCliSettings,
    canonicalEntrypoint: string,
  ) => Promise<string>;
  readonly readSourceCommit?: (sourceRoot: string) => Promise<string>;
  readonly now?: () => string;
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
    : left === right;
}

function isInside(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function parseVersion(raw: string): string | null {
  const match = raw.trim().match(/(?:^|\s)v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s|$)/u);
  return match?.[1] ?? null;
}

async function defaultProbeVersion(
  settings: HappierCliSettings,
  canonicalEntrypoint: string,
): Promise<string> {
  const resolvedSettings = resolveHappierCliSettings(settings);
  return await new Promise((resolveVersion, reject) => {
    let settled = false;
    let stdout = "";
    const child = spawn(process.execPath, [canonicalEntrypoint, "--version"], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      env: buildHappierProcessEnv(resolvedSettings),
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void terminateHappierProcessTree(child);
      reject(new Error("Happier CLI version probe timed out"));
    }, resolvedSettings.spawnTimeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length <= 4_096) stdout += chunk;
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error("Happier CLI version probe failed"));
        return;
      }
      resolveVersion(stdout);
    });
  });
}

async function resolveGitDirectory(sourceRoot: string): Promise<string> {
  const dotGit = join(sourceRoot, ".git");
  const info = await lstat(dotGit);
  if (info.isDirectory()) return dotGit;
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("invalid .git path");
  const pointer = (await readFile(dotGit, "utf8")).trim().match(/^gitdir:\s*(.+)$/u)?.[1];
  if (!pointer) throw new Error("invalid .git pointer");
  return resolve(sourceRoot, pointer);
}

async function resolveGitMetadataDirectories(gitDirectory: string): Promise<string[]> {
  const candidates = [gitDirectory];
  try {
    const common = (await readFile(join(gitDirectory, "commondir"), "utf8")).trim();
    if (common) candidates.push(resolve(gitDirectory, common));
  } catch {
    // A normal repository has no commondir file.
  }
  return candidates;
}

async function readLooseRef(gitDirectory: string, ref: string): Promise<string | null> {
  for (const directory of await resolveGitMetadataDirectories(gitDirectory)) {
    try {
      const value = (await readFile(join(directory, ref), "utf8")).trim();
      if (/^[a-f0-9]{40}$/u.test(value)) return value;
    } catch {
      // The ref may instead be packed or absent from this metadata directory.
    }
  }
  return null;
}

async function readPackedRef(gitDirectory: string, ref: string): Promise<string | null> {
  for (const directory of await resolveGitMetadataDirectories(gitDirectory)) {
    try {
      const lines = (await readFile(join(directory, "packed-refs"), "utf8")).split(/\r?\n/u);
      const match = lines.find((line) => line.endsWith(` ${ref}`));
      if (match) return match.slice(0, 40);
    } catch {
      // Keep looking through the remaining Git metadata locations.
    }
  }
  return null;
}

async function defaultReadSourceCommit(sourceRoot: string): Promise<string> {
  const gitDirectory = await resolveGitDirectory(sourceRoot);
  const head = (await readFile(join(gitDirectory, "HEAD"), "utf8")).trim();
  if (/^[a-f0-9]{40}$/u.test(head)) return head;
  const ref = head.match(/^ref:\s*(refs\/.+)$/u)?.[1];
  if (!ref) throw new Error("invalid Git HEAD");
  const loose = await readLooseRef(gitDirectory, ref);
  if (loose) return loose;
  const packed = await readPackedRef(gitDirectory, ref);
  if (packed) return packed;
  throw new Error("Git HEAD ref is unavailable");
}

/**
 * FNXC:HappierCliSupplyChain 2026-07-27-04:07:
 * Every production probe or operation is bound to one realpath-contained
 * source checkout and independently checked against the CLI package version,
 * source commit, process-reported version, and package-dist file bytes.
 */
export async function verifyHappierCliAttestation(
  settings: HappierCliSettings,
  dependencies: HappierCliAttestationDependencies = {},
): Promise<HappierCliAttestation> {
  const entrypoint = settings.entrypoint?.trim();
  if (!entrypoint) return { ok: false, reasonCode: "cli_entrypoint_unbound" };
  const allowRoots = settings.allowedCliRoots?.filter((root) => root.trim()) ?? [];
  if (allowRoots.length === 0) return { ok: false, reasonCode: "cli_allow_root_unbound" };
  if (!isAbsolute(entrypoint) || !samePath(resolve(settings.executable ?? ""), resolve(process.execPath))) {
    return { ok: false, reasonCode: "cli_executable_unpinned" };
  }

  const pin = dependencies.pin ?? HAPPIER_CLI_COMPATIBILITY_PIN;
  try {
    const info = await lstat(entrypoint);
    if (!info.isFile() || info.isSymbolicLink()) return { ok: false, reasonCode: "cli_path_forbidden" };
    const canonicalEntrypoint = await realpath(entrypoint);
    const canonicalRoots: string[] = [];
    for (const root of allowRoots) {
      if (!isAbsolute(root)) continue;
      try {
        canonicalRoots.push(await realpath(root));
      } catch {
        // A missing configured root is not authority for any executable.
      }
    }
    const sourceRoot = canonicalRoots.find((root) => isInside(root, canonicalEntrypoint));
    if (!sourceRoot) return { ok: false, reasonCode: "cli_path_outside_allow_root" };
    const relativeEntrypoint = relative(sourceRoot, canonicalEntrypoint).replaceAll("\\", "/");
    if (relativeEntrypoint !== HAPPIER_RUNTIME_COMPATIBILITY.entrypointRelativePath) {
      return { ok: false, reasonCode: "cli_path_forbidden" };
    }

    const packagePath = join(dirname(dirname(canonicalEntrypoint)), "package.json");
    const packageRecord = JSON.parse(await readFile(packagePath, "utf8")) as Record<string, unknown>;
    if (
      packageRecord.name !== "@happier-dev/cli"
      || packageRecord.version !== pin.cliVersion
      || packageRecord.repository !== "happier-dev/happier"
    ) {
      return { ok: false, reasonCode: "cli_package_mismatch" };
    }

    const entrypointSha256 = sha256(await readFile(canonicalEntrypoint));
    if (entrypointSha256 !== pin.entrypointSha256) {
      return { ok: false, reasonCode: "cli_artifact_hash_mismatch" };
    }
    const sourceCommit = await (dependencies.readSourceCommit ?? defaultReadSourceCommit)(sourceRoot);
    if (sourceCommit !== pin.sourceCommit) {
      return { ok: false, reasonCode: "cli_source_commit_mismatch" };
    }
    let reportedVersion: string | null;
    try {
      reportedVersion = parseVersion(await (dependencies.probeVersion ?? defaultProbeVersion)(
        settings,
        canonicalEntrypoint,
      ));
    } catch {
      return { ok: false, reasonCode: "cli_version_probe_failed" };
    }
    if (reportedVersion !== pin.cliVersion) {
      return { ok: false, reasonCode: "cli_reported_version_mismatch" };
    }
    return Object.freeze({
      ok: true,
      trustLevel: "local_custom_pinned_source_build",
      sourceRoot,
      entrypointPath: canonicalEntrypoint,
      cliVersion: pin.cliVersion,
      sourceCommit,
      entrypointSha256,
      verifiedAt: (dependencies.now ?? (() => new Date().toISOString()))(),
      evidence: Object.freeze({
        version: "cli_--version",
        package: "package_json",
        source: "git_head",
        artifact: "sha256_file_bytes",
      }),
    });
  } catch {
    return { ok: false, reasonCode: "cli_path_forbidden" };
  }
}
