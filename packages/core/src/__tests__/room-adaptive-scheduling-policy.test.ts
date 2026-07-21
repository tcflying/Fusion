import { describe, expect, it } from "vitest";

import type {
  RoomAdaptiveSchedulingInputV1,
  RoomAdaptiveSchedulingWorkItemV1,
} from "../room-adaptive-scheduling-policy.js";
import { scheduleRoomAdaptiveWork } from "../room-adaptive-scheduling-policy.js";

const NOW = "2026-07-19T00:10:00.000Z";

function work(
  workId: string,
  overrides: Partial<RoomAdaptiveSchedulingWorkItemV1> = {},
): RoomAdaptiveSchedulingWorkItemV1 {
  return {
    workId,
    projectId: "project-a",
    roomId: "room-a",
    kind: "producer",
    qualityScore: 0.8,
    criticalPathDistance: 3,
    projectPriority: 50,
    roomPriority: 50,
    enqueuedAt: "2026-07-19T00:00:00.000Z",
    requiredSlots: 1,
    ...overrides,
  };
}

function input(
  queued: readonly RoomAdaptiveSchedulingWorkItemV1[],
  overrides: Partial<RoomAdaptiveSchedulingInputV1> = {},
): RoomAdaptiveSchedulingInputV1 {
  return {
    asOf: NOW,
    capacity: {
      totalSlots: 4,
      reservedVerifierSlots: 1,
      reservedRecoverySlots: 1,
    },
    policy: {
      minimumProjectReservations: [],
      minimumRoomReservations: [],
      fairnessAgingQuantumMs: 60_000,
      preemptionEnabled: true,
    },
    queued,
    active: [],
    ...overrides,
  };
}

describe("room adaptive scheduling policy", () => {
  it("is quality-first, then gives equal-quality work to the critical path deterministically", () => {
    const result = scheduleRoomAdaptiveWork(input([
      work("high-quality-noncritical", { qualityScore: 0.95, criticalPathDistance: 9 }),
      work("same-quality-critical", { qualityScore: 0.9, criticalPathDistance: 1 }),
      work("same-quality-noncritical", { qualityScore: 0.9, criticalPathDistance: 5 }),
    ], {
      capacity: { totalSlots: 2, reservedVerifierSlots: 0, reservedRecoverySlots: 0 },
    }));

    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({
        scheduledWorkIds: ["high-quality-noncritical", "same-quality-critical"],
        preemptedWorkIds: [],
      }),
    });
  });

  it("honors project and Room minimum reservations before filling remaining capacity", () => {
    const result = scheduleRoomAdaptiveWork(input([
      work("project-a-best", { qualityScore: 0.99, projectId: "project-a", roomId: "room-a" }),
      work("project-a-second", { qualityScore: 0.98, projectId: "project-a", roomId: "room-b" }),
      work("project-b-reserved", { qualityScore: 0.7, projectId: "project-b", roomId: "room-c" }),
      work("room-d-reserved", { qualityScore: 0.6, projectId: "project-c", roomId: "room-d" }),
    ], {
      capacity: { totalSlots: 3, reservedVerifierSlots: 0, reservedRecoverySlots: 0 },
      policy: {
        minimumProjectReservations: [{ projectId: "project-b", minimumSlots: 1 }],
        minimumRoomReservations: [{ roomId: "room-d", minimumSlots: 1 }],
        fairnessAgingQuantumMs: 60_000,
        preemptionEnabled: true,
      },
    }));

    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({
        scheduledWorkIds: ["project-a-best", "project-b-reserved", "room-d-reserved"],
      }),
    });
  });

  it("uses fair active-share ordering before queue age when quality and priority tie", () => {
    const result = scheduleRoomAdaptiveWork(input([
      work("busy-project", { projectId: "project-busy", enqueuedAt: "2026-07-18T23:00:00.000Z" }),
      work("idle-project", { projectId: "project-idle", enqueuedAt: "2026-07-19T00:09:00.000Z" }),
    ], {
      capacity: { totalSlots: 3, reservedVerifierSlots: 0, reservedRecoverySlots: 0 },
      active: [
        { ...work("already-running", { projectId: "project-busy" }), startedAt: "2026-07-19T00:00:00.000Z", atTurnBoundary: false },
        { ...work("already-running-2", { projectId: "project-busy" }), startedAt: "2026-07-19T00:00:00.000Z", atTurnBoundary: false },
      ],
    }));

    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({ scheduledWorkIds: ["idle-project"] }),
    });
  });

  it("reserves verifier and recovery slots from producer work while allowing those protected kinds to run", () => {
    const result = scheduleRoomAdaptiveWork(input([
      work("producer-1"),
      work("producer-2"),
      work("producer-3"),
      work("verifier", { kind: "verifier", qualityScore: 0.6 }),
      work("recovery", { kind: "recovery", qualityScore: 0.5 }),
    ]));

    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({
        scheduledWorkIds: ["producer-1", "producer-2", "verifier", "recovery"],
        reservedCapacity: { verifierSlots: 1, recoverySlots: 1 },
      }),
    });
  });

  it("preempts only lower-quality producer work that is safely at a turn boundary", () => {
    const result = scheduleRoomAdaptiveWork(input([
      work("critical-verifier", { kind: "verifier", qualityScore: 0.99, criticalPathDistance: 0 }),
    ], {
      capacity: { totalSlots: 2, reservedVerifierSlots: 0, reservedRecoverySlots: 0 },
      active: [
        { ...work("unsafe-running", { qualityScore: 0.1 }), startedAt: "2026-07-19T00:00:00.000Z", atTurnBoundary: false },
        { ...work("safe-running", { qualityScore: 0.2 }), startedAt: "2026-07-19T00:00:00.000Z", atTurnBoundary: true },
      ],
    }));

    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({
        scheduledWorkIds: ["critical-verifier"],
        preemptedWorkIds: ["safe-running"],
      }),
    });
  });

  it("rejects duplicate IDs, impossible reservations, and invalid timestamps without partial scheduling", () => {
    const result = scheduleRoomAdaptiveWork(input([
      work("duplicate"),
      work("duplicate", { roomId: "room-other", enqueuedAt: "not-a-time" }),
    ], {
      capacity: { totalSlots: 1, reservedVerifierSlots: 1, reservedRecoverySlots: 1 },
    }));

    expect(result).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "duplicate_work_id" }),
        expect.objectContaining({ code: "invalid_timestamp" }),
        expect.objectContaining({ code: "capacity_reservation_exceeds_total" }),
      ]),
    });
  });
});
