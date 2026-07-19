import { describe, expect, it } from "vitest";

import {
  calculateRoomObservabilityMetrics,
  type RoomObservabilityMetricsInputV1,
} from "../room-observability-metrics.js";

const SCOPE = { projectId: "project-observability", roomId: "room-observability" } as const;
const COMPUTED_AT = "2026-07-19T05:10:00.000Z";
const WINDOW = {
  startedAt: "2026-07-19T05:09:00.000Z",
  endedAt: "2026-07-19T05:10:00.000Z",
} as const;

function input(
  overrides: Partial<RoomObservabilityMetricsInputV1> = {},
): RoomObservabilityMetricsInputV1 {
  return {
    contractVersion: 1,
    scope: SCOPE,
    computedAt: COMPUTED_AT,
    window: WINDOW,
    capacity: {
      scope: SCOPE,
      observedAt: COMPUTED_AT,
      configuredSlots: 10,
      eligibleSlots: 8,
      activeSlots: 6,
      reservedVerifierSlots: 1,
      reservedRecoverySlots: 1,
      degradedSlots: 0,
      blockedSlots: 0,
      retryingSlots: 0,
    },
    throughput: {
      scope: SCOPE,
      observedAt: COMPUTED_AT,
      completedTasks: 6,
      committedEvents: 12,
    },
    queue: {
      scope: SCOPE,
      observedAt: COMPUTED_AT,
      readyTasks: 5,
      queuedTasks: 3,
      blockedTasks: 1,
      retryingTasks: 1,
    },
    idle: {
      scope: SCOPE,
      observedAt: COMPUTED_AT,
      reasons: [
        { reason: "policy", count: 1 },
        { reason: "dependency", count: 1 },
      ],
    },
    wait: {
      scope: SCOPE,
      observedAt: COMPUTED_AT,
      reasons: [
        { reason: "backpressure", count: 1 },
        { reason: "dependency", count: 2 },
      ],
    },
    recovery: {
      scope: SCOPE,
      observedAt: COMPUTED_AT,
      attempted: 2,
      succeeded: 1,
      failed: 1,
      inFlight: 0,
    },
    ...overrides,
  };
}

describe("calculateRoomObservabilityMetrics", () => {
  it("derives deterministic capacity, queue, throughput, utilization, reasons, saturation, and recovery metrics", () => {
    const snapshot = calculateRoomObservabilityMetrics(input());

    expect(snapshot).toMatchObject({
      contractVersion: 1,
      scope: SCOPE,
      window: { ...WINDOW, durationMs: 60_000 },
      capacity: {
        configuredSlots: { state: "known", value: 10 },
        eligibleSlots: { state: "known", value: 8 },
        activeSlots: { state: "known", value: 6 },
        reservedVerifierSlots: { state: "known", value: 1 },
        reservedRecoverySlots: { state: "known", value: 1 },
      },
      throughput: {
        completedTasks: { state: "known", value: 6 },
        committedEvents: { state: "known", value: 12 },
        completedTasksPerSecond: {
          state: "known",
          numerator: 6,
          denominator: 60,
          value: 0.1,
        },
      },
      queue: {
        readyTasks: { state: "known", value: 5 },
        queuedTasks: { state: "known", value: 3 },
        blockedTasks: { state: "known", value: 1 },
        retryingTasks: { state: "known", value: 1 },
      },
      utilization: {
        basis: "instantaneous_active_slots",
        ratio: { state: "known", numerator: 6, denominator: 8, value: 0.75 },
      },
      saturation: {
        classification: "available",
        ratio: { state: "known", numerator: 6, denominator: 8, value: 0.75 },
      },
      recovery: {
        attempted: { state: "known", value: 2 },
        succeeded: { state: "known", value: 1 },
        failed: { state: "known", value: 1 },
        inFlight: { state: "known", value: 0 },
      },
      missingTelemetry: [],
    });
    expect(snapshot.idle).toEqual({
      observedAt: COMPUTED_AT,
      slots: { state: "known", value: 2 },
      reasonTelemetryState: "known",
      reasons: [
        { reason: "dependency", count: 1 },
        { reason: "policy", count: 1 },
      ],
      attributedSlots: { state: "known", value: 2 },
      unattributedSlots: { state: "known", value: 0 },
    });
    expect(snapshot.wait).toEqual({
      observedAt: COMPUTED_AT,
      reasonTelemetryState: "known",
      reasons: [
        { reason: "backpressure", count: 1 },
        { reason: "dependency", count: 2 },
      ],
      waitingTasksObserved: { state: "known", value: 3 },
    });
  });

  it("keeps absent telemetry unknown instead of fabricating zero counts or percentages", () => {
    const snapshot = calculateRoomObservabilityMetrics(input({
      capacity: null,
      throughput: null,
      queue: null,
      idle: null,
      wait: null,
      recovery: null,
    }));

    expect(snapshot.capacity.activeSlots).toEqual({ state: "unknown", value: null });
    expect(snapshot.throughput.completedTasksPerSecond).toEqual({
      state: "unknown",
      numerator: null,
      denominator: 60,
      value: null,
    });
    expect(snapshot.utilization.ratio).toEqual({
      state: "unknown",
      numerator: null,
      denominator: null,
      value: null,
    });
    expect(snapshot.saturation.classification).toBe("unknown");
    expect(snapshot.idle.slots).toEqual({ state: "unknown", value: null });
    expect(snapshot.wait.waitingTasksObserved).toEqual({ state: "unknown", value: null });
    expect(snapshot.missingTelemetry).toEqual([
      "capacity",
      "idle_reasons",
      "queue",
      "recovery",
      "throughput",
      "wait_reasons",
    ]);
  });

  it("preserves explicit observed zero as known, rather than conflating it with missing telemetry", () => {
    const snapshot = calculateRoomObservabilityMetrics(input({
      capacity: {
        scope: SCOPE,
        observedAt: COMPUTED_AT,
        configuredSlots: 4,
        eligibleSlots: 4,
        activeSlots: 0,
        reservedVerifierSlots: 0,
        reservedRecoverySlots: 0,
        degradedSlots: 0,
        blockedSlots: 0,
        retryingSlots: 0,
      },
      throughput: { scope: SCOPE, observedAt: COMPUTED_AT, completedTasks: 0, committedEvents: 0 },
      queue: { scope: SCOPE, observedAt: COMPUTED_AT, readyTasks: 0, queuedTasks: 0, blockedTasks: 0, retryingTasks: 0 },
      idle: { scope: SCOPE, observedAt: COMPUTED_AT, reasons: [] },
      wait: { scope: SCOPE, observedAt: COMPUTED_AT, reasons: [] },
      recovery: { scope: SCOPE, observedAt: COMPUTED_AT, attempted: 0, succeeded: 0, failed: 0, inFlight: 0 },
    }));

    expect(snapshot.capacity.activeSlots).toEqual({ state: "known", value: 0 });
    expect(snapshot.throughput.completedTasksPerSecond).toEqual({
      state: "known",
      numerator: 0,
      denominator: 60,
      value: 0,
    });
    expect(snapshot.idle).toMatchObject({
      slots: { state: "known", value: 4 },
      reasonTelemetryState: "known",
      attributedSlots: { state: "known", value: 0 },
      unattributedSlots: { state: "known", value: 4 },
    });
    expect(snapshot.wait.waitingTasksObserved).toEqual({ state: "known", value: 0 });
  });

  it("rejects telemetry whose explicit project or Room scope cannot belong to this snapshot", () => {
    expect(() => calculateRoomObservabilityMetrics(input({
      queue: {
        scope: { projectId: SCOPE.projectId, roomId: "another-room" },
        observedAt: COMPUTED_AT,
        readyTasks: 0,
        queuedTasks: 0,
        blockedTasks: 0,
        retryingTasks: 0,
      },
    }))).toThrow(/outside the requested project\/Room scope/u);
  });
});
