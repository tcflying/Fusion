import { describe, expect, it, vi } from "vitest";

import type {
  RoomBindingRecordV1,
  SessionConnectorCapabilitiesV1,
  SessionConnectorHealthV1,
  SessionConnectorIdentityV1,
  SessionConnectorRuntimeSnapshotV1,
  SessionConnectorV1,
} from "@fusion/core";

import {
  ROOM_CONNECTOR_RUNTIME_OBSERVATION_REPORTER_CONTRACT_VERSION,
  collectRoomConnectorRuntimeObservation,
} from "../room-connector-runtime-observation-reporter.js";
import type {
  ControlledRoomConnectorRuntimeObservationPortV1,
  RoomConnectorRuntimeObservationV1,
} from "../room-connector-runtime-observation-reporter.js";
import { createSessionConnectorRuntimeObservationPort } from "../room-session-connector-runtime-observation-port.js";
import { SessionConnectorRegistry } from "../session-connector-registry.js";

const AS_OF = "2026-07-20T00:00:00.000Z";
const STALE_AT = "2026-07-19T23:50:00.000Z";
const FUTURE_AT = "2026-07-20T00:10:00.000Z";
const CONNECTOR_ID = "connector-observation";
const HOST_ID = "host-observation";

const identity = {
  connectorId: CONNECTOR_ID,
  providerId: "codex",
  nativeSessionId: "thread-observation",
  happierSessionId: "happier-observation",
  serverProfileId: "server-observation",
  machineId: "machine-observation",
  hostId: HOST_ID,
} as SessionConnectorIdentityV1;

const binding = {
  contractVersion: 1,
  id: "binding-observation",
  roomId: "room-observation",
  seatId: "seat-observation",
  generation: 1,
  connectorId: CONNECTOR_ID,
  providerId: "codex",
  nativeSessionId: "thread-observation",
  happierSessionId: "happier-observation",
  serverProfileId: "server-observation",
  machineId: "machine-observation",
  hostId: HOST_ID,
  state: "attached",
  attachedAt: AS_OF,
  detachedAt: null,
  replacedByBindingId: null,
} as RoomBindingRecordV1;

function capabilitiesFixture(verifiedAt = AS_OF): SessionConnectorCapabilitiesV1 {
  const certification = {
    state: "verified" as const,
    evidenceRef: "official-mcp:test",
    reasonCode: null,
    lastVerifiedAt: verifiedAt,
  };
  return {
    contractVersion: 1,
    connectorId: CONNECTOR_ID as SessionConnectorCapabilitiesV1["connectorId"],
    connectorVersion: "1.0.0",
    sourceRevision: "official-mcp-test",
    verifiedAt,
    capabilities: {
      ensureExisting: certification,
      create: certification,
      status: certification,
      history: certification,
      events: certification,
      send: certification,
      interrupt: certification,
      resume: certification,
      takeover: certification,
      health: certification,
      deepLinks: certification,
    },
  };
}

function healthFixture(checkedAt = AS_OF): SessionConnectorHealthV1 {
  return {
    connectorId: CONNECTOR_ID as SessionConnectorHealthV1["connectorId"],
    hostId: HOST_ID,
    state: "healthy",
    checkedAt,
    authentication: "authenticated",
    daemon: "running",
    server: "reachable",
    backend: "ready",
    rateLimit: "clear",
    host: "reachable",
    capabilities: {
      ensureExisting: "verified",
      create: "verified",
      status: "verified",
      history: "verified",
      events: "verified",
      send: "verified",
      interrupt: "verified",
      resume: "verified",
      takeover: "verified",
      health: "verified",
      deepLinks: "verified",
    },
    reasonCodes: [],
    retryAfterMs: null,
  };
}

function runtimeSnapshotFixture(): SessionConnectorRuntimeSnapshotV1 {
  return {
    contractVersion: 1,
    source: "connector_local_extension",
    identity,
    snapshotId: "local-snapshot-observation",
    revision: 7,
    capturedAt: AS_OF,
    expiresAt: "2026-07-20T00:00:30.000Z",
    providerId: "codex",
    modelId: "gpt-5.5",
    modelObservedAt: AS_OF,
    accountId: null,
    coverage: {
      providerModel: "observed",
      providerAccount: "not_reported",
      providerQuota: "not_reported",
      latency: "not_reported",
      context: "not_reported",
      tools: "not_reported",
      quality: "not_reported",
    },
  };
}

function connectorFixture(options: {
  capabilities?: SessionConnectorCapabilitiesV1;
  health?: SessionConnectorHealthV1;
  runtimeSnapshot?: SessionConnectorRuntimeSnapshotV1;
} = {}): SessionConnectorV1 {
  return {
    contractVersion: 1,
    id: CONNECTOR_ID as SessionConnectorV1["id"],
    version: "1.0.0",
    getCapabilities: vi.fn(async () => options.capabilities ?? capabilitiesFixture()),
    ensureExisting: vi.fn(),
    create: vi.fn(),
    getStatus: vi.fn(),
    readHistory: vi.fn(),
    subscribeEvents: vi.fn(),
    send: vi.fn(),
    interrupt: vi.fn(),
    resume: vi.fn(),
    takeover: vi.fn(),
    getHealth: vi.fn(async () => options.health ?? healthFixture()),
    getDeepLinks: vi.fn(),
    ...(options.runtimeSnapshot ? {
      getRuntimeSnapshot: vi.fn(async () => ({ ok: true as const, value: options.runtimeSnapshot })),
    } : {}),
  } as unknown as SessionConnectorV1;
}

function request(overrides: Partial<Parameters<ReturnType<typeof createSessionConnectorRuntimeObservationPort>["observe"]>[0]> = {}) {
  return {
    contractVersion: ROOM_CONNECTOR_RUNTIME_OBSERVATION_REPORTER_CONTRACT_VERSION,
    projectId: "project-observation",
    roomId: "room-observation",
    binding,
    asOf: AS_OF,
    ...overrides,
  };
}

function collectionInput() {
  return {
    contractVersion: ROOM_CONNECTOR_RUNTIME_OBSERVATION_REPORTER_CONTRACT_VERSION,
    asOf: AS_OF,
    reportFreshness: {
      maxObservationAgeMs: 120_000,
      maxFutureSkewMs: 5_000,
    },
    target: {
      projectId: "project-observation",
      roomId: "room-observation",
      binding,
    },
    registryUpdate: {
      expectedAggregateVersion: 1,
      expectedRegistryRevision: 0,
      roomWorkerFence: {
        leaseId: "room-worker-lease-observation",
        holderId: "worker-observation",
        hostId: HOST_ID,
        expectedEpoch: 1,
      },
      idempotencyKey: "runtime-observation-freshness",
      freshness: {
        maxSnapshotAgeMs: 120_000,
        maxSignalAgeMs: 120_000,
        maxFutureSkewMs: 5_000,
      },
    },
  };
}

function knownRuntimeField<T>(value: T, observedAt = AS_OF) {
  return {
    state: "known" as const,
    source: "controlled_connector_runtime_observation_port" as const,
    observedAt,
    value,
  };
}

function withCompleteRuntimeFields(observation: RoomConnectorRuntimeObservationV1): RoomConnectorRuntimeObservationV1 {
  return {
    ...observation,
    snapshot: knownRuntimeField({
      snapshotId: "freshness-snapshot-observation",
      revision: 1,
      capturedAt: AS_OF,
      expiresAt: "2026-07-20T00:00:30.000Z",
    }),
    model: knownRuntimeField({
      providerId: "codex",
      accountId: "account-observation",
      modelId: "gpt-5.6-codex",
    }),
    tools: knownRuntimeField([{ name: "terminal", state: "verified" as const, evidenceRef: "official-mcp:tool:terminal" }]),
    mcps: knownRuntimeField([{ name: "filesystem", state: "verified" as const, evidenceRef: "official-mcp:mcp:filesystem" }]),
    skills: knownRuntimeField([{ name: "typescript", state: "verified" as const, evidenceRef: "official-mcp:skill:typescript" }]),
    context: knownRuntimeField({
      contextVersion: "context-v1",
      maximumTokens: 128_000,
      availableTokens: 64_000,
    }),
    workspaceAuthority: knownRuntimeField({
      workspaceId: "workspace-observation",
      scopes: ["read", "write"],
      state: "verified" as const,
    }),
    latency: knownRuntimeField({ p50Ms: 50, p95Ms: 100, sampleCount: 10 }),
    domainQuality: knownRuntimeField([{
      domain: "code",
      independentEvidence: [{
        sourceId: "gate:freshness-observation",
        kind: "deterministic_gate" as const,
        score: 0.9,
        observedAt: AS_OF,
      }],
    }]),
    calibration: knownRuntimeField([{
      domain: "code",
      outcomeCount: 20,
      meanAbsoluteError: 0.1,
    }]),
  };
}

function completeRuntimeObservationPort(
  port: ReturnType<typeof createSessionConnectorRuntimeObservationPort>,
): ControlledRoomConnectorRuntimeObservationPortV1 {
  return {
    observe: async (input) => withCompleteRuntimeFields(await port.observe(input)),
  };
}

describe("createSessionConnectorRuntimeObservationPort", () => {
  it("collects only certified connector facts and explicitly withholds unsupported runtime fields", async () => {
    const connector = connectorFixture();
    const registry = new SessionConnectorRegistry();
    registry.register(connector);
    const port = createSessionConnectorRuntimeObservationPort({
      registry,
    });

    const observation = await port.observe(request());

    expect(connector.getCapabilities).toHaveBeenCalledWith(identity);
    expect(connector.getHealth).toHaveBeenCalledWith(HOST_ID);
    expect(observation.identity).toEqual(identity);
    expect(observation.capabilities).toMatchObject({
      state: "known",
      observedAt: AS_OF,
      value: capabilitiesFixture(),
    });
    expect(observation.health).toMatchObject({
      state: "known",
      observedAt: AS_OF,
      value: healthFixture(),
    });
    expect(observation.rateLimit).toMatchObject({
      state: "known",
      value: { state: "clear", retryAfterMs: null },
    });
    expect(observation.snapshot).toMatchObject({
      state: "unknown",
      reason: "not_supported",
    });
    expect(observation.model).toEqual({
      state: "unknown",
      source: "controlled_connector_runtime_observation_port",
      observedAt: AS_OF,
      reason: "not_supported",
    });
    expect(observation.context).toMatchObject({ state: "unknown", reason: "not_supported" });
    expect(observation.domainQuality).toMatchObject({ state: "unknown", reason: "not_supported" });
    expect(observation.calibration).toMatchObject({ state: "unknown", reason: "not_supported" });
  });

  it("preserves source probe times so stale capabilities and health cannot be laundered by a fresh request", async () => {
    const registry = new SessionConnectorRegistry();
    registry.register(connectorFixture({
      capabilities: capabilitiesFixture(STALE_AT),
      health: healthFixture(STALE_AT),
    }));
    const port = createSessionConnectorRuntimeObservationPort({ registry });

    const observation = await port.observe(request());

    expect(observation.capabilities).toMatchObject({ state: "known", observedAt: STALE_AT });
    expect(observation.health).toMatchObject({ state: "known", observedAt: STALE_AT });
    expect(observation.rateLimit).toMatchObject({ state: "known", observedAt: STALE_AT });
    expect(observation.connectorEvidence).toMatchObject({ state: "known", observedAt: STALE_AT });

    const collection = await collectRoomConnectorRuntimeObservation(
      collectionInput(),
      completeRuntimeObservationPort(port),
    );
    expect(collection).toMatchObject({
      ok: false,
      outcome: "withheld",
      reason: { code: "runtime_observation_invalid" },
    });
    if (collection.ok) throw new Error("Expected stale connector evidence to be withheld downstream");
    expect(collection.reason.message).toContain("older than the fail-closed freshness window");
  });

  it("preserves future source probe times instead of backdating them to the collection request", async () => {
    const registry = new SessionConnectorRegistry();
    registry.register(connectorFixture({
      capabilities: capabilitiesFixture(FUTURE_AT),
      health: healthFixture(FUTURE_AT),
    }));
    const port = createSessionConnectorRuntimeObservationPort({ registry });

    const observation = await port.observe(request());

    expect(observation.capabilities).toMatchObject({ state: "known", observedAt: FUTURE_AT });
    expect(observation.health).toMatchObject({ state: "known", observedAt: FUTURE_AT });
    expect(observation.rateLimit).toMatchObject({ state: "known", observedAt: FUTURE_AT });
    expect(observation.connectorEvidence).toMatchObject({ state: "known", observedAt: FUTURE_AT });

    const collection = await collectRoomConnectorRuntimeObservation(
      collectionInput(),
      completeRuntimeObservationPort(port),
    );
    expect(collection).toMatchObject({
      ok: false,
      outcome: "withheld",
      reason: { code: "runtime_observation_invalid" },
    });
    if (collection.ok) throw new Error("Expected future connector evidence to be withheld downstream");
    expect(collection.reason.message).toContain("future");
  });

  it("uses the earliest certification and health source time for mixed connector evidence", async () => {
    const capabilities = capabilitiesFixture(FUTURE_AT);
    const mixedCapabilities = {
      ...capabilities,
      capabilities: {
        ...capabilities.capabilities,
        send: {
          ...capabilities.capabilities.send,
          lastVerifiedAt: STALE_AT,
        },
      },
    };
    const registry = new SessionConnectorRegistry();
    registry.register(connectorFixture({
      capabilities: mixedCapabilities,
      health: healthFixture(FUTURE_AT),
    }));
    const port = createSessionConnectorRuntimeObservationPort({ registry });

    const observation = await port.observe(request());

    expect(observation.capabilities).toMatchObject({ state: "known", observedAt: STALE_AT });
    expect(observation.health).toMatchObject({ state: "known", observedAt: FUTURE_AT });
    expect(observation.rateLimit).toMatchObject({ state: "known", observedAt: FUTURE_AT });
    expect(observation.connectorEvidence).toMatchObject({ state: "known", observedAt: STALE_AT });

    await expect(collectRoomConnectorRuntimeObservation(
      collectionInput(),
      completeRuntimeObservationPort(port),
    )).resolves.toMatchObject({
      ok: false,
      outcome: "withheld",
      reason: { code: "runtime_observation_invalid" },
    });
  });

  it("returns a controlled unavailable observation when the exact binding connector is absent", async () => {
    const port = createSessionConnectorRuntimeObservationPort({
      registry: new SessionConnectorRegistry(),
    });

    const observation = await port.observe(request());

    expect(observation.connectorEvidence).toEqual({
      state: "known",
      source: "controlled_connector_runtime_observation_port",
      observedAt: AS_OF,
      value: { availability: "unavailable" },
    });
    expect(observation.capabilities).toMatchObject({ state: "unknown", reason: "unavailable" });
    expect(observation.health).toMatchObject({ state: "unknown", reason: "unavailable" });
    expect(observation.rateLimit).toMatchObject({ state: "unknown", reason: "unavailable" });
  });

  it("accepts one identity-bound local runtime snapshot without mistaking its accountless model for a schedulable profile", async () => {
    const connector = connectorFixture({ runtimeSnapshot: runtimeSnapshotFixture() });
    const registry = new SessionConnectorRegistry();
    registry.register(connector);
    const port = createSessionConnectorRuntimeObservationPort({ registry });

    const observation = await port.observe(request());

    expect(observation.snapshot).toEqual({
      state: "known",
      source: "controlled_connector_runtime_observation_port",
      observedAt: AS_OF,
      value: {
        snapshotId: "local-snapshot-observation",
        revision: 7,
        capturedAt: AS_OF,
        expiresAt: "2026-07-20T00:00:30.000Z",
      },
    });
    expect(observation.model).toMatchObject({
      state: "unknown",
      reason: "not_supported",
    });

    const collection = await collectRoomConnectorRuntimeObservation({
      contractVersion: ROOM_CONNECTOR_RUNTIME_OBSERVATION_REPORTER_CONTRACT_VERSION,
      asOf: AS_OF,
      reportFreshness: {
        maxObservationAgeMs: 120_000,
        maxFutureSkewMs: 5_000,
      },
      target: {
        projectId: "project-observation",
        roomId: "room-observation",
        binding,
      },
      registryUpdate: {
        expectedAggregateVersion: 1,
        expectedRegistryRevision: 0,
        roomWorkerFence: {
          leaseId: "room-worker-lease-observation",
          holderId: "worker-observation",
          hostId: HOST_ID,
          expectedEpoch: 1,
        },
        idempotencyKey: "local-runtime-snapshot-withheld",
        freshness: {
          maxSnapshotAgeMs: 120_000,
          maxSignalAgeMs: 120_000,
          maxFutureSkewMs: 5_000,
        },
      },
    }, port);

    expect(collection).toMatchObject({
      ok: false,
      outcome: "withheld",
      reason: { code: "runtime_observation_unknown" },
    });
    if (collection.ok) throw new Error("Expected accountless local metadata to remain withheld");
    expect(collection.unknown).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "model", reason: "not_supported" }),
    ]));
  });

  it("never upgrades an incomplete base connector probe into a schedulable registry sample", async () => {
    const registry = new SessionConnectorRegistry();
    registry.register(connectorFixture());
    const port = createSessionConnectorRuntimeObservationPort({
      registry,
    });

    const result = await collectRoomConnectorRuntimeObservation({
      contractVersion: ROOM_CONNECTOR_RUNTIME_OBSERVATION_REPORTER_CONTRACT_VERSION,
      asOf: AS_OF,
      reportFreshness: {
        maxObservationAgeMs: 120_000,
        maxFutureSkewMs: 5_000,
      },
      target: {
        projectId: "project-observation",
        roomId: "room-observation",
        binding,
      },
      registryUpdate: {
        expectedAggregateVersion: 1,
        expectedRegistryRevision: 0,
        roomWorkerFence: {
          leaseId: "room-worker-lease-observation",
          holderId: "worker-observation",
          hostId: HOST_ID,
          expectedEpoch: 1,
        },
        idempotencyKey: "runtime-observation-withheld",
        freshness: {
          maxSnapshotAgeMs: 120_000,
          maxSignalAgeMs: 120_000,
          maxFutureSkewMs: 5_000,
        },
      },
    }, port);

    expect(result).toMatchObject({
      ok: false,
      outcome: "withheld",
      scheduling: "not_schedulable",
      reason: { code: "runtime_observation_unknown" },
    });
    if (result.ok) throw new Error("Expected incomplete runtime observation to be withheld");
    expect(result.unknown.map((entry) => entry.field)).toEqual(expect.arrayContaining([
      "model",
      "context",
      "latency",
      "domainQuality",
      "calibration",
    ]));
  });
});
