import { describe, expect, it } from "vitest";

import type {
  RoomAdaptiveSchedulingActiveWorkItemV1,
  RoomAdaptiveSchedulingWorkItemV1,
} from "@fusion/core";

import {
  ROOM_CAPACITY_GOVERNOR_CONTRACT_VERSION,
  governRoomCapacity,
  type RoomCapacityGovernorInputV1,
  type RoomCapacityGovernorQuotaStateV1,
} from "../room-capacity-governor.js";

const AS_OF = "2026-07-18T12:00:00.000Z";

function queuedWork(
  id: string,
  qualityScore: number
): RoomAdaptiveSchedulingWorkItemV1 {
  return {
    workId: id,
    projectId: "project-capacity-governor",
    roomId: "room-capacity-governor",
    kind: "producer",
    qualityScore,
    criticalPathDistance: 1,
    projectPriority: 1,
    roomPriority: 1,
    enqueuedAt: "2026-07-18T11:59:00.000Z",
    requiredSlots: 1,
  };
}

function activeWork(
  id: string,
  qualityScore = 0.7
): RoomAdaptiveSchedulingActiveWorkItemV1 {
  return {
    ...queuedWork(id, qualityScore),
    startedAt: "2026-07-18T11:58:00.000Z",
    atTurnBoundary: true,
  };
}

interface FixtureOptions {
  readonly asOf?: string;
  readonly sampledAt?: string;
  readonly totalSlots?: number;
  readonly hardConcurrencyLimit?: number;
  readonly reservedVerifierSlots?: number;
  readonly reservedRecoverySlots?: number;
  readonly queued?: readonly RoomAdaptiveSchedulingWorkItemV1[];
  readonly active?: readonly RoomAdaptiveSchedulingActiveWorkItemV1[];
  readonly attemptCount?: number;
  readonly failureCount?: number;
  readonly p95LatencyMs?: number;
  readonly quotaState?: RoomCapacityGovernorQuotaStateV1;
  readonly connectorState?: RoomCapacityGovernorInputV1["telemetry"]["connector"]["state"];
}

function fixture(options: FixtureOptions = {}): RoomCapacityGovernorInputV1 {
  const asOf = options.asOf ?? AS_OF;
  const active = options.active ?? [
    activeWork("active-a"),
    activeWork("active-b"),
  ];
  const queued = options.queued ?? [
    queuedWork("queued-high", 0.99),
    queuedWork("queued-mid", 0.8),
    queuedWork("queued-low", 0.6),
    queuedWork("queued-last", 0.4),
  ];
  const quotaState = options.quotaState ?? "clear";
  const connectorState = options.connectorState ?? "healthy";
  const retryAfterMs =
    quotaState === "limited" || quotaState === "exhausted" ? 60_000 : null;
  return {
    contractVersion: ROOM_CAPACITY_GOVERNOR_CONTRACT_VERSION,
    asOf,
    policy: {
      telemetryTtlMs: 60_000,
      maximumFailureRate: 0.2,
      maximumP95LatencyMs: 1_000,
      decreaseStepSlots: 1,
    },
    scheduling: {
      asOf,
      capacity: {
        totalSlots: options.totalSlots ?? 8,
        reservedVerifierSlots: options.reservedVerifierSlots ?? 0,
        reservedRecoverySlots: options.reservedRecoverySlots ?? 0,
      },
      policy: {
        minimumProjectReservations: [],
        minimumRoomReservations: [],
        fairnessAgingQuantumMs: 60_000,
        preemptionEnabled: false,
      },
      queued,
      active,
    },
    telemetry: {
      sampledAt: options.sampledAt ?? asOf,
      queue: {
        source: "controller_observation",
        queuedWorkCount: queued.length,
      },
      running: {
        source: "controller_observation",
        activeWorkCount: active.length,
        activeSlots: active.reduce(
          (total, work) => total + work.requiredSlots,
          0
        ),
      },
      failures: {
        source: "controller_observation",
        attemptCount: options.attemptCount ?? 10,
        failureCount: options.failureCount ?? 0,
      },
      latency: {
        source: "controller_observation",
        sampleCount: 10,
        p95Ms: options.p95LatencyMs ?? 200,
      },
      quota: {
        source: "session_connector_observation",
        state: quotaState,
        hardConcurrencyLimit: options.hardConcurrencyLimit ?? 6,
        retryAfterMs,
      },
      connector: {
        source: "session_connector_observation",
        state: connectorState,
      },
    },
    capabilityRegistry: {
      source: "durable_room_ledger",
      registryId: "room-capability-registry-governor-r1",
      revision: 1,
      integrityHash: "sha256:room-capability-registry-governor-r1",
      observedAt: asOf,
      expiresAt: "2026-07-18T12:01:00.000Z",
    },
  } as RoomCapacityGovernorInputV1;
}

describe("governRoomCapacity", () => {
  it("withholds dispatch when durable capability-registry proof is absent", () => {
    const input = fixture() as RoomCapacityGovernorInputV1 & {
      capabilityRegistry?: unknown;
    };
    delete input.capabilityRegistry;

    const decision = governRoomCapacity(input);

    expect(decision.admission.newlyAdmittedSlots).toBe(0);
    expect(decision.reasonCodes).toContain("capability_registry_unavailable");
  });

  it("fails closed for stale or untrusted capability-registry proof", () => {
    const stale = fixture();
    const staleDecision = governRoomCapacity({
      ...stale,
      capabilityRegistry: {
        ...stale.capabilityRegistry,
        expiresAt: "2026-07-18T11:59:59.999Z",
      },
    });
    const untrusted = fixture();
    const untrustedDecision = governRoomCapacity({
      ...untrusted,
      capabilityRegistry: {
        ...untrusted.capabilityRegistry,
        source: "provider_label_default",
      },
    } as unknown as RoomCapacityGovernorInputV1);

    expect(staleDecision).toMatchObject({
      admission: { newlyAdmittedSlots: 0 },
      reasonCodes: ["capability_registry_stale"],
    });
    expect(untrustedDecision).toMatchObject({
      admission: { newlyAdmittedSlots: 0 },
      reasonCodes: ["capability_registry_unavailable"],
    });
  });

  it("emits explicit idle capacity metrics instead of making an empty queue look saturated", () => {
    const decision = governRoomCapacity(fixture({ queued: [], active: [] }));

    expect(decision.metrics).toEqual({
      configuredSlots: 8,
      effectiveSlots: 6,
      activeSlots: 0,
      queuedWorkCount: 0,
      reservedVerifierSlots: 0,
      reservedRecoverySlots: 0,
      availableSlots: 6,
      newlyAdmittedSlots: 0,
      saturation: { state: "idle", ratio: 0 },
      waitReasonCodes: [],
      idleReasonCodes: ["no_queued_work"],
    });
  });

  it("emits explicit saturation and wait reasons when the certified hard cap is full", () => {
    const decision = governRoomCapacity(fixture({ hardConcurrencyLimit: 2 }));

    expect(decision.metrics).toEqual({
      configuredSlots: 8,
      effectiveSlots: 2,
      activeSlots: 2,
      queuedWorkCount: 4,
      reservedVerifierSlots: 0,
      reservedRecoverySlots: 0,
      availableSlots: 0,
      newlyAdmittedSlots: 0,
      saturation: { state: "saturated", ratio: 1 },
      waitReasonCodes: ["hard_concurrency_cap_reached"],
      idleReasonCodes: [],
    });
  });

  it("keeps verifier and recovery capacity reserved and exposes the producer wait", () => {
    const decision = governRoomCapacity(
      fixture({
        totalSlots: 4,
        hardConcurrencyLimit: 4,
        reservedVerifierSlots: 1,
        reservedRecoverySlots: 1,
        queued: [queuedWork("queued-producer", 0.9)],
        active: [activeWork("active-a"), activeWork("active-b")],
      })
    );

    expect(decision.admission).toMatchObject({
      concurrencyLimit: 4,
      currentActiveSlots: 2,
      newlyAdmittedSlots: 0,
      scheduledWorkIds: [],
    });
    expect(decision.reasonCodes).toEqual(["reserved_capacity_held"]);
    expect(decision.metrics).toEqual({
      configuredSlots: 4,
      effectiveSlots: 4,
      activeSlots: 2,
      queuedWorkCount: 1,
      reservedVerifierSlots: 1,
      reservedRecoverySlots: 1,
      availableSlots: 2,
      newlyAdmittedSlots: 0,
      saturation: { state: "available", ratio: 0.5 },
      waitReasonCodes: ["reserved_capacity_held"],
      idleReasonCodes: [],
    });
  });

  it("uses the Core quality-first policy to fill fresh, certified capacity", () => {
    const decision = governRoomCapacity(fixture());

    expect(decision.schedulerContractVersion).toBe(1);
    expect(decision.telemetry).toEqual({
      sampledAt: AS_OF,
      ttlMs: 60_000,
      expiresAt: "2026-07-18T12:01:00.000Z",
      state: "fresh",
    });
    expect(decision.admission).toEqual({
      concurrencyLimit: 6,
      currentActiveSlots: 2,
      newlyAdmittedSlots: 4,
      scheduledWorkIds: [
        "queued-high",
        "queued-mid",
        "queued-low",
        "queued-last",
      ],
      preemptedWorkIds: [],
    });
    expect(decision.recommendation).toEqual({
      action: "start",
      targetConcurrentSlots: 6,
    });
    expect(decision.reasonCodes).toEqual(["capacity_available"]);
  });

  it("fails closed for stale telemetry instead of admitting fresh queue work", () => {
    const decision = governRoomCapacity(
      fixture({
        sampledAt: "2026-07-18T11:58:59.999Z",
      })
    );

    expect(decision.telemetry.state).toBe("stale");
    expect(decision.admission).toMatchObject({
      concurrencyLimit: 0,
      newlyAdmittedSlots: 0,
      scheduledWorkIds: [],
    });
    expect(decision.recommendation).toEqual({
      action: "pause",
      targetConcurrentSlots: 0,
    });
    expect(decision.reasonCodes).toEqual(["stale_telemetry"]);
  });

  it("sheds rather than starts work when the observed error rate or latency exceeds policy", () => {
    const decision = governRoomCapacity(
      fixture({
        active: [
          activeWork("active-a"),
          activeWork("active-b"),
          activeWork("active-c"),
          activeWork("active-d"),
        ],
        hardConcurrencyLimit: 8,
        attemptCount: 10,
        failureCount: 4,
        p95LatencyMs: 2_000,
      })
    );

    expect(decision.admission).toMatchObject({
      concurrencyLimit: 3,
      currentActiveSlots: 4,
      scheduledWorkIds: [],
    });
    expect(decision.recommendation).toEqual({
      action: "decrease",
      targetConcurrentSlots: 3,
    });
    expect(decision.reasonCodes).toEqual([
      "error_rate_overload",
      "latency_overload",
    ]);
  });

  it("clamps Core scheduling to a certified hard concurrency cap", () => {
    const decision = governRoomCapacity(
      fixture({
        active: [activeWork("active-a")],
        hardConcurrencyLimit: 3,
        queued: [
          queuedWork("queued-high", 0.99),
          queuedWork("queued-mid", 0.8),
          queuedWork("queued-low", 0.6),
        ],
      })
    );

    expect(decision.admission).toEqual({
      concurrencyLimit: 3,
      currentActiveSlots: 1,
      newlyAdmittedSlots: 2,
      scheduledWorkIds: ["queued-high", "queued-mid"],
      preemptedWorkIds: [],
    });
    expect(decision.recommendation).toEqual({
      action: "start",
      targetConcurrentSlots: 3,
    });
  });

  it("fails closed when observed queue counters contradict the Core scheduling snapshot", () => {
    const input = fixture();
    const decision = governRoomCapacity({
      ...input,
      telemetry: {
        ...input.telemetry,
        queue: {
          ...input.telemetry.queue,
          queuedWorkCount: input.telemetry.queue.queuedWorkCount + 1,
        },
      },
    });

    expect(decision.telemetry.state).toBe("invalid");
    expect(decision.admission.concurrencyLimit).toBe(0);
    expect(decision.recommendation.action).toBe("pause");
    expect(decision.reasonCodes).toEqual(["telemetry_contradiction"]);
  });

  it("does not infer provider capacity when the certified hard cap is missing", () => {
    const input = fixture();
    const decision = governRoomCapacity({
      ...input,
      telemetry: {
        ...input.telemetry,
        quota: { ...input.telemetry.quota, hardConcurrencyLimit: null },
      },
    } as unknown as RoomCapacityGovernorInputV1);

    expect(decision.telemetry.state).toBe("invalid");
    expect(decision.admission.concurrencyLimit).toBe(0);
    expect(decision.recommendation.action).toBe("pause");
    expect(decision.reasonCodes).toEqual(["telemetry_invalid"]);
  });
});
