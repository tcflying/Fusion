import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  verifyHappierCliAttestation,
} from "../cli-attestation.js";
import * as directSessionCapabilities from "../happier-direct-session-capabilities.js";
import { verifyHappierDirectSessionRuntimeBuild } from "../happier-direct-session-capabilities.js";
import { probeHappierRuntime } from "../probe.js";

const configuredHappierEntrypoint = process.env.FUSION_HAPPIER_ENTRYPOINT?.trim() || null;
const configuredHappierSessionId = process.env.FUSION_HAPPIER_TEST_SESSION_ID?.trim() || null;
const configuredCanonicalSessionUri = process.env.FUSION_HAPPIER_TEST_CANONICAL_URI?.trim() || null;
const configuredHappierHomeDir = process.env.FUSION_HAPPIER_TEST_HOME_DIR?.trim() || null;
const configuredHappierServerId = process.env.FUSION_HAPPIER_TEST_SERVER_ID?.trim() || null;
const configuredHappierServerUrl = process.env.FUSION_HAPPIER_TEST_SERVER_URL?.trim() || null;
const configuredHappierWebappUrl = process.env.FUSION_HAPPIER_TEST_WEBAPP_URL?.trim() || null;

describe("Happier Direct Session runtime build attestation", () => {
  it("reuses the canonical CLI attestation function and owns no compatibility pin", () => {
    expect(verifyHappierDirectSessionRuntimeBuild).toBe(verifyHappierCliAttestation);
    expect(directSessionCapabilities).not.toHaveProperty("HAPPIER_DIRECT_SESSION_RUNTIME_BUILD_PIN");
    expect(directSessionCapabilities).not.toHaveProperty("HAPPIER_DIRECT_SESSION_RUNTIME_BUILD_PINS");
  });

  const localBuildConformance = configuredHappierEntrypoint ? it : it.skip;
  localBuildConformance(
    "attests the current Happier 0.2.10 package-dist CLI without a legacy direct-session command",
    async () => {
      const sourceRoot = resolve(dirname(configuredHappierEntrypoint!), "..", "..", "..");
      const observed = await verifyHappierDirectSessionRuntimeBuild({
        executable: process.execPath,
        entrypoint: configuredHappierEntrypoint!,
        allowedCliRoots: [sourceRoot],
        spawnTimeoutMs: 30_000,
      });

      expect(observed).toMatchObject({
        ok: true,
        trustLevel: "local_custom_pinned_source_build",
        sourceRoot,
        entrypointPath: configuredHappierEntrypoint,
        cliVersion: "0.2.10",
        sourceCommit: "6e059c41d865343c1efc9c98676e5af3882d85ff",
        entrypointSha256: "sha256:8ad722284c12ca87c946f3a94b66b14f5640bf768e719c8791b1cb0234312786",
        evidence: {
          version: "cli_--version",
          package: "package_json",
          source: "git_head",
          artifact: "sha256_file_bytes",
        },
      });
    },
  );

  const liveHealthConformance = configuredHappierEntrypoint
    && configuredHappierSessionId
    && configuredCanonicalSessionUri
    && configuredHappierHomeDir
    && configuredHappierServerId
    && configuredHappierServerUrl
    && configuredHappierWebappUrl
    ? it
    : it.skip;
  liveHealthConformance(
    "reads current Happier 0.2.10 bound-session backend/model health without overstating readiness",
    async () => {
      const sourceRoot = resolve(dirname(configuredHappierEntrypoint!), "..", "..", "..");
      const health = await probeHappierRuntime({
        executable: process.execPath,
        entrypoint: configuredHappierEntrypoint!,
        allowedCliRoots: [sourceRoot],
        homeDir: configuredHappierHomeDir!,
        activeServerId: configuredHappierServerId!,
        serverUrl: configuredHappierServerUrl!,
        publicServerUrl: configuredHappierServerUrl!,
        webappUrl: configuredHappierWebappUrl!,
        backend: "codex",
        happierSessionBindings: [{
          canonicalSessionUri: configuredCanonicalSessionUri!,
          happierSessionId: configuredHappierSessionId!,
          serverProfileId: configuredHappierServerId!,
          machineId: "live-conformance",
        }],
        spawnTimeoutMs: 30_000,
        timeoutMs: 90_000,
      });

      expect(health.details, JSON.stringify(health)).toContain("model-not-reported");
      expect(health).toMatchObject({
        executable: true,
        server: true,
        authenticated: true,
        daemon: true,
        backendId: "codex",
        backend: true,
        modelId: null,
        modelState: "not_reported",
        ready: false,
      });
    },
    300_000,
  );
});
