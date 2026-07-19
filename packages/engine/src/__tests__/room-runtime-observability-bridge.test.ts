import { describe, expect, it, vi } from "vitest";

import type { RoomConnectorRuntimeObservationV1 } from "../room-connector-runtime-observation-reporter.js";
import {
  RoomRuntimeObservabilityBridge,
  type RoomRuntimeObservabilityBridgeInputV1,
  type RoomRuntimeObservabilitySchedulingFactsV1,
  type RoomRuntimeObservabilitySinkV1,
} from "../room-runtime-observability-bridge.js";

const SCOPE = { projectId: "project-observability", roomId: "room-observability" } as const;
const COMPUTED_AT = "2026-07-19T12:00:00.000Z";
const OBSERVED_AT = "2026-07-19T11:59:30.000Z";
const WINDOW = {
  startedAt: "2026-07-19T11:59:00.000Z",
  endedAt: COMPUTED_AT,
} as const;

function known<T>(value: T) {
  return {
    state: "known" as const,
    source: "controlled_connector_runtime_observation_port" as const,
    observedAt: OBSERVED_AT,
    value,
  };
}

function runtimeObservation(): RoomConnectorRuntimeObservationV1 {
  return {
    contractVersion: 1,
    source: "controlled_connector_runtime_observation_port",
    projectId: SCOPE.projectId,
    roomId: SCOPE.roomId,
    bindingId: "binding-observability",
    identity: {
      connectorId: "happier",
      providerId: "codex",
      nativeSessionId: "codex-thread-observability",
      happierSessionId: "happier-session-observability",
      serverProfileId: "server-profile-observability",
      machineId: "windows-machine-observability",
      hostId: "windows-host-observability",
    },
    snapshot: known({
      snapshotId: "connector-runtime-snapshot-7",
      revision: 7,
      capturedAt: OBSERVED_AT,
      expiresAt: "2026-07-19T12:01:00.000Z",
    }),
    connectorEvidence: known({ availability: "available" as const }),
    health: known({ state: "healthy" }),
  } as unknown as RoomConnectorRuntimeObservationV1;
}

function scheduling(
  overrides: Partial<RoomRuntimeObservabilitySchedulingFactsV1> = {},
): RoomRuntimeObservabilitySchedulingFactsV1 {
  return {
    scope: SCOPE,
    observedAt: OBSERVED_AT,
    evidenceRefs: ["evidence://scheduler/queue-snapshot-7"],
    capacity: {
      configuredSlots: 8,
      eligibleSlots: 6,
      activeSlots: 4,
      reservedVerifierSlots: 1,
      reservedRecoverySlots: 1,
      degradedSlots: 0,
      blockedSlots: 0,
      retryingSlots: 0,
    },
    throughput: {
      completedTasks: 5,
      committedEvents: 9,
    },
    queue: {
      readyTasks: 3,
      queuedTasks: 2,
      blockedTasks: 0,
      retryingTasks: 0,
    },
    idleReasons: [{ reason: "policy", count: 2 }],
    waitReasons: [{ reason: "dependency", count: 2 }],
    recovery: {
      attempted: 1,
      succeeded: 1,
      failed: 0,
      inFlight: 0,
    },
    ...overrides,
  };
}

function input(
  overrides: Partial<RoomRuntimeObservabilityBridgeInputV1> = {},
): RoomRuntimeObservabilityBridgeInputV1 {
  return {
    contractVersion: 1,
    scope: SCOPE,
    eventId: "room-observability-event-1",
    cursor: 1,
    computedAt: COMPUTED_AT,
    window: WINDOW,
    connectorRuntime: runtimeObservation(),
    scheduling: scheduling(),
    ...overrides,
  };
}

describe("RoomRuntimeObservabilityBridge", () => {
  it("derives a verifiable Core snapshot, alerts, and attributed idle reason before publishing an acknowledged event", async () => {
    const publish = vi.fn(async () => ({
      ok: true as const,
      acknowledgementRef: "evidence://sink/observability-ack-1",
      acknowledgedAt: COMPUTED_AT,
    }));
    const bridge = new RoomRuntimeObservabilityBridge({
      sink: { publish } satisfies RoomRuntimeObservabilitySinkV1,
    });

    const result = await bridge.observe(input());

    expect(result).toMatchObject({
      ok: true,
      outcome: "published",
      delivery: "sink_acknowledged",
      connector: { state: "healthy" },
      idle: {
        state: "known",
        reasons: [{ reason: "policy", count: 2 }],
      },
      snapshot: {
        utilization: { ratio: { state: "known", value: 4 / 6 } },
        queue: { readyTasks: { state: "known", value: 3 } },
        missingTelemetry: [],
      },
    });
    if (!result.ok) throw new Error("Expected observability publication to succeed");
    expect(result.evidenceRefs).toEqual(expect.arrayContaining([
      "evidence://scheduler/queue-snapshot-7",
      expect.stringMatching(/^connector-runtime:\/\//u),
      "evidence://sink/observability-ack-1",
    ]));
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      scope: SCOPE,
      cursor: 1,
      eventId: "room-observability-event-1",
      snapshot: expect.objectContaining({ scope: SCOPE }),
    }));
  });

  it("publishes unknown telemetry and explicit alerts instead of fabricating connector health or zero metrics", async () => {
    const bridge = new RoomRuntimeObservabilityBridge();

    const result = await bridge.observe(input({
      connectorRuntime: null,
      scheduling: null,
    }));

    expect(result).toMatchObject({
      ok: true,
      outcome: "published",
      delivery: "core_calculated",
      connector: { state: "unknown" },
      idle: { state: "unknown" },
      snapshot: {
        capacity: { activeSlots: { state: "unknown", value: null } },
        utilization: { ratio: { state: "unknown", value: null } },
      },
    });
    if (!result.ok) throw new Error("Expected missing telemetry publication to remain explicit");
    expect(result.snapshot.missingTelemetry).toEqual(expect.arrayContaining([
      "capacity",
      "queue",
      "throughput",
      "idle_reasons",
    ]));
    expect(result.alerts.map((alert) => alert.code)).toEqual(expect.arrayContaining([
      "runtime_telemetry_missing",
      "scheduling_telemetry_missing",
      "metrics_telemetry_missing",
      "connector_health_unknown",
    ]));
  });

  it("withholds cross-scope connector facts before they can overwrite a Room snapshot", async () => {
    const publish = vi.fn(async () => ({
      ok: true as const,
      acknowledgementRef: "evidence://sink/unreachable",
      acknowledgedAt: COMPUTED_AT,
    }));
    const bridge = new RoomRuntimeObservabilityBridge({
      sink: { publish } satisfies RoomRuntimeObservabilitySinkV1,
    });
    const observation = {
      ...runtimeObservation(),
      roomId: "other-room",
    } as RoomConnectorRuntimeObservationV1;

    const result = await bridge.observe(input({ connectorRuntime: observation }));

    expect(result).toMatchObject({
      ok: false,
      outcome: "withheld",
      reason: { code: "scope_mismatch" },
    });
    expect(publish).not.toHaveBeenCalled();
  });

  it("rejects both stale cursors and duplicated events without replacing a newer snapshot", async () => {
    const publish = vi.fn(async () => ({
      ok: true as const,
      acknowledgementRef: "evidence://sink/stale-ack",
      acknowledgedAt: COMPUTED_AT,
    }));
    const bridge = new RoomRuntimeObservabilityBridge({
      sink: { publish } satisfies RoomRuntimeObservabilitySinkV1,
    });

    const first = await bridge.observe(input({ cursor: 7, eventId: "room-observability-event-7" }));
    const stale = await bridge.observe(input({ cursor: 6, eventId: "room-observability-event-6" }));
    const duplicate = await bridge.observe(input({ cursor: 8, eventId: "room-observability-event-7" }));

    expect(first).toMatchObject({ ok: true, outcome: "published" });
    expect(stale).toMatchObject({ ok: false, outcome: "withheld", reason: { code: "stale_cursor" } });
    expect(duplicate).toMatchObject({ ok: false, outcome: "withheld", reason: { code: "duplicate_event" } });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(bridge.getLatest(SCOPE)).toMatchObject({
      eventId: "room-observability-event-7",
      cursor: 7,
    });
  });

  it("does not advance the event cursor when a sink acknowledgement throws, allowing an exact retry", async () => {
    let attempts = 0;
    const publish = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("sink disconnected");
      return {
        ok: true as const,
        acknowledgementRef: "evidence://sink/retry-ack",
        acknowledgedAt: COMPUTED_AT,
      };
    });
    const bridge = new RoomRuntimeObservabilityBridge({
      sink: { publish } satisfies RoomRuntimeObservabilitySinkV1,
    });

    const rejected = await bridge.observe(input({ cursor: 5, eventId: "room-observability-retry-5" }));
    const retried = await bridge.observe(input({ cursor: 5, eventId: "room-observability-retry-5" }));

    expect(rejected).toMatchObject({
      ok: false,
      outcome: "withheld",
      reason: { code: "sink_ack_failed" },
    });
    expect(retried).toMatchObject({ ok: true, outcome: "published" });
    expect(publish).toHaveBeenCalledTimes(2);
  });
});
