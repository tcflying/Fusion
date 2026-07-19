import { describe, expect, it, vi } from "vitest";

import {
  SESSION_CONNECTOR_CAPABILITIES,
  type RecordRoomCapabilityRegistryInputV1,
  type RecordRoomCapabilityRegistryResultV1,
  type RoomBindingRecordV1,
  type SessionConnectorCapabilitiesV1,
  type SessionConnectorCapabilityName,
  type SessionConnectorCapabilityState,
  type SessionConnectorHealthV1,
  type SessionConnectorIdentityV1,
} from "@fusion/core";
import {
  reportRoomConnectorRuntimeObservation,
  type ControlledRoomConnectorRuntimeObservationPortV1,
  type RoomConnectorRuntimeKnownV1,
  type RoomConnectorRuntimeObservationInputV1,
  type RoomConnectorRuntimeObservationV1,
} from "../room-connector-runtime-observation-reporter.js";
import type { RoomCapabilityRegistryWriterPortV1 } from "../room-capability-registry-updater.js";

const AS_OF = "2026-07-19T12:00:00.000Z";
const OBSERVED_AT = "2026-07-19T11:59:45.000Z";
const CAPTURED_AT = "2026-07-19T11:59:50.000Z";
const EXPIRES_AT = "2026-07-19T12:01:00.000Z";

const IDENTITY = {
  connectorId: "happier",
  providerId: "codex",
  nativeSessionId: "codex-thread-1",
  happierSessionId: "happier-session-1",
  serverProfileId: "server-profile-1",
  machineId: "windows-machine-1",
  hostId: "windows-host-1",
} as const satisfies SessionConnectorIdentityV1;

function capabilityStates(
  state: SessionConnectorCapabilityState = "verified",
): SessionConnectorCapabilitiesV1["capabilities"] {
  return Object.fromEntries(SESSION_CONNECTOR_CAPABILITIES.map((capability) => [capability, {
    state,
    evidenceRef: state === "verified" ? "evidence://connector/" + capability : null,
    reasonCode: state === "verified" ? null : "runtime_degraded",
    lastVerifiedAt: state === "verified" ? OBSERVED_AT : null,
  }])) as SessionConnectorCapabilitiesV1["capabilities"];
}

function healthCapabilities(
  state: SessionConnectorCapabilityState = "verified",
): Readonly<Record<SessionConnectorCapabilityName, SessionConnectorCapabilityState>> {
  return Object.fromEntries(
    SESSION_CONNECTOR_CAPABILITIES.map((capability) => [capability, state]),
  ) as Readonly<Record<SessionConnectorCapabilityName, SessionConnectorCapabilityState>>;
}

function binding(): RoomBindingRecordV1 {
  return {
    contractVersion: 1,
    id: "binding-1",
    roomId: "room-1",
    seatId: "seat-1",
    generation: 2,
    connectorId: IDENTITY.connectorId,
    providerId: IDENTITY.providerId,
    nativeSessionId: IDENTITY.nativeSessionId,
    happierSessionId: IDENTITY.happierSessionId,
    serverProfileId: IDENTITY.serverProfileId,
    machineId: IDENTITY.machineId,
    hostId: IDENTITY.hostId,
    state: "attached",
    attachedAt: OBSERVED_AT,
    detachedAt: null,
    replacedByBindingId: null,
  };
}

function known<T>(value: T): RoomConnectorRuntimeKnownV1<T> {
  return {
    state: "known",
    source: "controlled_connector_runtime_observation_port",
    observedAt: OBSERVED_AT,
    value,
  };
}

function runtimeObservation(): RoomConnectorRuntimeObservationV1 {
  return {
    contractVersion: 1,
    source: "controlled_connector_runtime_observation_port",
    projectId: "project-1",
    roomId: "room-1",
    bindingId: "binding-1",
    identity: IDENTITY,
    snapshot: known({
      snapshotId: "runtime-capability-snapshot-1",
      revision: 4,
      capturedAt: CAPTURED_AT,
      expiresAt: EXPIRES_AT,
    }),
    connectorEvidence: known({ availability: "available" }),
    capabilities: known({
      contractVersion: 1,
      connectorId: IDENTITY.connectorId,
      connectorVersion: "0.2.73",
      sourceRevision: "happier-runtime-revision-1",
      verifiedAt: OBSERVED_AT,
      capabilities: capabilityStates(),
    } satisfies SessionConnectorCapabilitiesV1),
    health: known({
      connectorId: IDENTITY.connectorId,
      hostId: IDENTITY.hostId,
      state: "healthy",
      checkedAt: OBSERVED_AT,
      authentication: "authenticated",
      daemon: "running",
      server: "reachable",
      backend: "ready",
      rateLimit: "clear",
      host: "reachable",
      capabilities: healthCapabilities(),
      reasonCodes: [],
      retryAfterMs: null,
    } satisfies SessionConnectorHealthV1),
    model: known({
      providerId: IDENTITY.providerId,
      accountId: "account-1",
      modelId: "gpt-5.6-codex",
    }),
    tools: known([{
      name: "terminal",
      state: "verified",
      evidenceRef: "evidence://tool/terminal",
    }]),
    mcps: known([{
      name: "filesystem",
      state: "verified",
      evidenceRef: "evidence://mcp/filesystem",
    }]),
    skills: known([{
      name: "typescript",
      state: "verified",
      evidenceRef: "evidence://skill/typescript",
    }]),
    context: known({
      contextVersion: "context-v2",
      maximumTokens: 128_000,
      availableTokens: 64_000,
    }),
    workspaceAuthority: known({
      workspaceId: "workspace-1",
      scopes: ["read", "write"],
      state: "verified",
    }),
    latency: known({ p50Ms: 250, p95Ms: 900, sampleCount: 12 }),
    rateLimit: known({ state: "clear", retryAfterMs: null }),
    domainQuality: known([{
      domain: "code",
      independentEvidence: [{
        sourceId: "gate:build-17",
        kind: "deterministic_gate",
        score: 0.9,
        observedAt: OBSERVED_AT,
      }],
    }]),
    calibration: known([{
      domain: "code",
      outcomeCount: 20,
      meanAbsoluteError: 0.1,
    }]),
  };
}

function input(): RoomConnectorRuntimeObservationInputV1 {
  return {
    contractVersion: 1,
    asOf: AS_OF,
    reportFreshness: {
      maxObservationAgeMs: 120_000,
      maxFutureSkewMs: 5_000,
    },
    target: {
      projectId: "project-1",
      roomId: "room-1",
      binding: binding(),
    },
    registryUpdate: {
      expectedAggregateVersion: 7,
      expectedRegistryRevision: 3,
      roomWorkerFence: {
        leaseId: "room-worker-lease-1",
        holderId: "controller-1",
        hostId: IDENTITY.hostId,
        expectedEpoch: 4,
      },
      idempotencyKey: "runtime-capability-report-1",
      freshness: {
        maxSnapshotAgeMs: 120_000,
        maxSignalAgeMs: 120_000,
        maxFutureSkewMs: 5_000,
      },
    },
  };
}

function writerDouble() {
  const recordRoomCapabilityRegistry = vi.fn(
    async (_input: RecordRoomCapabilityRegistryInputV1): Promise<RecordRoomCapabilityRegistryResultV1> => (
      { replayed: false } as RecordRoomCapabilityRegistryResultV1
    ),
  );
  return {
    writer: { recordRoomCapabilityRegistry } satisfies RoomCapabilityRegistryWriterPortV1,
    recordRoomCapabilityRegistry,
  };
}

function runtimePort(observation: RoomConnectorRuntimeObservationV1) {
  const observe = vi.fn(async () => observation);
  return {
    port: { observe } satisfies ControlledRoomConnectorRuntimeObservationPortV1,
    observe,
  };
}

describe("Room connector runtime observation reporter", () => {
  it("converts a controlled concrete binding observation into the existing durable capability-registry update", async () => {
    const { writer, recordRoomCapabilityRegistry } = writerDouble();
    const { port, observe } = runtimePort(runtimeObservation());

    const result = await reportRoomConnectorRuntimeObservation(input(), port, writer);

    expect(result).toMatchObject({ ok: true, outcome: "reported", scheduling: "schedulable" });
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "project-1",
      roomId: "room-1",
      binding: expect.objectContaining({ id: "binding-1" }),
      asOf: AS_OF,
    }));
    expect(recordRoomCapabilityRegistry).toHaveBeenCalledWith(expect.objectContaining({
      roomId: "room-1",
      expectedAggregateVersion: 7,
      idempotencyKey: "runtime-capability-report-1",
      samples: [expect.objectContaining({
        lineage: expect.objectContaining({
          bindingId: "binding-1",
          modelId: "gpt-5.6-codex",
        }),
        rateLimit: expect.objectContaining({ state: "clear" }),
      })],
    }));
  });

  it("fails closed with explicit unknown fields instead of inventing context or latency", async () => {
    const { writer, recordRoomCapabilityRegistry } = writerDouble();
    const observation = runtimeObservation();
    const { port } = runtimePort({
      ...observation,
      context: {
        state: "unknown",
        source: "controlled_connector_runtime_observation_port",
        observedAt: OBSERVED_AT,
        reason: "not_collected",
      },
      latency: {
        state: "unknown",
        source: "controlled_connector_runtime_observation_port",
        observedAt: OBSERVED_AT,
        reason: "not_supported",
      },
    });

    const result = await reportRoomConnectorRuntimeObservation(input(), port, writer);

    expect(result).toMatchObject({
      ok: false,
      outcome: "withheld",
      scheduling: "not_schedulable",
      reason: { code: "runtime_observation_unknown" },
      unknown: [
        { field: "context", reason: "not_collected" },
        { field: "latency", reason: "not_supported" },
      ],
    });
    expect(recordRoomCapabilityRegistry).not.toHaveBeenCalled();
  });

  it("rejects a controlled port result outside the requested project, Room, or binding before durable reporting", async () => {
    const { writer, recordRoomCapabilityRegistry } = writerDouble();
    const observation = runtimeObservation();
    const { port } = runtimePort({ ...observation, roomId: "room-other" });

    const result = await reportRoomConnectorRuntimeObservation(input(), port, writer);

    expect(result).toMatchObject({
      ok: false,
      outcome: "withheld",
      reason: { code: "runtime_scope_mismatch" },
    });
    expect(recordRoomCapabilityRegistry).not.toHaveBeenCalled();
  });

  it("rejects model self-reported quality rather than presenting it as independent runtime evidence", async () => {
    const { writer, recordRoomCapabilityRegistry } = writerDouble();
    const observation = runtimeObservation();
    const unsafeQuality = [{
      domain: "code",
      selfReportedScore: 0.99,
      independentEvidence: [],
    }];
    const { port } = runtimePort({
      ...observation,
      domainQuality: known(unsafeQuality) as RoomConnectorRuntimeObservationV1["domainQuality"],
    });

    const result = await reportRoomConnectorRuntimeObservation(input(), port, writer);

    expect(result).toMatchObject({
      ok: false,
      outcome: "withheld",
      reason: { code: "model_self_report_rejected" },
    });
    expect(recordRoomCapabilityRegistry).not.toHaveBeenCalled();
  });

  it("rejects a rate-limit claim that contradicts the controlled connector health observation", async () => {
    const { writer, recordRoomCapabilityRegistry } = writerDouble();
    const observation = runtimeObservation();
    const { port } = runtimePort({
      ...observation,
      rateLimit: known({ state: "limited", retryAfterMs: 60_000 }),
    });

    const result = await reportRoomConnectorRuntimeObservation(input(), port, writer);

    expect(result).toMatchObject({
      ok: false,
      outcome: "withheld",
      reason: { code: "rate_limit_mismatch" },
    });
    expect(recordRoomCapabilityRegistry).not.toHaveBeenCalled();
  });
});
