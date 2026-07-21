import { describe, expect, it } from "vitest";

import {
  AsyncRoomEvolutionLedger,
  allocateRoomEvolutionCanary,
  hashRoomValue,
  type AllocateRoomEvolutionCanaryInputV1,
  type AppendRoomEvolutionCanaryInputV1,
  type AppendRoomEvolutionCandidateVersionInputV1,
  type AppendRoomEvolutionExperimentInputV1,
  type AppendRoomEvolutionGateResultInputV1,
  type AppendRoomEvolutionHypothesisInputV1,
  type AppendRoomEvolutionTrustedBindingInputV1,
  type AppendVerifiedRoomEvolutionCandidateVersionInputV1,
  type AppendVerifiedRoomEvolutionGateResultInputV1,
  type RoomEvolutionCanaryRecordV1,
  type RoomEvolutionCanarySuccessOutcomeRecordV1,
  type RoomEvolutionIssuerGrantV1,
  type RoomEvolutionLedgerAppendOutcome,
  type RoomEvolutionLedgerAppendResult,
  type RoomEvolutionLedgerEntry,
  type RoomEvolutionLedgerPersistence,
  type RoomEvolutionLedgerReferenceQuery,
  type RoomEvolutionLedgerReferenceSnapshot,
  type RoomEvolutionLedgerScope,
  type RoomEvolutionLedgerTransaction,
  type RoomEvolutionTrustedBindingRecordV1,
  type RoomEvolutionTrustedBindingRevocationRecordV1,
  type RoomEvolutionTrustedBindingSubjectV1,
} from "@fusion/core";

import {
  RoomEvolutionCanaryLedgerAdapter,
  type RoomEvolutionCanaryLedgerContextSnapshotV1,
} from "../room-evolution-canary-ledger-adapter.js";

const HASH = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BINDING_ISSUED_AT = "2026-07-19T16:00:00.000Z";
const CANDIDATE_CREATED_AT = "2026-07-19T16:00:01.000Z";
const EXPERIMENT_CREATED_AT = "2026-07-19T16:00:02.000Z";
const GATE_COMPLETED_AT = "2026-07-19T16:00:03.000Z";
const AS_OF = "2026-07-19T16:00:04.000Z";
const CORE_SCOPE = {
  projectId: "project-canary",
  roomId: null,
  scopeKind: "project",
  scopeKey: "project:project-canary",
} as const satisfies RoomEvolutionLedgerScope;

class RecordingEvolutionLedgerPersistence implements RoomEvolutionLedgerPersistence, RoomEvolutionLedgerTransaction {
  readonly appends: RoomEvolutionLedgerEntry[] = [];

  async transaction<TResult>(
    operation: (transaction: RoomEvolutionLedgerTransaction) => Promise<TResult>,
  ): Promise<TResult> {
    return operation(this);
  }

  async resolveReferences(
    input: RoomEvolutionLedgerReferenceQuery,
  ): Promise<RoomEvolutionLedgerReferenceSnapshot> {
    return {
      scope: input.scope,
      hypotheses: this.select("room_evolution_hypotheses", input.hypothesisIds) as RoomEvolutionLedgerReferenceSnapshot["hypotheses"],
      candidateVersions: this.select("room_evolution_candidate_versions", input.candidateVersionIds) as RoomEvolutionLedgerReferenceSnapshot["candidateVersions"],
      trustedBindings: this.select("room_evolution_trusted_bindings", input.trustedBindingIds) as RoomEvolutionLedgerReferenceSnapshot["trustedBindings"],
      experiments: this.select("room_evolution_experiments", input.experimentIds) as RoomEvolutionLedgerReferenceSnapshot["experiments"],
      benchmarkCases: [],
      benchmarkResults: [],
      gateResults: this.select("room_evolution_gate_results", input.gateResultIds) as RoomEvolutionLedgerReferenceSnapshot["gateResults"],
      canaries: this.select("room_evolution_canaries", input.canaryIds) as RoomEvolutionLedgerReferenceSnapshot["canaries"],
      canaryObservations: [],
      canarySuccessOutcomes: this.select("room_evolution_canary_success_outcomes", input.canarySuccessOutcomeIds) as RoomEvolutionLedgerReferenceSnapshot["canarySuccessOutcomes"],
      promotionDecisions: [],
      rollbacks: [],
    };
  }

  async findTrustedBindingRevocation(
    _scope: RoomEvolutionLedgerScope,
    _trustedBindingId: string,
  ): Promise<Pick<RoomEvolutionTrustedBindingRevocationRecordV1, "trustedBindingId" | "revokedAt"> | null> {
    return null;
  }

  async resolveTrustedBindingSubject(input: {
    readonly projectId: string;
    readonly roomId: string;
    readonly roomBindingId: string;
  }): Promise<RoomEvolutionTrustedBindingSubjectV1 | null> {
    if (input.projectId !== CORE_SCOPE.projectId) return null;
    if (input.roomBindingId === "binding-producer") {
      return {
        projectId: CORE_SCOPE.projectId,
        roomId: "room-a",
        roomBindingId: "binding-producer",
        roomBindingGeneration: 1,
        roleId: "producer",
        roleVersion: 1,
      };
    }
    if (input.roomBindingId === "binding-evaluator") {
      return {
        projectId: CORE_SCOPE.projectId,
        roomId: "room-a",
        roomBindingId: "binding-evaluator",
        roomBindingGeneration: 1,
        roleId: "evaluator",
        roleVersion: 1,
      };
    }
    return null;
  }

  async resolveEvolutionIssuerGrant(input: {
    readonly projectId: string;
    readonly grantId: string;
  }): Promise<RoomEvolutionIssuerGrantV1 | null> {
    if (input.projectId !== CORE_SCOPE.projectId || input.grantId !== "grant-owner") return null;
    return {
      projectId: CORE_SCOPE.projectId,
      grantId: "grant-owner",
      principalId: "owner-1",
      role: "owner",
      roomId: null,
      grantedAt: BINDING_ISSUED_AT,
      revokedAt: null,
    };
  }

  async findCanarySuccessOutcome(
    _scope: RoomEvolutionLedgerScope,
    _canaryId: string,
  ): Promise<RoomEvolutionCanarySuccessOutcomeRecordV1 | null> {
    return null;
  }

  async append(input: {
    readonly scope: RoomEvolutionLedgerScope;
    readonly entry: RoomEvolutionLedgerEntry;
  }): Promise<RoomEvolutionLedgerAppendOutcome> {
    this.appends.push(input.entry);
    return { status: "inserted", recordId: input.entry.record.id };
  }

  private select(table: RoomEvolutionLedgerEntry["table"], ids: readonly string[]): readonly unknown[] {
    return ids.flatMap((id) => this.appends
      .filter((entry) => entry.table === table && entry.record.id === id)
      .map((entry) => entry.record));
  }
}

function allocationInput(
  overrides: Partial<AllocateRoomEvolutionCanaryInputV1> = {},
): AllocateRoomEvolutionCanaryInputV1 {
  return {
    contractVersion: 1,
    projectId: "project-canary",
    requestId: "request-1",
    candidate: {
      candidateVersionId: "candidate-v2",
      candidateHash: HASH,
      riskClass: "moderate",
      eligibleRoomIds: ["room-a", "room-b", "room-c"],
    },
    baseline: {
      strategyVersionId: "candidate-v1",
      snapshotId: "baseline-snapshot-1",
      snapshotHash: HASH,
    },
    authorization: {
      source: "durable_independent_gate_ledger",
      candidateHash: HASH,
      gateResultIds: ["gate-quality"],
      independentEvaluatorBindingIds: ["trust-evaluator"],
      authorizedAt: AS_OF,
      humanApprovalId: null,
    },
    capacity: {
      configuredSlots: 8,
      activeSlots: 2,
      reservedRecoverySlots: 2,
      observedAt: AS_OF,
    },
    policy: {
      minimumRooms: 2,
      maximumRooms: 2,
      maximumEligibleFraction: 1,
      minimumSamplesPerRoom: 3,
      objectives: [{ id: "quality", direction: "higher_is_better", maximumDegradation: 0.05 }],
    },
    allocatedAt: AS_OF,
    ...overrides,
  };
}

function allocation() {
  const result = allocateRoomEvolutionCanary(allocationInput());
  if (!result.ok) throw new Error("Expected an approved canary allocation.");
  return result.allocation;
}

function evidence(id = "evidence-1") {
  return {
    id,
    source: "durable_room_ledger" as const,
    sourceRef: `source:${id}`,
    evidenceHash: HASH,
    observedAt: AS_OF,
  };
}

function context(
  overrides: Partial<RoomEvolutionCanaryLedgerContextSnapshotV1> = {},
): RoomEvolutionCanaryLedgerContextSnapshotV1 {
  return {
    contractVersion: 1,
    scope: CORE_SCOPE,
    experimentId: "experiment-1",
    candidateVersionId: "candidate-v2",
    candidateHash: HASH,
    candidateProducerActorId: "producer-1",
    canaryControllerActorId: "controller-1",
    rollbackTargetCandidateVersionId: "candidate-v1",
    allocationVersion: 1,
    hardGateResultIds: ["gate-quality"],
    evidence: [evidence()],
    ...overrides,
  };
}

function appendedCanary(
  input: AppendRoomEvolutionCanaryInputV1,
): RoomEvolutionLedgerAppendResult<"room_evolution_canaries", RoomEvolutionCanaryRecordV1> {
  return {
    table: "room_evolution_canaries",
    record: {
      contractVersion: 1,
      id: input.id,
      projectId: input.scope.projectId,
      roomId: input.scope.roomId,
      scopeKind: input.scope.scopeKind,
      scopeKey: input.scope.scopeKey,
      experimentId: input.experimentId,
      candidateVersionId: input.candidateVersionId,
      allocationVersion: input.allocationVersion,
      allocation: input.allocation,
      successCriteria: input.successCriteria,
      failureCriteria: input.failureCriteria,
      state: input.state,
      rollbackTargetCandidateVersionId: input.rollbackTargetCandidateVersionId,
      createdAt: input.createdAt,
    },
  };
}

async function seedReadyCoreLedger(ledger: AsyncRoomEvolutionLedger): Promise<void> {
  const hypothesis: AppendRoomEvolutionHypothesisInputV1 = {
    scope: CORE_SCOPE,
    id: "hypothesis-1",
    revision: 1,
    state: "proposed",
    sourceSignalKinds: ["failure"],
    evidence: [evidence("hypothesis-evidence-1")],
    evidenceHash: HASH,
    declaredScope: ["source_code"],
    riskClass: "moderate",
    expectedMechanism: "A bounded candidate can improve task quality without reducing recovery capacity.",
    affectedDomains: ["orchestration"],
    createdByActorId: "controller-1",
    createdAt: CANDIDATE_CREATED_AT,
  };
  const baseline: AppendRoomEvolutionCandidateVersionInputV1 = {
    scope: CORE_SCOPE,
    id: "candidate-v1",
    hypothesisId: "hypothesis-1",
    versionNumber: 1,
    candidateKind: "source_code",
    baseRevision: "main@0000000",
    candidateRef: "baseline@0000001",
    isolationKind: "worktree",
    isolationRef: "worktree-baseline",
    immutableInput: { task: "baseline" },
    inputHash: HASH,
    producedByActorId: "producer-1",
    baseCandidateVersionId: null,
    rollbackTargetCandidateVersionId: null,
    createdAt: CANDIDATE_CREATED_AT,
  };
  const candidate: AppendRoomEvolutionCandidateVersionInputV1 = {
    ...baseline,
    id: "candidate-v2",
    versionNumber: 2,
    baseRevision: "baseline@0000001",
    candidateRef: "candidate@0000002",
    isolationRef: "worktree-candidate",
    immutableInput: { task: "candidate" },
    producedByActorId: "producer-1",
    baseCandidateVersionId: "candidate-v1",
    rollbackTargetCandidateVersionId: "candidate-v1",
  };
  const experiment: AppendRoomEvolutionExperimentInputV1 = {
    scope: CORE_SCOPE,
    id: "experiment-1",
    hypothesisId: "hypothesis-1",
    candidateVersionId: "candidate-v2",
    state: "planned",
    inputSnapshotHash: HASH,
    authorizationEvidence: { policy: "evolution-low-priority" },
    authorizationHash: HASH,
    capacityPool: "evolution_low_priority",
    createdByActorId: "controller-1",
    createdAt: EXPERIMENT_CREATED_AT,
  };
  const producerBinding: AppendRoomEvolutionTrustedBindingInputV1 = {
    scope: CORE_SCOPE,
    id: "trust-producer",
    actorId: "producer-1",
    purpose: "candidate_producer",
    subjectRoomId: "room-a",
    roomBindingId: "binding-producer",
    roomBindingGeneration: 1,
    roleId: "producer",
    roleVersion: 1,
    bindingVersion: 1,
    issuedByPrincipalId: "owner-1",
    issuerGrantId: "grant-owner",
    issuedAt: BINDING_ISSUED_AT,
    expiresAt: "2026-07-20T16:00:00.000Z",
  };
  const evaluatorBinding: AppendRoomEvolutionTrustedBindingInputV1 = {
    scope: CORE_SCOPE,
    id: "trust-evaluator",
    actorId: "evaluator-1",
    purpose: "independent_evaluator",
    subjectRoomId: "room-a",
    roomBindingId: "binding-evaluator",
    roomBindingGeneration: 1,
    roleId: "evaluator",
    roleVersion: 1,
    bindingVersion: 1,
    issuedByPrincipalId: "owner-1",
    issuerGrantId: "grant-owner",
    issuedAt: BINDING_ISSUED_AT,
    expiresAt: "2026-07-20T16:00:00.000Z",
  };
  const verifiedBaseline: AppendVerifiedRoomEvolutionCandidateVersionInputV1 = {
    candidate: baseline,
    candidateHash: HASH,
    producerBindingId: producerBinding.id,
    producerBindingVersion: producerBinding.bindingVersion,
  };
  const verifiedCandidate: AppendVerifiedRoomEvolutionCandidateVersionInputV1 = {
    candidate,
    candidateHash: HASH,
    producerBindingId: producerBinding.id,
    producerBindingVersion: producerBinding.bindingVersion,
  };
  const verifiedGate: AppendVerifiedRoomEvolutionGateResultInputV1 = {
    gate: {
      scope: CORE_SCOPE,
      id: "gate-quality",
      experimentId: experiment.id,
      candidateVersionId: candidate.id,
      benchmarkResultId: null,
      gateName: "independent-hard-gate",
      gateClass: "hard",
      outcome: "passed",
      evaluatorActorId: evaluatorBinding.actorId,
      evaluatorKind: "independent_reviewer",
      candidateProducerActorId: candidate.producedByActorId,
      metrics: { quality: 0.95 },
      evidence: [evidence("gate-quality-evidence")],
      evidenceHash: HASH,
      promotionEligible: true,
      completedAt: GATE_COMPLETED_AT,
    } satisfies AppendRoomEvolutionGateResultInputV1,
    candidateHash: HASH,
    candidateBindingId: producerBinding.id,
    candidateBindingVersion: producerBinding.bindingVersion,
    evaluatorBindingId: evaluatorBinding.id,
    evaluatorBindingVersion: evaluatorBinding.bindingVersion,
    evaluationArtifactHash: HASH,
  };
  await ledger.appendHypothesis(hypothesis);
  await ledger.appendTrustedBinding(producerBinding);
  await ledger.appendTrustedBinding(evaluatorBinding);
  await ledger.appendVerifiedCandidateVersion(verifiedBaseline);
  await ledger.appendVerifiedCandidateVersion(verifiedCandidate);
  await ledger.appendExperiment(experiment);
  await ledger.appendVerifiedGateResult(verifiedGate);
}

describe("RoomEvolutionCanaryLedgerAdapter", () => {
  it("persists an exact controller-approved bounded allocation as one immutable canary plan", async () => {
    const seen: AppendRoomEvolutionCanaryInputV1[] = [];
    const adapter = new RoomEvolutionCanaryLedgerAdapter({
      contextReader: { readCanaryContext: async () => context() },
      ledger: {
        appendCanary: async (input) => {
          seen.push(input);
          return appendedCanary(input);
        },
      },
    });

    const result = await adapter.appendPlan({ allocationInput: allocationInput(), allocation: allocation() });

    expect(result).toEqual({ canaryId: allocation().id, recordId: allocation().id, replayed: false });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      id: allocation().id,
      experimentId: "experiment-1",
      candidateVersionId: "candidate-v2",
      rollbackTargetCandidateVersionId: "candidate-v1",
      state: "planned",
    });
    expect(seen[0]?.allocation).toMatchObject({
      candidateHash: HASH,
      modelSelfAuthorizationExcluded: true,
      candidateProducerActorId: "producer-1",
    });
  });

  it("reaches the actual Core immutable ledger only after the complete candidate and experiment lineage exists", async () => {
    const persistence = new RecordingEvolutionLedgerPersistence();
    const ledger = new AsyncRoomEvolutionLedger(persistence);
    await seedReadyCoreLedger(ledger);
    const adapter = new RoomEvolutionCanaryLedgerAdapter({
      contextReader: { readCanaryContext: async () => context() },
      ledger,
    });

    await adapter.appendPlan({ allocationInput: allocationInput(), allocation: allocation() });

    const canary = persistence.appends.find((entry) => entry.table === "room_evolution_canaries");
    expect(canary).toMatchObject({
      table: "room_evolution_canaries",
      record: { id: allocation().id, candidateVersionId: "candidate-v2", experimentId: "experiment-1" },
    });
  });

  it("rejects a forged allocation or producer-controlled plan before any ledger append", async () => {
    let writes = 0;
    const adapter = new RoomEvolutionCanaryLedgerAdapter({
      contextReader: { readCanaryContext: async () => context({ canaryControllerActorId: "producer-1" }) },
      ledger: {
        appendCanary: async (input) => {
          writes += 1;
          return appendedCanary(input);
        },
      },
    });
    const forged = { ...allocation(), candidateHash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" };

    await expect(adapter.appendPlan({ allocationInput: allocationInput(), allocation: forged })).rejects.toMatchObject({
      code: "controller_result_invalid",
    });
    await expect(adapter.appendPlan({ allocationInput: allocationInput(), allocation: allocation() })).rejects.toMatchObject({
      code: "self_acceptance_forbidden",
    });
    expect(writes).toBe(0);
  });

  it("rejects a context that does not bind the exact project, candidate, and rollback lineage", async () => {
    let writes = 0;
    const adapter = new RoomEvolutionCanaryLedgerAdapter({
      contextReader: {
        readCanaryContext: async () => context({
          scope: { projectId: "project-other", roomId: null, scopeKind: "project", scopeKey: "project:project-other" },
        }),
      },
      ledger: {
        appendCanary: async (input) => {
          writes += 1;
          return appendedCanary(input);
        },
      },
    });

    await expect(adapter.appendPlan({ allocationInput: allocationInput(), allocation: allocation() })).rejects.toMatchObject({
      code: "context_snapshot_invalid",
    });
    expect(writes).toBe(0);
  });

  it("passes durable hard-gate identities unchanged to the immutable Core ledger", async () => {
    const seen: AppendRoomEvolutionCanaryInputV1[] = [];
    const durableContext = {
      ...context(),
      hardGateResultIds: ["gate-quality"],
    } satisfies RoomEvolutionCanaryLedgerContextSnapshotV1;
    const adapter = new RoomEvolutionCanaryLedgerAdapter({
      contextReader: { readCanaryContext: async () => durableContext },
      ledger: {
        appendCanary: async (input) => {
          seen.push(input);
          return appendedCanary(input);
        },
      },
    });

    await expect(adapter.appendPlan({ allocationInput: allocationInput(), allocation: allocation() })).resolves.toEqual({
      canaryId: allocation().id,
      recordId: allocation().id,
      replayed: false,
    });
    expect(seen[0]?.successCriteria).toMatchObject({ hardGateResultIds: ["gate-quality"] });
  });

  it("never confirms a plan when the immutable ledger acknowledges another record", async () => {
    const adapter = new RoomEvolutionCanaryLedgerAdapter({
      contextReader: { readCanaryContext: async () => context() },
      ledger: {
        appendCanary: async (input) => ({
          ...appendedCanary(input),
          record: { ...appendedCanary(input).record, id: "canary-other" },
        }),
      },
    });

    await expect(adapter.appendPlan({ allocationInput: allocationInput(), allocation: allocation() })).rejects.toMatchObject({
      code: "ledger_response_invalid",
    });
  });
});
