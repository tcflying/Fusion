import { describe, expect, it, vi } from "vitest";

import {
  createRoomAggregate,
  transitionRoomLifecycle,
  type RoomAggregateV1,
  type StoredRoomLeaseV1,
} from "@fusion/core";

import {
  RoomController,
  type RoomCandidateFanoutBlindReviewWorkflowV1,
  type RoomCandidateSynthesisWorkflowV1,
  type RoomControllerLeaseStore,
  type RoomDeterministicEvidenceGateWorkflowV1,
  type RoomIndependentArbitrationWorkflowV1,
  type RoomWorkerBlindReviewFanoutInputV1,
  type RoomWorkerCandidateSynthesisInputV1,
  type RoomWorkerDeterministicEvidenceGateInputV1,
  type RoomWorkerIndependentArbitrationInputV1,
  type RoomWorkerRunInput,
} from "../room-controller.js";

function runningRoom(): RoomAggregateV1 {
  const draft = createRoomAggregate({
    id: "room-evidence-workflow",
    projectId: "project-evidence-workflow",
    objective: "Exercise controller-owned evidence workflows",
    protocolId: "implementation",
    protocolVersion: 1,
    now: "2026-07-19T14:00:00.000Z",
  });
  const ready = transitionRoomLifecycle(draft, {
    to: "ready",
    expectedAggregateVersion: 0,
    now: "2026-07-19T14:00:01.000Z",
  });
  return transitionRoomLifecycle(ready, {
    to: "running",
    expectedAggregateVersion: 1,
    now: "2026-07-19T14:00:02.000Z",
  });
}

function lease(): StoredRoomLeaseV1 {
  return {
    contractVersion: 1,
    id: "lease-evidence-workflow",
    roomId: "room-evidence-workflow",
    kind: "room_worker",
    resourceId: "room-evidence-workflow",
    holderId: "worker-evidence-workflow",
    hostId: "host-evidence-workflow",
    epoch: 1,
    acquiredAt: "2026-07-19T14:00:00.000Z",
    heartbeatAt: "2026-07-19T14:00:00.000Z",
    expiresAt: "2026-07-19T14:01:00.000Z",
    releasedAt: null,
  };
}

function leaseStore(): RoomControllerLeaseStore {
  let current = lease();
  return {
    acquireLease: vi.fn(async () => ({ ok: true as const, action: "acquired" as const, lease: current })),
    renewLease: vi.fn(async (input) => {
      current = { ...current, heartbeatAt: input.now, expiresAt: input.expiresAt };
      return { ok: true as const, lease: current };
    }),
    releaseLease: vi.fn(async (input) => {
      current = { ...current, releasedAt: input.now };
      return { ok: true as const, lease: current };
    }),
    assertFence: vi.fn(async () => current),
  };
}

function arbitrationInput(expectedAggregateVersion: number): RoomWorkerIndependentArbitrationInputV1 {
  return {
    expectedAggregateVersion,
    contractVersion: 1,
    nodeId: "node-arbitration",
    candidates: [],
    reviews: [],
    hardGateResults: [],
    dissents: [],
    riskPolicy: {
      minimumIndependentReviewsPerCandidate: 1,
      tieRisk: "low",
      allowedResidualDissentSeverities: [],
    },
    arbiter: {
      bindingId: "arbiter-1",
      selectedCandidateId: null,
      rationale: "No candidate is eligible.",
    },
    command: {
      commandId: "command-arbitration",
      idempotencyKey: "idempotency-arbitration",
      correlationId: "correlation-arbitration",
      causationId: null,
    },
    decisionId: "decision-arbitration",
    decidedAt: "2026-07-19T14:00:03.000Z",
  };
}

function synthesisInput(expectedAggregateVersion: number): RoomWorkerCandidateSynthesisInputV1 {
  return {
    expectedAggregateVersion,
    contractVersion: 1,
    nodeId: "node-synthesis",
    comparisonId: "comparison-synthesis",
    parentCandidateIds: ["candidate-a", "candidate-b"],
    command: {
      commandId: "command-synthesis",
      idempotencyKey: "idempotency-synthesis",
      correlationId: "correlation-synthesis",
      causationId: null,
    },
    child: {
      contractVersion: 1,
      id: "candidate-child",
      producingBindingId: "binding-synthesis",
      nativeSessionId: "native-synthesis",
      happierSessionId: "happier-synthesis",
      providerId: "provider-synthesis",
      modelRef: "model-synthesis",
      protocolId: "implementation",
      protocolVersion: 1,
      contextVersion: "context-v1",
      inputVersion: "input-v1",
      configVersion: "config-v1",
      contentHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      artifactIds: ["artifact-child"],
      gateResultIds: [],
      reviewIds: [],
      promotionState: "pending",
      createdAt: "2026-07-19T14:00:03.000Z",
    },
  };
}

function blindReviewFanoutInput(expectedAggregateVersion: number): RoomWorkerBlindReviewFanoutInputV1 {
  return {
    expectedAggregateVersion,
    contractVersion: 1,
    nodeId: "node-blind-fanout",
    reviewRoundId: "review-round-blind-fanout",
    idempotencyKey: "idempotency-blind-fanout",
    now: "2026-07-19T14:00:03.000Z",
    createdAt: "2026-07-19T14:00:03.000Z",
    expiresAt: "2026-07-19T14:05:00.000Z",
    candidateIds: ["candidate-a", "candidate-b"],
    reviewerBindingIds: ["reviewer-a", "reviewer-b"],
    minimumReviewerCount: 2,
  };
}

function deterministicEvidenceGateInput(expectedAggregateVersion: number): RoomWorkerDeterministicEvidenceGateInputV1 {
  return {
    expectedAggregateVersion,
    contractVersion: 1,
    candidate: {
      id: "candidate-deterministic-gate",
      nodeId: "node-deterministic-gate",
      contentHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      roomHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      scopeHash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      producingBindingId: "producer-deterministic-gate",
    },
    gates: [{
      id: "gate-rule",
      kind: "rule",
      gateResultId: "gate-result-rule",
      profileId: "profile-rule",
    }],
  };
}

describe("RoomController evidence workflows", () => {
  it("injects controller-owned scope only after a current worker fence into arbitration and synthesis", async () => {
    const room = runningRoom();
    const arbitration: RoomIndependentArbitrationWorkflowV1 = {
      arbitrate: vi.fn(async () => ({
        status: "withheld" as const,
        reason: { code: "invalid_request" as const, message: "fixture" },
        modelOrArbiterMayOverrideHardGates: false as const,
      })),
    };
    const synthesis: RoomCandidateSynthesisWorkflowV1 = {
      synthesize: vi.fn(async () => ({
        status: "withheld" as const,
        reason: { code: "comparison_not_found" as const, message: "fixture" },
      })),
    };
    const runRoom = vi.fn(async (input: RoomWorkerRunInput) => {
      expect(input.arbitrateCandidates).toBeTypeOf("function");
      expect(input.synthesizeCandidates).toBeTypeOf("function");
      await input.arbitrateCandidates!(arbitrationInput(room.room.aggregateVersion));
      await input.synthesizeCandidates!(synthesisInput(room.room.aggregateVersion));
    });
    const controller = new RoomController({
      projectId: room.room.projectId,
      workerId: "worker-evidence-workflow",
      hostId: "host-evidence-workflow",
      roomStore: { listRunnableRooms: async () => [room] },
      leaseStore: leaseStore(),
      worker: { runRoom },
      evidenceWorkflows: { arbitration, synthesis },
      recordRunAuditEvent: async () => undefined,
      now: () => "2026-07-19T14:00:03.000Z",
      createLeaseId: () => "lease-evidence-workflow",
      leaseDurationMs: 60_000,
      pollIntervalMs: 60_000,
    });

    await controller.start();

    expect(arbitration.arbitrate).toHaveBeenCalledWith(expect.objectContaining({
      scope: { projectId: room.room.projectId, roomId: room.room.id },
      nodeId: "node-arbitration",
    }));
    expect(synthesis.synthesize).toHaveBeenCalledWith(expect.objectContaining({
      scope: { projectId: room.room.projectId, roomId: room.room.id },
      nodeId: "node-synthesis",
    }));
    await controller.stop();
  });

  it("rejects a stale worker workflow callback before it reaches a coordinator", async () => {
    const room = runningRoom();
    const arbitration: RoomIndependentArbitrationWorkflowV1 = {
      arbitrate: vi.fn(async () => ({
        status: "withheld" as const,
        reason: { code: "invalid_request" as const, message: "fixture" },
        modelOrArbiterMayOverrideHardGates: false as const,
      })),
    };
    const runRoom = vi.fn(async (input: RoomWorkerRunInput) => {
      await expect(
        input.arbitrateCandidates!(arbitrationInput(room.room.aggregateVersion + 1)),
      ).rejects.toThrow("arbitration_aggregate_version_changed");
    });
    const controller = new RoomController({
      projectId: room.room.projectId,
      workerId: "worker-evidence-workflow",
      hostId: "host-evidence-workflow",
      roomStore: { listRunnableRooms: async () => [room] },
      leaseStore: leaseStore(),
      worker: { runRoom },
      evidenceWorkflows: { arbitration },
      recordRunAuditEvent: async () => undefined,
      now: () => "2026-07-19T14:00:03.000Z",
      createLeaseId: () => "lease-evidence-workflow",
      leaseDurationMs: 60_000,
      pollIntervalMs: 60_000,
    });

    await controller.start();

    expect(arbitration.arbitrate).not.toHaveBeenCalled();
    await controller.stop();
  });

  it("injects controller-owned scope into blind candidate fan-out only after the worker fence is current", async () => {
    const room = runningRoom();
    const blindReviewFanout: RoomCandidateFanoutBlindReviewWorkflowV1 = {
      prepare: vi.fn(async () => ({
        status: "withheld" as const,
        code: "minimum_reviewers_not_met" as const,
        message: "fixture",
      })),
    };
    const runRoom = vi.fn(async (input: RoomWorkerRunInput) => {
      expect(input.prepareBlindReviewFanout).toBeTypeOf("function");
      await input.prepareBlindReviewFanout!(blindReviewFanoutInput(room.room.aggregateVersion));
    });
    const controller = new RoomController({
      projectId: room.room.projectId,
      workerId: "worker-evidence-workflow",
      hostId: "host-evidence-workflow",
      roomStore: { listRunnableRooms: async () => [room] },
      leaseStore: leaseStore(),
      worker: { runRoom },
      evidenceWorkflows: { blindReviewFanout },
      recordRunAuditEvent: async () => undefined,
      now: () => "2026-07-19T14:00:03.000Z",
      createLeaseId: () => "lease-evidence-workflow",
      leaseDurationMs: 60_000,
      pollIntervalMs: 60_000,
    });

    await controller.start();

    expect(blindReviewFanout.prepare).toHaveBeenCalledWith(expect.objectContaining({
      scope: { projectId: room.room.projectId, roomId: room.room.id },
      nodeId: "node-blind-fanout",
    }));
    await controller.stop();
  });

  it("rejects a stale blind-review fan-out callback before it reaches the workflow", async () => {
    const room = runningRoom();
    const blindReviewFanout: RoomCandidateFanoutBlindReviewWorkflowV1 = {
      prepare: vi.fn(async () => ({
        status: "withheld" as const,
        code: "minimum_reviewers_not_met" as const,
        message: "fixture",
      })),
    };
    const runRoom = vi.fn(async (input: RoomWorkerRunInput) => {
      await expect(
        input.prepareBlindReviewFanout!(blindReviewFanoutInput(room.room.aggregateVersion + 1)),
      ).rejects.toThrow("blind_review_fanout_aggregate_version_changed");
    });
    const controller = new RoomController({
      projectId: room.room.projectId,
      workerId: "worker-evidence-workflow",
      hostId: "host-evidence-workflow",
      roomStore: { listRunnableRooms: async () => [room] },
      leaseStore: leaseStore(),
      worker: { runRoom },
      evidenceWorkflows: { blindReviewFanout },
      recordRunAuditEvent: async () => undefined,
      now: () => "2026-07-19T14:00:03.000Z",
      createLeaseId: () => "lease-evidence-workflow",
      leaseDurationMs: 60_000,
      pollIntervalMs: 60_000,
    });

    await controller.start();

    expect(blindReviewFanout.prepare).not.toHaveBeenCalled();
    await controller.stop();
  });

  it("injects controller-owned scope into deterministic evidence gates only after the worker fence is current", async () => {
    const room = runningRoom();
    const deterministicEvidenceGates: RoomDeterministicEvidenceGateWorkflowV1 = {
      execute: vi.fn(async () => ({
        status: "withheld" as const,
        promotionEligible: false as const,
        reason: { code: "invalid_request" as const, message: "fixture" },
      })),
    };
    const runRoom = vi.fn(async (input: RoomWorkerRunInput) => {
      expect(input.executeDeterministicEvidenceGates).toBeTypeOf("function");
      const compromisedRequest = {
        ...deterministicEvidenceGateInput(room.room.aggregateVersion),
        scope: { projectId: "project-other", roomId: "room-other" },
      } as RoomWorkerDeterministicEvidenceGateInputV1;
      await input.executeDeterministicEvidenceGates!(compromisedRequest);
    });
    const controller = new RoomController({
      projectId: room.room.projectId,
      workerId: "worker-evidence-workflow",
      hostId: "host-evidence-workflow",
      roomStore: { listRunnableRooms: async () => [room] },
      leaseStore: leaseStore(),
      worker: { runRoom },
      evidenceWorkflows: { deterministicEvidenceGates },
      recordRunAuditEvent: async () => undefined,
      now: () => "2026-07-19T14:00:03.000Z",
      createLeaseId: () => "lease-evidence-workflow",
      leaseDurationMs: 60_000,
      pollIntervalMs: 60_000,
    });

    await controller.start();

    expect(deterministicEvidenceGates.execute).toHaveBeenCalledWith(expect.objectContaining({
      scope: { projectId: room.room.projectId, roomId: room.room.id },
      candidate: expect.objectContaining({ id: "candidate-deterministic-gate" }),
    }));
    await controller.stop();
  });

  it("rejects a stale deterministic evidence-gate callback before it reaches the workflow", async () => {
    const room = runningRoom();
    const deterministicEvidenceGates: RoomDeterministicEvidenceGateWorkflowV1 = {
      execute: vi.fn(async () => ({
        status: "withheld" as const,
        promotionEligible: false as const,
        reason: { code: "invalid_request" as const, message: "fixture" },
      })),
    };
    const runRoom = vi.fn(async (input: RoomWorkerRunInput) => {
      await expect(
        input.executeDeterministicEvidenceGates!(deterministicEvidenceGateInput(room.room.aggregateVersion + 1)),
      ).rejects.toThrow("deterministic_evidence_gate_aggregate_version_changed");
    });
    const controller = new RoomController({
      projectId: room.room.projectId,
      workerId: "worker-evidence-workflow",
      hostId: "host-evidence-workflow",
      roomStore: { listRunnableRooms: async () => [room] },
      leaseStore: leaseStore(),
      worker: { runRoom },
      evidenceWorkflows: { deterministicEvidenceGates },
      recordRunAuditEvent: async () => undefined,
      now: () => "2026-07-19T14:00:03.000Z",
      createLeaseId: () => "lease-evidence-workflow",
      leaseDurationMs: 60_000,
      pollIntervalMs: 60_000,
    });

    await controller.start();

    expect(deterministicEvidenceGates.execute).not.toHaveBeenCalled();
    await controller.stop();
  });

  it("rejects a malformed blind-review fan-out workflow at controller construction", () => {
    const room = runningRoom();

    expect(() => new RoomController({
      projectId: room.room.projectId,
      workerId: "worker-evidence-workflow",
      hostId: "host-evidence-workflow",
      roomStore: { listRunnableRooms: async () => [room] },
      leaseStore: leaseStore(),
      worker: { runRoom: async () => undefined },
      evidenceWorkflows: {
        blindReviewFanout: {} as RoomCandidateFanoutBlindReviewWorkflowV1,
      },
      recordRunAuditEvent: async () => undefined,
    })).toThrow("blind-review fan-out workflow requires prepare");
  });
});
