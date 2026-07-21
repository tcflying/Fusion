import { describe, expect, it } from "vitest";

import {
  SESSION_CONNECTOR_CAPABILITIES,
  type RoomBindingRecordV1,
  type SessionConnectorCapabilitiesV1,
  type SessionConnectorCapabilityName,
  type SessionConnectorCapabilityState,
  type SessionConnectorHealthV1,
  type SessionConnectorIdentityV1,
} from "@fusion/core";
import type {
  CreateRoomBindingCapabilityReportInputV1,
  TrustedRoomBindingCapabilityTargetV1,
} from "../room-binding-capability-reporter.js";
import {
  aggregateRoomConnectorCapabilityObservations,
  type RoomConnectorCapabilityObservationAggregationInputV1,
} from "../room-connector-capability-observation-aggregator.js";
import type { RoomCapabilityRegistryUpdateSampleV1 } from "../room-capability-registry-updater.js";

const AS_OF = "2026-07-19T12:00:00.000Z";
const OBSERVED_AT = "2026-07-19T11:59:45.000Z";
const CAPTURED_AT = "2026-07-19T11:59:50.000Z";
const EXPIRES_AT = "2026-07-19T12:01:00.000Z";

function identity(bindingId: string): SessionConnectorIdentityV1 {
  return {
    connectorId: "happier",
    providerId: "codex",
    nativeSessionId: `codex-thread-${bindingId}`,
    happierSessionId: `happier-session-${bindingId}`,
    serverProfileId: "server-profile-1",
    machineId: "machine-1",
    hostId: "windows-host-1",
  };
}

function capabilityStates(
  overrides: Partial<Record<SessionConnectorCapabilityName, SessionConnectorCapabilityState>> = {},
): SessionConnectorCapabilitiesV1["capabilities"] {
  return Object.fromEntries(SESSION_CONNECTOR_CAPABILITIES.map((name) => {
    const state = overrides[name] ?? "verified";
    return [name, {
      state,
      evidenceRef: state === "verified" ? `evidence://connector/${name}` : null,
      reasonCode: state === "verified" ? null : "runtime_degraded",
      lastVerifiedAt: state === "verified" ? OBSERVED_AT : null,
    }];
  })) as SessionConnectorCapabilitiesV1["capabilities"];
}

function healthCapabilities(
  overrides: Partial<Record<SessionConnectorCapabilityName, SessionConnectorCapabilityState>> = {},
): SessionConnectorHealthV1["capabilities"] {
  return Object.fromEntries(
    SESSION_CONNECTOR_CAPABILITIES.map((name) => [name, overrides[name] ?? "verified"]),
  ) as SessionConnectorHealthV1["capabilities"];
}

function binding(bindingId: string): RoomBindingRecordV1 {
  const value = identity(bindingId);
  return {
    contractVersion: 1,
    id: bindingId,
    roomId: "room-1",
    seatId: `seat-${bindingId}`,
    generation: 2,
    connectorId: value.connectorId,
    providerId: value.providerId,
    nativeSessionId: value.nativeSessionId,
    happierSessionId: value.happierSessionId,
    serverProfileId: value.serverProfileId,
    machineId: value.machineId,
    hostId: value.hostId,
    state: "attached",
    attachedAt: OBSERVED_AT,
    detachedAt: null,
    replacedByBindingId: null,
  };
}

function target(bindingId: string): TrustedRoomBindingCapabilityTargetV1 {
  const value = identity(bindingId);
  return {
    projectId: "project-1",
    roomId: "room-1",
    binding: binding(bindingId),
    runtime: {
      source: "trusted_session_connector_binding",
      identity: value,
      accountId: `account-${bindingId}`,
      modelId: "gpt-5.6-codex",
      observedAt: OBSERVED_AT,
    },
  };
}

function report(bindingId: string): CreateRoomBindingCapabilityReportInputV1 {
  const reportTarget = target(bindingId);
  const value = reportTarget.runtime.identity;
  return {
    contractVersion: 1,
    asOf: AS_OF,
    freshness: {
      maxObservationAgeMs: 120_000,
      maxFutureSkewMs: 5_000,
    },
    target: reportTarget,
    observation: {
      source: "trusted_session_connector",
      connectorEvidence: {
        source: "trusted_session_connector",
        availability: "available",
        observedAt: OBSERVED_AT,
      },
      projectId: "project-1",
      roomId: "room-1",
      bindingId,
      snapshotId: `capability-snapshot-${bindingId}`,
      revision: 4,
      capturedAt: CAPTURED_AT,
      expiresAt: EXPIRES_AT,
      identity: value,
      capabilities: {
        contractVersion: 1,
        connectorId: value.connectorId,
        connectorVersion: "0.2.73",
        sourceRevision: "happier-source-revision-1",
        verifiedAt: OBSERVED_AT,
        capabilities: capabilityStates(),
      },
      health: {
        connectorId: value.connectorId,
        hostId: value.hostId,
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
      },
      model: {
        source: "trusted_session_connector",
        providerId: value.providerId,
        accountId: reportTarget.runtime.accountId,
        modelId: reportTarget.runtime.modelId,
        observedAt: OBSERVED_AT,
      },
      tools: [{
        source: "trusted_session_connector",
        name: "terminal",
        state: "verified",
        evidenceRef: "evidence://tool/terminal",
        observedAt: OBSERVED_AT,
      }],
      mcps: [{
        source: "trusted_session_connector",
        name: "filesystem",
        state: "verified",
        evidenceRef: "evidence://mcp/filesystem",
        observedAt: OBSERVED_AT,
      }],
      skills: [{
        source: "trusted_session_connector",
        name: "typescript",
        state: "verified",
        evidenceRef: "evidence://skill/typescript",
        observedAt: OBSERVED_AT,
      }],
      context: {
        source: "trusted_session_connector",
        contextVersion: "context-v2",
        maximumTokens: 128_000,
        availableTokens: 64_000,
        observedAt: OBSERVED_AT,
      },
      workspaceAuthority: {
        source: "trusted_session_connector",
        workspaceId: `workspace-${bindingId}`,
        scopes: ["read", "write"],
        state: "verified",
        observedAt: OBSERVED_AT,
      },
      latency: {
        source: "trusted_session_connector",
        p50Ms: 250,
        p95Ms: 900,
        sampleCount: 12,
        observedAt: OBSERVED_AT,
      },
      domainQuality: [{
        source: "trusted_room_evidence",
        domain: "code",
        selfReportedScore: null,
        independentEvidence: [{
          sourceId: "gate:build-17",
          kind: "deterministic_gate",
          score: 0.9,
          observedAt: OBSERVED_AT,
        }],
      }],
      calibration: [{
        source: "trusted_room_evidence",
        domain: "code",
        outcomeCount: 20,
        meanAbsoluteError: 0.1,
        observedAt: OBSERVED_AT,
      }],
    },
  };
}

function sample(value: CreateRoomBindingCapabilityReportInputV1): RoomCapabilityRegistryUpdateSampleV1 {
  return { source: "trusted_session_connector", report: value };
}

function aggregationInput(
  overrides: Partial<Pick<
    RoomConnectorCapabilityObservationAggregationInputV1,
    "asOf" | "roomBindings" | "activeBindings" | "observations"
  >> = {},
): RoomConnectorCapabilityObservationAggregationInputV1 {
  return {
    contractVersion: 1,
    projectId: "project-1",
    roomId: "room-1",
    asOf: AS_OF,
    reportFreshness: {
      maxObservationAgeMs: 120_000,
      maxFutureSkewMs: 5_000,
    },
    registryUpdate: {
      expectedAggregateVersion: 7,
      expectedRegistryRevision: 3,
      roomWorkerFence: {
        leaseId: "room-worker-lease-1",
        holderId: "controller-1",
        hostId: "windows-host-1",
        expectedEpoch: 4,
      },
      idempotencyKey: "capability-registry-update-1",
      freshness: {
        maxSnapshotAgeMs: 120_000,
        maxSignalAgeMs: 120_000,
        maxFutureSkewMs: 5_000,
      },
    },
    roomBindings: [binding("binding-a"), binding("binding-b")],
    activeBindings: [target("binding-a"), target("binding-b")],
    observations: [sample(report("binding-b")), sample(report("binding-a"))],
    ...overrides,
  };
}

function expectWithheld(
  result: ReturnType<typeof aggregateRoomConnectorCapabilityObservations>,
  code: string,
): void {
  expect(result).toMatchObject({
    ok: false,
    outcome: "withheld",
    scheduling: "not_schedulable",
    update: null,
  });
  if (result.ok) throw new Error("Expected aggregation to withhold the registry update");
  expect(result.issues).toEqual(expect.arrayContaining([
    expect.objectContaining({ code }),
  ]));
}

describe("Room connector capability observation aggregator", () => {
  it("emits one complete deterministic update for two caller-provided concrete active bindings", () => {
    const result = aggregateRoomConnectorCapabilityObservations(aggregationInput());

    expect(result).toMatchObject({
      ok: true,
      outcome: "aggregated",
      scheduling: "schedulable",
      update: {
        projectId: "project-1",
        roomId: "room-1",
        sampledAt: AS_OF,
        expectedAggregateVersion: 7,
        expectedRegistryRevision: 3,
      },
    });
    if (!result.ok) return;
    expect(result.update.samples).toHaveLength(2);
    expect(result.update.samples.map((entry) => entry.report.target.binding.id))
      .toEqual(["binding-a", "binding-b"]);
    expect(Object.isFrozen(result.update)).toBe(true);
  });

  it("keeps a trusted paused binding writable while marking the complete registry not schedulable", () => {
    const pausedBinding = { ...binding("binding-a"), state: "paused" as const };
    const pausedTarget = { ...target("binding-a"), binding: pausedBinding };
    const pausedReport = { ...report("binding-a"), target: pausedTarget };
    const result = aggregateRoomConnectorCapabilityObservations(aggregationInput({
      roomBindings: [pausedBinding, binding("binding-b")],
      activeBindings: [pausedTarget, target("binding-b")],
      observations: [sample(pausedReport), sample(report("binding-b"))],
    }));

    expect(result).toMatchObject({
      ok: true,
      outcome: "aggregated",
      scheduling: "not_schedulable",
      update: { samples: [expect.anything(), expect.anything()] },
    });
  });

  it.each([
    ["unhealthy connector", (value: CreateRoomBindingCapabilityReportInputV1) => ({
      ...value,
      observation: {
        ...value.observation,
        health: { ...value.observation.health, state: "degraded" as const },
      },
    })],
    ["rate-limited connector", (value: CreateRoomBindingCapabilityReportInputV1) => ({
      ...value,
      observation: {
        ...value.observation,
        health: {
          ...value.observation.health,
          state: "rate_limited" as const,
          rateLimit: "limited" as const,
          retryAfterMs: 60_000,
        },
      },
    })],
    ["no verified tool evidence", (value: CreateRoomBindingCapabilityReportInputV1) => ({
      ...value,
      observation: {
        ...value.observation,
        capabilities: {
          ...value.observation.capabilities,
          capabilities: capabilityStates(Object.fromEntries(SESSION_CONNECTOR_CAPABILITIES.map((name) => [name, "unavailable"]))),
        },
        health: {
          ...value.observation.health,
          capabilities: healthCapabilities(Object.fromEntries(SESSION_CONNECTOR_CAPABILITIES.map((name) => [name, "unavailable"]))),
        },
        tools: [],
        mcps: [],
        skills: [],
        workspaceAuthority: { ...value.observation.workspaceAuthority, state: "unverified" as const },
      },
    })],
  ] as const)("keeps trusted %s evidence writable but not schedulable", (_label, mutate) => {
    const changed = structuredClone(report("binding-a")) as CreateRoomBindingCapabilityReportInputV1;
    const changedEvidence = mutate(changed);
    const result = aggregateRoomConnectorCapabilityObservations(aggregationInput({
      observations: [sample(changedEvidence), sample(report("binding-b"))],
    }));

    expect(result).toMatchObject({
      ok: true,
      outcome: "aggregated",
      scheduling: "not_schedulable",
      update: { samples: [expect.anything(), expect.anything()] },
    });
  });

  it("withholds a zero-update result when an active binding has no sample", () => {
    const result = aggregateRoomConnectorCapabilityObservations(aggregationInput({
      observations: [sample(report("binding-a"))],
    }));

    expectWithheld(result, "missing_binding_sample");
  });

  it("withholds when the controller projection has a concrete active binding outside the target set", () => {
    const result = aggregateRoomConnectorCapabilityObservations(aggregationInput({
      activeBindings: [target("binding-a")],
      observations: [sample(report("binding-a"))],
    }));

    expectWithheld(result, "missing_active_binding");
  });

  it("withholds when a pending durable binding has no concrete Session runtime", () => {
    const pending = { ...binding("binding-pending"), state: "pending" as const };
    const result = aggregateRoomConnectorCapabilityObservations(aggregationInput({
      roomBindings: [binding("binding-a"), binding("binding-b"), pending],
    }));

    expectWithheld(result, "unobservable_active_binding");
  });

  it("withholds a zero-update result when one binding has duplicate samples", () => {
    const result = aggregateRoomConnectorCapabilityObservations(aggregationInput({
      observations: [sample(report("binding-a")), sample(report("binding-a")), sample(report("binding-b"))],
    }));

    expectWithheld(result, "duplicate_binding_sample");
  });

  it("withholds a zero-update result when a sample uses a different asOf decision time", () => {
    const mismatched = structuredClone(report("binding-b")) as any;
    mismatched.asOf = "2026-07-19T11:59:59.000Z";

    const result = aggregateRoomConnectorCapabilityObservations(aggregationInput({
      observations: [sample(report("binding-a")), sample(mismatched)],
    }));

    expectWithheld(result, "sample_time_mismatch");
  });

  it("withholds a zero-update result when a connector observation is rejected by the reporter", () => {
    const rejected = structuredClone(report("binding-b")) as any;
    rejected.observation.connectorEvidence.availability = "unavailable";

    const result = aggregateRoomConnectorCapabilityObservations(aggregationInput({
      observations: [sample(report("binding-a")), sample(rejected)],
    }));

    expectWithheld(result, "connector_evidence_unavailable");
  });

  it("withholds stale evidence and never emits a partially validated update", () => {
    const stale = structuredClone(report("binding-b")) as any;
    stale.observation.health.checkedAt = "2026-07-19T10:00:00.000Z";

    const result = aggregateRoomConnectorCapabilityObservations(aggregationInput({
      observations: [sample(report("binding-a")), sample(stale)],
    }));

    expectWithheld(result, "stale_observation");
  });

  it("withholds an unknown binding sample rather than forwarding it to a later writer", () => {
    const result = aggregateRoomConnectorCapabilityObservations(aggregationInput({
      observations: [sample(report("binding-a")), sample(report("binding-b")), sample(report("binding-unknown"))],
    }));

    expectWithheld(result, "unknown_binding_sample");
  });
});
