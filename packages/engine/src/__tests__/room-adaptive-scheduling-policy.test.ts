import { describe, expect, it } from "vitest";

import {
  scheduleRoomAdaptiveWork,
  type RoomAdaptiveSchedulingWorkItemV1,
} from "../room-adaptive-scheduling-policy.js";

const NOW = "2026-07-19T16:00:00.000Z";

describe("room adaptive scheduling policy", () => {
  it("keeps independent quality evidence first and breaks equal-quality work by critical-path distance", () => {
    const result = scheduleRoomAdaptiveWork({
      contractVersion: 1,
      asOf: NOW,
      canonicalState: {
        source: "room_controller",
        snapshotId: "snapshot-critical-path",
        observedAt: NOW,
        sequence: 4,
        fairness: {
          source: "room_controller",
          windowStartedAt: "2026-07-19T15:00:00.000Z",
          projectAllocatedSlots: [],
          roomAllocatedSlots: [],
        },
        queued: [
          {
            workId: "equal-quality-far",
            projectId: "project-a",
            roomId: "room-a",
            kind: "producer",
            qualityScore: 0.8,
            criticalPathDistance: 8,
            projectPriority: 5,
            roomPriority: 5,
            enqueuedAt: "2026-07-19T15:40:00.000Z",
            requiredSlots: 1,
          },
          {
            workId: "higher-quality-far",
            projectId: "project-a",
            roomId: "room-a",
            kind: "producer",
            qualityScore: 0.9,
            criticalPathDistance: 20,
            projectPriority: 5,
            roomPriority: 5,
            enqueuedAt: "2026-07-19T15:45:00.000Z",
            requiredSlots: 1,
          },
          {
            workId: "equal-quality-near",
            projectId: "project-b",
            roomId: "room-b",
            kind: "producer",
            qualityScore: 0.8,
            criticalPathDistance: 1,
            projectPriority: 5,
            roomPriority: 5,
            enqueuedAt: "2026-07-19T15:50:00.000Z",
            requiredSlots: 1,
          },
        ],
        active: [],
      },
      capacity: {
        totalSlots: 2,
        reservedVerifierSlots: 0,
        reservedRecoverySlots: 0,
      },
      policy: {
        minimumProjectReservations: [],
        minimumRoomReservations: [],
        fairnessAgingQuantumMs: 60_000,
        preemptionEnabled: true,
      },
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        selectedWorkIds: ["higher-quality-far", "equal-quality-near"],
      },
    });
  });

  it("uses canonical project priority and then Room priority after quality and critical-path ties", () => {
    const result = scheduleRoomAdaptiveWork({
      contractVersion: 1,
      asOf: NOW,
      canonicalState: {
        source: "room_controller",
        snapshotId: "snapshot-priorities",
        observedAt: NOW,
        sequence: 5,
        fairness: {
          source: "room_controller",
          windowStartedAt: "2026-07-19T15:00:00.000Z",
          projectAllocatedSlots: [],
          roomAllocatedSlots: [],
        },
        queued: [
          {
            workId: "project-low",
            projectId: "project-low",
            roomId: "room-low",
            kind: "producer",
            qualityScore: 0.8,
            criticalPathDistance: 2,
            projectPriority: 1,
            roomPriority: 100,
            enqueuedAt: "2026-07-19T15:40:00.000Z",
            requiredSlots: 1,
          },
          {
            workId: "room-low",
            projectId: "project-high",
            roomId: "room-low",
            kind: "producer",
            qualityScore: 0.8,
            criticalPathDistance: 2,
            projectPriority: 9,
            roomPriority: 1,
            enqueuedAt: "2026-07-19T15:41:00.000Z",
            requiredSlots: 1,
          },
          {
            workId: "room-high",
            projectId: "project-high",
            roomId: "room-high",
            kind: "producer",
            qualityScore: 0.8,
            criticalPathDistance: 2,
            projectPriority: 9,
            roomPriority: 9,
            enqueuedAt: "2026-07-19T15:42:00.000Z",
            requiredSlots: 1,
          },
        ],
        active: [],
      },
      capacity: { totalSlots: 1, reservedVerifierSlots: 0, reservedRecoverySlots: 0 },
      policy: {
        minimumProjectReservations: [],
        minimumRoomReservations: [],
        fairnessAgingQuantumMs: 60_000,
        preemptionEnabled: true,
      },
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        selectedWorkIds: ["room-high"],
        workDecisions: expect.arrayContaining([
          expect.objectContaining({ workId: "room-high", reasons: ["project_priority_tiebreak", "room_priority_tiebreak"] }),
        ]),
      },
    });
  });

  it("honors a canonical minimum project reservation before filling capacity by quality", () => {
    const result = scheduleRoomAdaptiveWork({
      contractVersion: 1,
      asOf: NOW,
      canonicalState: {
        source: "room_controller",
        snapshotId: "snapshot-reservations",
        observedAt: NOW,
        sequence: 6,
        fairness: {
          source: "room_controller",
          windowStartedAt: "2026-07-19T15:00:00.000Z",
          projectAllocatedSlots: [{ projectId: "project-b", slots: 8 }],
          roomAllocatedSlots: [{ roomId: "room-b", slots: 8 }],
        },
        queued: [
          {
            workId: "project-a-best",
            projectId: "project-a",
            roomId: "room-a",
            kind: "producer",
            qualityScore: 0.99,
            criticalPathDistance: 1,
            projectPriority: 9,
            roomPriority: 9,
            enqueuedAt: "2026-07-19T15:40:00.000Z",
            requiredSlots: 1,
          },
          {
            workId: "project-a-second",
            projectId: "project-a",
            roomId: "room-a",
            kind: "producer",
            qualityScore: 0.98,
            criticalPathDistance: 2,
            projectPriority: 9,
            roomPriority: 9,
            enqueuedAt: "2026-07-19T15:41:00.000Z",
            requiredSlots: 1,
          },
          {
            workId: "project-b-reserved",
            projectId: "project-b",
            roomId: "room-b",
            kind: "producer",
            qualityScore: 0.2,
            criticalPathDistance: 9,
            projectPriority: 1,
            roomPriority: 1,
            enqueuedAt: "2026-07-19T15:42:00.000Z",
            requiredSlots: 1,
          },
        ],
        active: [],
      },
      capacity: { totalSlots: 2, reservedVerifierSlots: 0, reservedRecoverySlots: 0 },
      policy: {
        minimumProjectReservations: [{ projectId: "project-b", minimumSlots: 1 }],
        minimumRoomReservations: [],
        fairnessAgingQuantumMs: 60_000,
        preemptionEnabled: true,
      },
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        selectedWorkIds: ["project-b-reserved", "project-a-best"],
        workDecisions: expect.arrayContaining([
          expect.objectContaining({ workId: "project-b-reserved", reasons: ["minimum_project_reservation"] }),
        ]),
      },
    });
  });

  it("uses controller-owned allocation history to give the next equal-ranked slot to the project that was not repeatedly admitted", () => {
    const result = scheduleRoomAdaptiveWork({
      contractVersion: 1,
      asOf: NOW,
      canonicalState: {
        source: "room_controller",
        snapshotId: "snapshot-fairness-window",
        observedAt: NOW,
        sequence: 7,
        fairness: {
          source: "room_controller",
          windowStartedAt: "2026-07-19T15:00:00.000Z",
          projectAllocatedSlots: [
            { projectId: "project-a", slots: 4 },
            { projectId: "project-b", slots: 0 },
          ],
          roomAllocatedSlots: [
            { roomId: "room-a", slots: 4 },
            { roomId: "room-b", slots: 0 },
          ],
        },
        queued: [
          {
            workId: "project-a-older",
            projectId: "project-a",
            roomId: "room-a",
            kind: "producer",
            qualityScore: 0.8,
            criticalPathDistance: 2,
            projectPriority: 5,
            roomPriority: 5,
            enqueuedAt: "2026-07-19T15:01:00.000Z",
            requiredSlots: 1,
          },
          {
            workId: "project-b-next",
            projectId: "project-b",
            roomId: "room-b",
            kind: "producer",
            qualityScore: 0.8,
            criticalPathDistance: 2,
            projectPriority: 5,
            roomPriority: 5,
            enqueuedAt: "2026-07-19T15:59:00.000Z",
            requiredSlots: 1,
          },
        ],
        active: [],
      },
      capacity: { totalSlots: 1, reservedVerifierSlots: 0, reservedRecoverySlots: 0 },
      policy: {
        minimumProjectReservations: [],
        minimumRoomReservations: [],
        fairnessAgingQuantumMs: 60_000,
        preemptionEnabled: true,
      },
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        selectedWorkIds: ["project-b-next"],
        workDecisions: expect.arrayContaining([
          expect.objectContaining({ workId: "project-b-next", reasons: ["fairness_tiebreak"] }),
        ]),
      },
    });
  });

  it("uses aging after canonical allocation shares tie", () => {
    const result = scheduleRoomAdaptiveWork({
      contractVersion: 1,
      asOf: NOW,
      canonicalState: {
        source: "room_controller",
        snapshotId: "snapshot-aging",
        observedAt: NOW,
        sequence: 8,
        fairness: {
          source: "room_controller",
          windowStartedAt: "2026-07-19T15:00:00.000Z",
          projectAllocatedSlots: [],
          roomAllocatedSlots: [],
        },
        queued: [
          {
            workId: "a-newer",
            projectId: "project-a",
            roomId: "room-a",
            kind: "producer",
            qualityScore: 0.8,
            criticalPathDistance: 2,
            projectPriority: 5,
            roomPriority: 5,
            enqueuedAt: "2026-07-19T15:59:00.000Z",
            requiredSlots: 1,
          },
          {
            workId: "z-older",
            projectId: "project-b",
            roomId: "room-b",
            kind: "producer",
            qualityScore: 0.8,
            criticalPathDistance: 2,
            projectPriority: 5,
            roomPriority: 5,
            enqueuedAt: "2026-07-19T15:01:00.000Z",
            requiredSlots: 1,
          },
        ],
        active: [],
      },
      capacity: { totalSlots: 1, reservedVerifierSlots: 0, reservedRecoverySlots: 0 },
      policy: {
        minimumProjectReservations: [],
        minimumRoomReservations: [],
        fairnessAgingQuantumMs: 60_000,
        preemptionEnabled: true,
      },
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        selectedWorkIds: ["z-older"],
        workDecisions: expect.arrayContaining([
          expect.objectContaining({ workId: "z-older", reasons: ["aging_tiebreak"] }),
        ]),
      },
    });
  });

  it("refuses to preempt a mid-turn worker even when a higher-quality task is queued", () => {
    const result = scheduleRoomAdaptiveWork({
      contractVersion: 1,
      asOf: NOW,
      canonicalState: {
        source: "room_controller",
        snapshotId: "snapshot-mid-turn",
        observedAt: NOW,
        sequence: 9,
        fairness: {
          source: "room_controller",
          windowStartedAt: "2026-07-19T15:00:00.000Z",
          projectAllocatedSlots: [],
          roomAllocatedSlots: [],
        },
        queued: [
          {
            workId: "high-quality-queued",
            projectId: "project-b",
            roomId: "room-b",
            kind: "producer",
            qualityScore: 0.99,
            criticalPathDistance: 0,
            projectPriority: 9,
            roomPriority: 9,
            enqueuedAt: "2026-07-19T15:59:00.000Z",
            requiredSlots: 1,
          },
        ],
        active: [
          {
            workId: "mid-turn-worker",
            projectId: "project-a",
            roomId: "room-a",
            kind: "producer",
            qualityScore: 0.1,
            criticalPathDistance: 9,
            projectPriority: 1,
            roomPriority: 1,
            enqueuedAt: "2026-07-19T15:00:00.000Z",
            startedAt: "2026-07-19T15:10:00.000Z",
            requiredSlots: 1,
            turnBoundary: {
              source: "room_controller",
              state: "mid_turn",
              observedAt: NOW,
            },
          },
        ],
      },
      capacity: { totalSlots: 1, reservedVerifierSlots: 0, reservedRecoverySlots: 0 },
      policy: {
        minimumProjectReservations: [],
        minimumRoomReservations: [],
        fairnessAgingQuantumMs: 60_000,
        preemptionEnabled: true,
      },
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        selectedWorkIds: [],
        preemptedWorkIds: [],
        workDecisions: expect.arrayContaining([
          expect.objectContaining({ workId: "high-quality-queued", disposition: "refused", reasons: ["no_safe_turn_boundary"] }),
        ]),
      },
    });
  });

  it("preempts only a lower-ranked producer at a controller-recorded safe turn boundary", () => {
    const result = scheduleRoomAdaptiveWork({
      contractVersion: 1,
      asOf: NOW,
      canonicalState: {
        source: "event_ledger",
        snapshotId: "snapshot-safe-turn",
        observedAt: NOW,
        sequence: 10,
        fairness: {
          source: "event_ledger",
          windowStartedAt: "2026-07-19T15:00:00.000Z",
          projectAllocatedSlots: [],
          roomAllocatedSlots: [],
        },
        queued: [
          {
            workId: "high-quality-queued",
            projectId: "project-b",
            roomId: "room-b",
            kind: "verifier",
            qualityScore: 0.99,
            criticalPathDistance: 0,
            projectPriority: 9,
            roomPriority: 9,
            enqueuedAt: "2026-07-19T15:59:00.000Z",
            requiredSlots: 1,
          },
        ],
        active: [
          {
            workId: "safe-turn-worker",
            projectId: "project-a",
            roomId: "room-a",
            kind: "producer",
            qualityScore: 0.1,
            criticalPathDistance: 9,
            projectPriority: 1,
            roomPriority: 1,
            enqueuedAt: "2026-07-19T15:00:00.000Z",
            startedAt: "2026-07-19T15:10:00.000Z",
            requiredSlots: 1,
            turnBoundary: {
              source: "event_ledger",
              state: "safe",
              observedAt: NOW,
            },
          },
        ],
      },
      capacity: { totalSlots: 1, reservedVerifierSlots: 0, reservedRecoverySlots: 0 },
      policy: {
        minimumProjectReservations: [],
        minimumRoomReservations: [],
        fairnessAgingQuantumMs: 60_000,
        preemptionEnabled: true,
      },
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        selectedWorkIds: ["high-quality-queued"],
        preemptedWorkIds: ["safe-turn-worker"],
        workDecisions: expect.arrayContaining([
          expect.objectContaining({
            workId: "safe-turn-worker",
            disposition: "preempted",
            reasons: ["safe_turn_boundary_preemption"],
          }),
        ]),
      },
    });
  });

  it("is order-independent and explains an otherwise exact tie with the stable work ID", () => {
    const makeInput = (queued: readonly RoomAdaptiveSchedulingWorkItemV1[]) => ({
      contractVersion: 1 as const,
      asOf: NOW,
      canonicalState: {
        source: "room_controller" as const,
        snapshotId: "snapshot-deterministic-tie",
        observedAt: NOW,
        sequence: 11,
        fairness: {
          source: "room_controller" as const,
          windowStartedAt: "2026-07-19T15:00:00.000Z",
          projectAllocatedSlots: [],
          roomAllocatedSlots: [],
        },
        queued,
        active: [],
      },
      capacity: { totalSlots: 1, reservedVerifierSlots: 0, reservedRecoverySlots: 0 },
      policy: {
        minimumProjectReservations: [],
        minimumRoomReservations: [],
        fairnessAgingQuantumMs: 60_000,
        preemptionEnabled: true,
      },
    });
    const alpha: RoomAdaptiveSchedulingWorkItemV1 = {
      workId: "alpha",
      projectId: "project-a",
      roomId: "room-a",
      kind: "producer",
      qualityScore: 0.8,
      criticalPathDistance: 2,
      projectPriority: 5,
      roomPriority: 5,
      enqueuedAt: "2026-07-19T15:00:00.000Z",
      requiredSlots: 1,
    };
    const beta: RoomAdaptiveSchedulingWorkItemV1 = { ...alpha, workId: "beta" };

    const forward = scheduleRoomAdaptiveWork(makeInput([alpha, beta]));
    const reversed = scheduleRoomAdaptiveWork(makeInput([beta, alpha]));

    expect(reversed).toEqual(forward);
    expect(forward).toMatchObject({
      ok: true,
      value: {
        selectedWorkIds: ["alpha"],
        workDecisions: expect.arrayContaining([
          expect.objectContaining({ workId: "alpha", reasons: ["deterministic_work_id_tiebreak"] }),
        ]),
      },
    });
  });

  it("fails closed when its state is malformed or supplied by a worker self-report", () => {
    const result = scheduleRoomAdaptiveWork({
      contractVersion: 99,
      asOf: "not-a-canonical-time",
      canonicalState: {
        source: "worker_self_report",
        snapshotId: "",
        observedAt: "not-a-canonical-time",
        sequence: -1,
        fairness: {
          source: "worker_self_report",
          windowStartedAt: "not-a-canonical-time",
          projectAllocatedSlots: [{ projectId: "project-a", slots: -1 }],
          roomAllocatedSlots: [{ roomId: "room-a", slots: -1 }],
        },
        queued: [
          {
            workId: "",
            projectId: "project-a",
            roomId: "room-a",
            kind: "worker_claim",
            qualityScore: 1.1,
            criticalPathDistance: -1,
            projectPriority: -1,
            roomPriority: -1,
            enqueuedAt: "not-a-canonical-time",
            requiredSlots: 0,
          },
        ],
        active: [],
      },
      capacity: { totalSlots: 0, reservedVerifierSlots: 1, reservedRecoverySlots: 1 },
      policy: {
        minimumProjectReservations: [{ projectId: "", minimumSlots: 0 }],
        minimumRoomReservations: [],
        fairnessAgingQuantumMs: 0,
        preemptionEnabled: "yes",
      },
    } as never);

    expect(result).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "unauthorized_state_source", path: "canonicalState.source" }),
        expect.objectContaining({ code: "invalid_timestamp", path: "asOf" }),
        expect.objectContaining({ code: "invalid_input", path: "capacity.totalSlots" }),
      ]),
    });
  });

  it("protects verifier and recovery capacity from producer-only pressure", () => {
    const result = scheduleRoomAdaptiveWork({
      contractVersion: 1,
      asOf: NOW,
      canonicalState: {
        source: "room_controller",
        snapshotId: "snapshot-protected-capacity",
        observedAt: NOW,
        sequence: 12,
        fairness: {
          source: "room_controller",
          windowStartedAt: "2026-07-19T15:00:00.000Z",
          projectAllocatedSlots: [],
          roomAllocatedSlots: [],
        },
        queued: [
          {
            workId: "producer-high",
            projectId: "project-a",
            roomId: "room-a",
            kind: "producer",
            qualityScore: 0.99,
            criticalPathDistance: 1,
            projectPriority: 9,
            roomPriority: 9,
            enqueuedAt: "2026-07-19T15:00:00.000Z",
            requiredSlots: 1,
          },
          {
            workId: "producer-second",
            projectId: "project-b",
            roomId: "room-b",
            kind: "producer",
            qualityScore: 0.98,
            criticalPathDistance: 2,
            projectPriority: 8,
            roomPriority: 8,
            enqueuedAt: "2026-07-19T15:00:00.000Z",
            requiredSlots: 1,
          },
          {
            workId: "verifier",
            projectId: "project-c",
            roomId: "room-c",
            kind: "verifier",
            qualityScore: 0.2,
            criticalPathDistance: 9,
            projectPriority: 1,
            roomPriority: 1,
            enqueuedAt: "2026-07-19T15:00:00.000Z",
            requiredSlots: 1,
          },
        ],
        active: [],
      },
      capacity: { totalSlots: 2, reservedVerifierSlots: 1, reservedRecoverySlots: 0 },
      policy: {
        minimumProjectReservations: [],
        minimumRoomReservations: [],
        fairnessAgingQuantumMs: 60_000,
        preemptionEnabled: true,
      },
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        selectedWorkIds: ["producer-high", "verifier"],
        workDecisions: expect.arrayContaining([
          expect.objectContaining({ workId: "producer-second", disposition: "refused", reasons: ["reserved_capacity_protected"] }),
        ]),
      },
    });
  });
});
