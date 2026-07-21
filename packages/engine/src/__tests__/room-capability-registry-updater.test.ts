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
  updateRoomCapabilityRegistry,
  type RoomCapabilityRegistryUpdateInputV1,
  type RoomCapabilityRegistryWriterPortV1,
} from "../room-capability-registry-updater.js";
import type { CreateRoomBindingCapabilityReportInputV1 } from "../room-binding-capability-reporter.js";

const AS_OF = "2026-07-18T12:00:00.000Z";
const OBSERVED_AT = "2026-07-18T11:59:45.000Z";
const CAPTURED_AT = "2026-07-18T11:59:50.000Z";
const EXPIRES_AT = "2026-07-18T12:01:00.000Z";

const IDENTITY = {
  connectorId: "happier",
  providerId: "codex",
  nativeSessionId: "codex-thread-1",
  happierSessionId: "happier-session-1",
  serverProfileId: "server-profile-1",
  machineId: "machine-1",
  hostId: "windows-host-1",
} satisfies SessionConnectorIdentityV1;

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object in this test fixture`);
  }
  return value as Record<string, unknown>;
}

function firstRecord(value: unknown, label: string): Record<string, unknown> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must contain a first object in this test fixture`);
  }
  return asRecord(value[0], label);
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

function reportInput(): CreateRoomBindingCapabilityReportInputV1 {
  return {
    contractVersion: 1,
    asOf: AS_OF,
    freshness: {
      maxObservationAgeMs: 120_000,
      maxFutureSkewMs: 5_000,
    },
    target: {
      projectId: "project-1",
      roomId: "room-1",
      binding: binding(),
      runtime: {
        source: "trusted_session_connector_binding",
        identity: IDENTITY,
        accountId: "account-1",
        modelId: "gpt-5.6-codex",
        observedAt: OBSERVED_AT,
      },
    },
    observation: {
      source: "trusted_session_connector",
      connectorEvidence: {
        source: "trusted_session_connector",
        availability: "available",
        observedAt: OBSERVED_AT,
      },
      projectId: "project-1",
      roomId: "room-1",
      bindingId: "binding-1",
      snapshotId: "capability-snapshot-1",
      revision: 4,
      capturedAt: CAPTURED_AT,
      expiresAt: EXPIRES_AT,
      identity: IDENTITY,
      capabilities: {
        contractVersion: 1,
        connectorId: IDENTITY.connectorId,
        connectorVersion: "0.2.73",
        sourceRevision: "happier-source-revision-1",
        verifiedAt: OBSERVED_AT,
        capabilities: capabilityStates(),
      },
      health: {
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
      },
      model: {
        source: "trusted_session_connector",
        providerId: IDENTITY.providerId,
        accountId: "account-1",
        modelId: "gpt-5.6-codex",
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
        workspaceId: "workspace-1",
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

function updateInput(
  report = reportInput(),
): RoomCapabilityRegistryUpdateInputV1 {
  return {
    contractVersion: 1,
    projectId: "project-1",
    roomId: "room-1",
    expectedAggregateVersion: 7,
    expectedRegistryRevision: 3,
    roomWorkerFence: {
      leaseId: "room-worker-lease-1",
      holderId: "controller-1",
      hostId: IDENTITY.hostId,
      expectedEpoch: 4,
    },
    idempotencyKey: "capability-registry-update-1",
    sampledAt: AS_OF,
    freshness: {
      maxSnapshotAgeMs: 120_000,
      maxSignalAgeMs: 120_000,
      maxFutureSkewMs: 5_000,
    },
    samples: [{
      source: "trusted_session_connector",
      report,
    }],
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

describe("Room capability registry updater", () => {
  it("derives trusted reporter snapshots and writes a bounded durable registry update", async () => {
    const { writer, recordRoomCapabilityRegistry } = writerDouble();

    const result = await updateRoomCapabilityRegistry(updateInput(), writer);

    expect(result).toMatchObject({ ok: true, outcome: "written", scheduling: "schedulable" });
    expect(recordRoomCapabilityRegistry).toHaveBeenCalledTimes(1);
    expect(recordRoomCapabilityRegistry).toHaveBeenCalledWith(expect.objectContaining({
      roomId: "room-1",
      expectedAggregateVersion: 7,
      expectedRegistryRevision: 3,
      idempotencyKey: "capability-registry-update-1",
      asOf: AS_OF,
      roomWorkerFence: {
        leaseId: "room-worker-lease-1",
        holderId: "controller-1",
        hostId: "windows-host-1",
        expectedEpoch: 4,
      },
      samples: [expect.objectContaining({
        lineage: expect.objectContaining({ bindingId: "binding-1", modelId: "gpt-5.6-codex" }),
      })],
    }));
  });

  const rejectedEvidenceCases: readonly [
    string,
    (value: Record<string, unknown>) => void,
    string,
  ][] = [
    ["stale", (value) => {
      asRecord(asRecord(value.observation, "observation").health, "health").checkedAt = "2026-07-18T10:00:00.000Z";
    }, "stale_observation"],
    ["peer", (value) => {
      const observation = asRecord(value.observation, "observation");
      firstRecord(observation.tools, "tools").source = "peer";
    }, "untrusted_claim"],
    ["identity mismatch", (value) => {
      asRecord(asRecord(value.observation, "observation").identity, "identity").hostId = "windows-host-2";
    }, "host_mismatch"],
    ["unavailable", (value) => {
      asRecord(asRecord(value.observation, "observation").connectorEvidence, "connectorEvidence").availability = "unavailable";
    }, "connector_evidence_unavailable"],
  ];

  it.each(rejectedEvidenceCases)("withholds %s evidence instead of writing a schedulable registry", async (_label, mutate, code) => {
    const { writer, recordRoomCapabilityRegistry } = writerDouble();
    const report = structuredClone(reportInput());
    mutate(asRecord(report, "report"));

    const result = await updateRoomCapabilityRegistry(updateInput(report), writer);

    expect(result).toMatchObject({
      ok: false,
      outcome: "withheld",
      scheduling: "not_schedulable",
      reason: { code: "reporter_rejected" },
    });
    if (!result.ok && result.outcome === "withheld") {
      expect(result.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code }),
      ]));
    }
    expect(recordRoomCapabilityRegistry).not.toHaveBeenCalled();
  });

  it("refuses a wider report TTL before stale tool evidence can look schedulable in the durable registry", async () => {
    const { writer, recordRoomCapabilityRegistry } = writerDouble();
    const report = structuredClone(reportInput());
    const observation = asRecord(asRecord(report, "report").observation, "observation");
    firstRecord(observation.tools, "tools").observedAt = "2026-07-18T11:58:30.000Z";

    const result = await updateRoomCapabilityRegistry({
      ...updateInput(report),
      freshness: {
        maxSnapshotAgeMs: 60_000,
        maxSignalAgeMs: 60_000,
        maxFutureSkewMs: 5_000,
      },
    }, writer);

    expect(result).toMatchObject({
      ok: false,
      outcome: "withheld",
      scheduling: "not_schedulable",
      reason: { code: "invalid_input" },
    });
    if (!result.ok && result.outcome === "withheld") {
      expect(result.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "report_freshness_exceeds_registry_freshness" }),
      ]));
    }
    expect(recordRoomCapabilityRegistry).not.toHaveBeenCalled();
  });

  it("writes trusted but uncertain connector state only as explicitly non-schedulable", async () => {
    const { writer, recordRoomCapabilityRegistry } = writerDouble();
    const report = structuredClone(reportInput());
    const observation = asRecord(asRecord(report, "report").observation, "observation");
    const health = asRecord(observation.health, "health");
    health.state = "degraded";
    health.rateLimit = "unknown";

    const result = await updateRoomCapabilityRegistry(updateInput(report), writer);

    expect(result).toMatchObject({ ok: true, outcome: "written", scheduling: "not_schedulable" });
    expect(recordRoomCapabilityRegistry).toHaveBeenCalledTimes(1);
  });

  it("returns a typed durable-writer failure without treating the snapshot as schedulable", async () => {
    const { writer, recordRoomCapabilityRegistry } = writerDouble();
    recordRoomCapabilityRegistry.mockRejectedValueOnce(new Error("durable registry rejected"));

    const result = await updateRoomCapabilityRegistry(updateInput(), writer);

    expect(result).toMatchObject({
      ok: false,
      outcome: "writer_rejected",
      scheduling: "not_schedulable",
      reason: { code: "writer_rejected", message: "durable registry rejected" },
    });
  });

  it("passes the caller idempotency key through unchanged", async () => {
    const { writer, recordRoomCapabilityRegistry } = writerDouble();
    const input = {
      ...updateInput(),
      idempotencyKey: "caller-supplied-idempotency-key",
    };

    await updateRoomCapabilityRegistry(input, writer);

    expect(recordRoomCapabilityRegistry.mock.calls[0]?.[0]?.idempotencyKey)
      .toBe("caller-supplied-idempotency-key");
  });
});
