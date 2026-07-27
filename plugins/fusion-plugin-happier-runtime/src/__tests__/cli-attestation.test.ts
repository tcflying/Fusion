import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  verifyHappierCliAttestation,
  type HappierCliCompatibilityPin,
} from "../cli-attestation.js";

const temporaryDirectories: string[] = [];
const liveEntrypoint = process.env.FUSION_HAPPIER_ENTRYPOINT?.trim() || null;
const liveSourceRoot = process.env.FUSION_HAPPIER_SOURCE_ROOT?.trim() || null;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    force: true,
    recursive: true,
  })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "fusion-happier-cli-attestation-"));
  temporaryDirectories.push(root);
  const packageDirectory = join(root, "apps", "cli");
  const packageDist = join(packageDirectory, "package-dist");
  await mkdir(packageDist, { recursive: true });
  const entrypoint = join(packageDist, "index.mjs");
  const entrypointBytes = "console.log('0.2.10');\n";
  await writeFile(entrypoint, entrypointBytes);
  await writeFile(join(packageDirectory, "package.json"), JSON.stringify({
    name: "@happier-dev/cli",
    version: "0.2.10",
    repository: "happier-dev/happier",
  }));
  const pin: HappierCliCompatibilityPin = {
    cliVersion: "0.2.10",
    sourceCommit: "6e059c41d865343c1efc9c98676e5af3882d85ff",
    entrypointSha256: `sha256:${createHash("sha256").update(entrypointBytes).digest("hex")}`,
  };
  const dependencies = {
    probeVersion: async () => "0.2.10",
    readSourceCommit: async () => pin.sourceCommit,
  };
  return { dependencies, entrypoint, pin, root };
}

async function worktreeFixture() {
  const value = await fixture();
  const commonGitDirectory = join(value.root, "git-common");
  const worktreeGitDirectory = join(commonGitDirectory, "worktrees", "attested");
  const ref = "refs/heads/codex/attested";
  await mkdir(join(commonGitDirectory, "refs", "heads", "codex"), { recursive: true });
  await mkdir(worktreeGitDirectory, { recursive: true });
  await writeFile(join(value.root, ".git"), `gitdir: ${worktreeGitDirectory}\n`);
  await writeFile(join(worktreeGitDirectory, "HEAD"), `ref: ${ref}\n`);
  await writeFile(join(worktreeGitDirectory, "commondir"), "../..\n");
  await writeFile(join(commonGitDirectory, ref), `${value.pin.sourceCommit}\n`);
  return value;
}

describe("verifyHappierCliAttestation", () => {
  const liveConformance = liveEntrypoint && liveSourceRoot ? it : it.skip;

  liveConformance("attests the configured local Happier source build without starting a service", async () => {
    await expect(verifyHappierCliAttestation({
      executable: process.execPath,
      entrypoint: liveEntrypoint!,
      allowedCliRoots: [liveSourceRoot!],
    })).resolves.toMatchObject({
      ok: true,
      trustLevel: "local_custom_pinned_source_build",
      entrypointPath: liveEntrypoint,
      sourceRoot: liveSourceRoot,
    });
  });

  it("binds the real package-dist entrypoint to an allowed source root, package, version, commit, and hash", async () => {
    const value = await fixture();

    await expect(verifyHappierCliAttestation({
      executable: process.execPath,
      entrypoint: value.entrypoint,
      allowedCliRoots: [value.root],
    }, {
      pin: value.pin,
      ...value.dependencies,
      now: () => "2026-07-27T04:05:00.000Z",
    })).resolves.toMatchObject({
      ok: true,
      trustLevel: "local_custom_pinned_source_build",
      cliVersion: "0.2.10",
      sourceCommit: value.pin.sourceCommit,
      entrypointSha256: value.pin.entrypointSha256,
      verifiedAt: "2026-07-27T04:05:00.000Z",
      evidence: {
        version: "cli_--version",
        package: "package_json",
        source: "git_head",
        artifact: "sha256_file_bytes",
      },
    });
  });

  it("attests a Git worktree whose branch ref remains loose in the common Git directory", async () => {
    const value = await worktreeFixture();

    await expect(verifyHappierCliAttestation({
      executable: process.execPath,
      entrypoint: value.entrypoint,
      allowedCliRoots: [value.root],
    }, {
      pin: value.pin,
      probeVersion: async () => "0.2.10",
    })).resolves.toMatchObject({
      ok: true,
      sourceCommit: value.pin.sourceCommit,
    });
  });

  it("fails closed for an unbound root, a backup tree, a wrong worktree, and hash drift", async () => {
    const value = await fixture();
    const settings = {
      executable: process.execPath,
      entrypoint: value.entrypoint,
      allowedCliRoots: [] as string[],
    };

    await expect(verifyHappierCliAttestation(settings, {
      pin: value.pin,
      ...value.dependencies,
    })).resolves.toMatchObject({ ok: false, reasonCode: "cli_allow_root_unbound" });

    const backupRoot = `${value.root}-backup`;
    await expect(verifyHappierCliAttestation({
      ...settings,
      allowedCliRoots: [backupRoot],
    }, {
      pin: value.pin,
      ...value.dependencies,
    })).resolves.toMatchObject({ ok: false, reasonCode: "cli_path_outside_allow_root" });

    await expect(verifyHappierCliAttestation({
      ...settings,
      allowedCliRoots: [value.root],
    }, {
      pin: value.pin,
      ...value.dependencies,
      readSourceCommit: async () => "1111111111111111111111111111111111111111",
    })).resolves.toMatchObject({ ok: false, reasonCode: "cli_source_commit_mismatch" });

    await writeFile(value.entrypoint, "console.log('drift');\n");
    await expect(verifyHappierCliAttestation({
      ...settings,
      allowedCliRoots: [value.root],
    }, {
      pin: value.pin,
      ...value.dependencies,
    })).resolves.toMatchObject({ ok: false, reasonCode: "cli_artifact_hash_mismatch" });
  });

  it("rejects package or reported CLI version drift independently of the file hash", async () => {
    const value = await fixture();
    const settings = {
      executable: process.execPath,
      entrypoint: value.entrypoint,
      allowedCliRoots: [value.root],
    };

    await expect(verifyHappierCliAttestation(settings, {
      pin: value.pin,
      ...value.dependencies,
      probeVersion: async () => "0.2.11",
    })).resolves.toMatchObject({ ok: false, reasonCode: "cli_reported_version_mismatch" });

    await writeFile(join(value.root, "apps", "cli", "package.json"), JSON.stringify({
      name: "@happier-dev/cli",
      version: "0.2.11",
      repository: "happier-dev/happier",
    }));
    await expect(verifyHappierCliAttestation(settings, {
      pin: value.pin,
      ...value.dependencies,
    })).resolves.toMatchObject({ ok: false, reasonCode: "cli_package_mismatch" });
  });
});
