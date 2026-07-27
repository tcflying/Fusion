import { describe, expect, it } from "vitest";

import { buildHappierRuntimeSetupStatus } from "../happier-runtime-setup-adapter.js";

describe("buildHappierRuntimeSetupStatus", () => {
  it("projects typed health into verified bindings while keeping discoveries as explicit unbound candidates", () => {
    const status = buildHappierRuntimeSetupStatus({
      settings: {
        backend: "codex",
        executable: process.execPath,
        entrypoint: "G:\\vendor\\happier\\apps\\cli\\package-dist\\index.mjs",
        activeServerId: "server-main",
        serverUrl: "http://127.0.0.1:52211",
        allowedCliRoots: ["G:\\vendor\\happier"],
        happierSessionBindings: [{
          canonicalSessionUri: "codex://threads/native-1",
          happierSessionId: "happy-1",
          serverProfileId: "server-main",
          machineId: "machine-a",
        }],
      },
      runtimeHealth: {
        discovered: true,
        executable: true,
        server: true,
        serverState: "reachable",
        authenticated: true,
        daemon: true,
        backend: true,
        ready: true,
        backendId: "codex",
        modelId: null,
        modelState: "not_reported",
        attestation: {
          ok: true,
          trustLevel: "local_custom_pinned_source_build",
          sourceRoot: "G:\\vendor\\happier",
          entrypointPath: "G:\\vendor\\happier\\apps\\cli\\package-dist\\index.mjs",
          cliVersion: "0.2.10",
          sourceCommit: "6e059c41d865343c1efc9c98676e5af3882d85ff",
          entrypointSha256: "sha256:8ad722284c12ca87c946f3a94b66b14f5640bf768e719c8791b1cb0234312786",
          verifiedAt: "2026-07-27T08:00:00.000Z",
          evidence: {
            version: "cli_--version",
            package: "package_json",
            source: "git_head",
            artifact: "sha256_file_bytes",
          },
        },
        details: [],
      },
      connectorHealth: {
        connectorId: "happier",
        hostId: "fusion-dashboard",
        state: "healthy",
        checkedAt: "2026-07-27T08:00:01.000Z",
        authentication: "authenticated",
        daemon: "running",
        server: "reachable",
        backend: "ready",
        rateLimit: "unknown",
        host: "reachable",
        capabilities: {
          ensureExisting: "verified",
          create: "unavailable",
          status: "verified",
          history: "verified",
          events: "unavailable",
          send: "verified",
          interrupt: "verified",
          resume: "unavailable",
          takeover: "unavailable",
          health: "verified",
          deepLinks: "verified",
        },
        reasonCodes: [],
        retryAfterMs: null,
      },
      capabilityEvidence: [{
        canonicalSessionUri: "codex://threads/native-1",
        providerId: "codex",
        happierSessionId: "happy-1",
        serverProfileId: "server-main",
        machineId: "machine-a",
        state: "available",
        toolNames: ["session_control", "session_status"],
        sampledAt: "2026-07-27T08:00:01.000Z",
        latencyMs: 14,
      }],
      nativeDiscovery: {
        state: "available",
        candidates: [
          {
            canonicalSessionUri: "codex://threads/native-1",
            providerId: "codex",
            nativeSessionId: "native-1",
            sourceSessionId: "cli-1",
          },
          {
            canonicalSessionUri: "codex://threads/native-2",
            providerId: "codex",
            nativeSessionId: "native-2",
            sourceSessionId: "cli-2",
          },
        ],
      },
      happierDiscovery: {
        state: "available",
        candidates: [
          { happierSessionId: "happy-1", updatedAt: 10, active: true },
          { happierSessionId: "happy-2", updatedAt: 9, active: false },
        ],
      },
    });

    expect(status.failClosed).toBe(false);
    expect(status.server).toMatchObject({
      activeServerId: "server-main",
      serverUrl: "http://127.0.0.1:52211",
    });
    expect(status.cli.attestation).toMatchObject({
      ok: true,
      cliVersion: "0.2.10",
      sourceCommit: "6e059c41d865343c1efc9c98676e5af3882d85ff",
    });
    expect(status.compatibility.happierCliSemver).toBe("0.2.10");
    expect(status.bindings).toEqual([
      expect.objectContaining({
        canonicalSessionUri: "codex://threads/native-1",
        happierSessionId: "happy-1",
        providerId: "codex",
        nativeSessionId: "native-1",
        state: "verified",
        driftReasons: [],
        machineAvailability: "verified",
        probeEvidence: expect.objectContaining({ state: "available", latencyMs: 14 }),
      }),
    ]);
    expect(status.discovery.nativeCandidates).toEqual([
      expect.objectContaining({ nativeSessionId: "native-1", bindingState: "bound" }),
      expect.objectContaining({ nativeSessionId: "native-2", bindingState: "unbound" }),
    ]);
    expect(status.discovery.happierCandidates).toEqual([
      expect.objectContaining({ happierSessionId: "happy-1", bindingState: "bound" }),
      expect.objectContaining({ happierSessionId: "happy-2", bindingState: "unbound" }),
    ]);
  });

  it("surfaces order-independent binding conflicts and marks every discovery as unsafe", () => {
    const status = buildHappierRuntimeSetupStatus({
      settings: {
        backend: "codex",
        activeServerId: "server-main",
        happierSessionBindings: [
          {
            canonicalSessionUri: "codex://threads/native-1",
            happierSessionId: "happy-1",
            serverProfileId: "server-main",
            machineId: "machine-a",
          },
          {
            canonicalSessionUri: "codex://threads/native-1",
            happierSessionId: "happy-2",
            serverProfileId: "server-main",
            machineId: "machine-a",
          },
        ],
      },
      runtimeHealth: {
        discovered: false,
        executable: false,
        server: false,
        serverState: "not-probed",
        authenticated: false,
        daemon: false,
        backend: false,
        ready: false,
        backendId: "codex",
        modelId: null,
        modelState: "not_reported",
        attestation: { ok: false, reasonCode: "cli_entrypoint_unbound" },
        details: ["cli-attestation-failed"],
      },
      connectorHealth: null,
      connectorReadError: "conflicting bindings",
      capabilityEvidence: [],
      nativeDiscovery: {
        state: "available",
        candidates: [{
          canonicalSessionUri: "codex://threads/native-1",
          providerId: "codex",
          nativeSessionId: "native-1",
          sourceSessionId: "cli-1",
        }],
      },
      happierDiscovery: {
        state: "available",
        candidates: [
          { happierSessionId: "happy-1", updatedAt: 10 },
          { happierSessionId: "happy-2", updatedAt: 9 },
        ],
      },
    });

    expect(status.failClosed).toBe(true);
    expect(status.bindings).toEqual([]);
    expect(status.conflicts).toContain(
      "Happier binding conflict for canonical Session codex://threads/native-1",
    );
    expect(status.discovery.nativeCandidates[0]?.bindingState).toBe("conflict");
    expect(status.discovery.happierCandidates.every((candidate) =>
      candidate.bindingState === "conflict")).toBe(true);
  });

  it("reports known-missing identities and unavailable probes as two-way drift", () => {
    const status = buildHappierRuntimeSetupStatus({
      settings: {
        backend: "codex",
        activeServerId: "server-main",
        happierSessionBindings: [{
          canonicalSessionUri: "codex://threads/native-1",
          happierSessionId: "happy-1",
          serverProfileId: "server-main",
          machineId: "machine-a",
        }],
      },
      runtimeHealth: {
        discovered: true,
        executable: true,
        server: false,
        serverState: "unreachable",
        authenticated: true,
        daemon: true,
        backend: true,
        ready: false,
        backendId: "codex",
        modelId: null,
        modelState: "not_reported",
        attestation: { ok: false, reasonCode: "cli_artifact_hash_mismatch" },
        details: ["server-unreachable"],
      },
      connectorHealth: null,
      connectorReadError: "probe unavailable",
      capabilityEvidence: [{
        canonicalSessionUri: "codex://threads/native-1",
        providerId: "codex",
        happierSessionId: "happy-1",
        serverProfileId: "server-main",
        machineId: "machine-a",
        state: "unavailable",
        toolNames: [],
        sampledAt: "2026-07-27T08:00:01.000Z",
        latencyMs: 20,
      }],
      nativeDiscovery: { state: "available", candidates: [] },
      happierDiscovery: { state: "available", candidates: [] },
    });

    expect(status.failClosed).toBe(true);
    expect(status.bindings[0]).toMatchObject({
      state: "drift",
      machineAvailability: "unverified",
      driftReasons: [
        "native-session-missing",
        "happier-session-missing",
        "probe-unavailable",
      ],
    });
  });
});
