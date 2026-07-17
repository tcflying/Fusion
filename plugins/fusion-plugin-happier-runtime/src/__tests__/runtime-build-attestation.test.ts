import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getHappierDirectSessionCapabilities } from "../cli-spawn.js";
import {
  HAPPIER_DIRECT_SESSION_CAPABILITY_FINGERPRINT,
  HAPPIER_DIRECT_SESSION_RUNTIME_MANIFEST,
  verifyHappierDirectSessionRuntimeBuild,
  type HappierDirectSessionRuntimeBuildPin,
} from "../happier-direct-session-capabilities.js";

const temporaryDirectories: string[] = [];
const configuredHappierEntrypoint = process.env.FUSION_HAPPIER_ENTRYPOINT?.trim() || null;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    force: true,
    recursive: true,
  })));
});

function sha256(bytes: Uint8Array | string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "fusion-happier-attestation-"));
  temporaryDirectories.push(root);
  const packageDist = join(root, "apps", "cli", "package-dist");
  await mkdir(packageDist, { recursive: true });
  const entrypoint = join(packageDist, "index.mjs");
  const runtimeArtifact = join(packageDist, "index-certified.mjs");
  const entrypointBytes = "import './index-certified.mjs';\n";
  const runtimeBytes = "export const directSessionCapabilities = true;\n";
  await writeFile(entrypoint, entrypointBytes);
  await writeFile(runtimeArtifact, runtimeBytes);
  const pin: HappierDirectSessionRuntimeBuildPin = {
    pinId: "test-package-dist-v1",
    entrypointSha256: sha256(entrypointBytes),
    runtimeArtifactSha256: sha256(runtimeBytes),
  };
  const observed = {
    ...HAPPIER_DIRECT_SESSION_RUNTIME_MANIFEST,
    fingerprint: HAPPIER_DIRECT_SESSION_CAPABILITY_FINGERPRINT,
    fingerprintScope: "capability_manifest",
    cliVersion: "0.2.10",
    runtimeArtifact: {
      path: runtimeArtifact,
      sha256: pin.runtimeArtifactSha256,
    },
    attestation: {
      schemaVersion: 1,
      trustModel: "self_reported_local_process",
      buildAttestation: {
        kind: "loaded_module_file_sha256",
        hashScope: "file_bytes",
      },
      gitProvenance: { status: "not_attested" },
      liveProviderCertification: { status: "not_certified" },
    },
  } as const;
  return { entrypoint, entrypointBytes, observed, pin, runtimeArtifact, runtimeBytes };
}

describe("Happier Direct Session runtime build attestation", () => {
  it("independently binds an explicit package-dist entrypoint and loaded command chunk", async () => {
    const value = await fixture();

    await expect(verifyHappierDirectSessionRuntimeBuild(
      value.observed,
      value.entrypoint,
      { pins: [value.pin] },
    )).resolves.toMatchObject({
      ok: true,
      pinId: value.pin.pinId,
      entrypointSha256: value.pin.entrypointSha256,
      runtimeArtifactSha256: value.pin.runtimeArtifactSha256,
      trustLevel: "local_artifact_hash_only",
      launchDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
  });

  it("fails closed for PATH launch, dynamic launchers, backup trees, and outside chunks", async () => {
    const value = await fixture();
    const outsideChunk = join(tmpdir(), "index-outside.mjs");
    const backupEntrypoint = value.entrypoint.replace("package-dist", ".dist.hstack-backup");
    const dynamicLauncher = value.entrypoint.replace("package-dist\\index.mjs", "bin\\happier.mjs")
      .replace("package-dist/index.mjs", "bin/happier.mjs");

    await expect(verifyHappierDirectSessionRuntimeBuild(value.observed, undefined, { pins: [value.pin] }))
      .resolves.toMatchObject({ ok: false, reasonCode: "cli_path_unbound" });
    await expect(verifyHappierDirectSessionRuntimeBuild(value.observed, "happier", { pins: [value.pin] }))
      .resolves.toMatchObject({ ok: false, reasonCode: "cli_path_forbidden" });
    await expect(verifyHappierDirectSessionRuntimeBuild(value.observed, dynamicLauncher, { pins: [value.pin] }))
      .resolves.toMatchObject({ ok: false, reasonCode: "cli_path_forbidden" });
    await expect(verifyHappierDirectSessionRuntimeBuild(value.observed, backupEntrypoint, { pins: [value.pin] }))
      .resolves.toMatchObject({ ok: false, reasonCode: "cli_path_forbidden" });
    await expect(verifyHappierDirectSessionRuntimeBuild({
      ...value.observed,
      runtimeArtifact: { ...value.observed.runtimeArtifact, path: outsideChunk },
    }, value.entrypoint, { pins: [value.pin] }))
      .resolves.toMatchObject({ ok: false, reasonCode: "cli_path_forbidden" });
  });

  it("does not trust a self-reported hash or an unpinned local build", async () => {
    const value = await fixture();

    await expect(verifyHappierDirectSessionRuntimeBuild({
      ...value.observed,
      runtimeArtifact: {
        ...value.observed.runtimeArtifact,
        sha256: `sha256:${"0".repeat(64)}`,
      },
    }, value.entrypoint, { pins: [value.pin] }))
      .resolves.toMatchObject({ ok: false, reasonCode: "cli_artifact_mismatch" });

    await expect(verifyHappierDirectSessionRuntimeBuild(value.observed, value.entrypoint, {
      pins: [{
        ...value.pin,
        entrypointSha256: `sha256:${"1".repeat(64)}`,
      }],
    })).resolves.toMatchObject({ ok: false, reasonCode: "cli_artifact_unpinned" });
  });

  it("rejects malformed trust metadata even when file hashes match", async () => {
    const value = await fixture();

    await expect(verifyHappierDirectSessionRuntimeBuild({
      ...value.observed,
      attestation: {
        ...value.observed.attestation,
        gitProvenance: { status: "attested" },
      },
    }, value.entrypoint, { pins: [value.pin] }))
      .resolves.toMatchObject({ ok: false, reasonCode: "cli_capabilities_invalid" });
  });

  const localBuildConformance = configuredHappierEntrypoint ? it : it.skip;
  localBuildConformance(
    "executes and independently verifies the explicitly configured local Happier package-dist build",
    async () => {
      const observed = await getHappierDirectSessionCapabilities({
        executable: process.execPath,
        entrypoint: configuredHappierEntrypoint!,
        timeoutMs: 30_000,
      });

      await expect(verifyHappierDirectSessionRuntimeBuild(
        observed,
        configuredHappierEntrypoint!,
      )).resolves.toMatchObject({
        ok: true,
        pinId: "happier-cli-0.2.10-package-dist-2026-07-17.1",
        entrypointSha256: "sha256:293d55ba1267cf8a297fd641887538ae43726f4b23fc9ce6ad2d9db212c95f2d",
        runtimeArtifactSha256: "sha256:13a3a35835359949c119d8e3c11800cd949aa4877075ced5603948333bcce6b6",
        trustLevel: "local_artifact_hash_only",
      });
    },
  );
});
