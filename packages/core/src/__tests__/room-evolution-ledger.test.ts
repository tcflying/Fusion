import { describe, expect, it } from "vitest";

import {
  AsyncRoomEvolutionLedger,
  type AppendRoomEvolutionBenchmarkCaseInputV1,
  type AppendRoomEvolutionBenchmarkResultInputV1,
  type AppendRoomEvolutionCanaryInputV1,
  type AppendRoomEvolutionCanaryObservationInputV1,
  type AppendRoomEvolutionCandidateVersionInputV1,
  type AppendRoomEvolutionExperimentInputV1,
  type AppendRoomEvolutionGateResultInputV1,
  type AppendRoomEvolutionHypothesisInputV1,
  type AppendRoomEvolutionPromotionDecisionInputV1,
  type AppendRoomEvolutionRollbackInputV1,
  type AppendRoomEvolutionTrustedBindingInputV1,
  type AppendVerifiedRoomEvolutionCandidateVersionInputV1,
  type AppendVerifiedRoomEvolutionGateResultInputV1,
  type RoomEvolutionBenchmarkCaseRecordV1,
  type RoomEvolutionBenchmarkResultRecordV1,
  type RoomEvolutionCanaryObservationRecordV1,
  type RoomEvolutionCanaryRecordV1,
  type RoomEvolutionCanarySuccessOutcomeRecordV1,
  type RoomEvolutionCandidateVersionRecordV1,
  type RoomEvolutionExperimentRecordV1,
  type RoomEvolutionGateResultRecordV1,
  type RoomEvolutionHypothesisRecordV1,
  type RoomEvolutionIssuerGrantV1,
  type RoomEvolutionLedgerAppendOutcome,
  type RoomEvolutionLedgerEntry,
  type RoomEvolutionLedgerPersistence,
  type RoomEvolutionLedgerReferenceQuery,
  type RoomEvolutionLedgerReferenceSnapshot,
  type RoomEvolutionLedgerScope,
  type RoomEvolutionLedgerTransaction,
  type RoomEvolutionPromotionDecisionRecordV1,
  type RoomEvolutionRollbackRecordV1,
  type RoomEvolutionTrustedBindingRecordV1,
  type RoomEvolutionTrustedBindingRevocationRecordV1,
  type RoomEvolutionTrustedBindingSubjectV1,
} from "../async-room-evolution-ledger.js";
import { hashRoomValue } from "../room-integrity.js";

const PROJECT_ID = "project-evolution-ledger";
const ROOM_ID = "room-evolution-ledger";
const CREATED_AT = "2026-07-19T11:00:00.000Z";
const GATE_COMPLETED_AT = "2026-07-19T11:00:01.000Z";
const CANARY_CREATED_AT = "2026-07-19T11:00:02.000Z";
const CANARY_OBSERVED_AT = "2026-07-19T11:00:03.000Z";
const PROMOTION_DECIDED_AT = "2026-07-19T11:00:04.000Z";
const ROLLBACK_EXECUTED_AT = "2026-07-19T11:00:05.000Z";
const SCOPE = {
  projectId: PROJECT_ID,
  roomId: ROOM_ID,
  scopeKind: "room",
  scopeKey: `room:${ROOM_ID}`,
} as const satisfies RoomEvolutionLedgerScope;
const OTHER_SCOPE = {
  projectId: PROJECT_ID,
  roomId: "room-evolution-ledger-other",
  scopeKind: "room",
  scopeKey: "room:room-evolution-ledger-other",
} as const satisfies RoomEvolutionLedgerScope;

const hash = (value: unknown): string => hashRoomValue(value);
const evidence = (id: string) => ({
  id,
  source: "durable_room_ledger" as const,
  sourceRef: `source:${id}`,
  evidenceHash: hash({ id }),
  observedAt: CREATED_AT,
});

class RecordingEvolutionLedgerPersistence implements RoomEvolutionLedgerPersistence, RoomEvolutionLedgerTransaction {
  readonly appends: RoomEvolutionLedgerEntry[] = [];
  nextAppendOutcome: RoomEvolutionLedgerAppendOutcome | null = null;

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
      hypotheses: this.select("room_evolution_hypotheses", input.hypothesisIds) as readonly RoomEvolutionHypothesisRecordV1[],
      candidateVersions: this.select("room_evolution_candidate_versions", input.candidateVersionIds) as readonly RoomEvolutionCandidateVersionRecordV1[],
      trustedBindings: this.select("room_evolution_trusted_bindings", input.trustedBindingIds) as readonly RoomEvolutionTrustedBindingRecordV1[],
      experiments: this.select("room_evolution_experiments", input.experimentIds) as readonly RoomEvolutionExperimentRecordV1[],
      benchmarkCases: this.select("room_evolution_benchmark_cases", input.benchmarkCaseIds) as readonly RoomEvolutionBenchmarkCaseRecordV1[],
      benchmarkResults: this.select("room_evolution_benchmark_results", input.benchmarkResultIds) as readonly RoomEvolutionBenchmarkResultRecordV1[],
      gateResults: this.select("room_evolution_gate_results", input.gateResultIds) as readonly RoomEvolutionGateResultRecordV1[],
      canaries: this.select("room_evolution_canaries", input.canaryIds) as readonly RoomEvolutionCanaryRecordV1[],
      canaryObservations: this.select("room_evolution_canary_observations", input.canaryObservationIds) as readonly RoomEvolutionCanaryObservationRecordV1[],
      canarySuccessOutcomes: this.select("room_evolution_canary_success_outcomes", input.canarySuccessOutcomeIds) as readonly RoomEvolutionCanarySuccessOutcomeRecordV1[],
      promotionDecisions: this.select("room_evolution_promotion_decisions", input.promotionDecisionIds) as readonly RoomEvolutionPromotionDecisionRecordV1[],
      rollbacks: this.select("room_evolution_rollbacks", input.rollbackIds) as readonly RoomEvolutionRollbackRecordV1[],
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
    if (input.projectId !== PROJECT_ID || input.roomId !== ROOM_ID) return null;
    if (input.roomBindingId === "binding-producer") {
      return {
        projectId: PROJECT_ID,
        roomId: ROOM_ID,
        roomBindingId: "binding-producer",
        roomBindingGeneration: 1,
        roleId: "producer",
        roleVersion: 1,
      };
    }
    if (input.roomBindingId === "binding-evaluator") {
      return {
        projectId: PROJECT_ID,
        roomId: ROOM_ID,
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
    if (input.projectId !== PROJECT_ID || input.grantId !== "grant-owner") return null;
    return {
      projectId: PROJECT_ID,
      grantId: "grant-owner",
      principalId: "owner-principal",
      role: "owner",
      roomId: ROOM_ID,
      grantedAt: CREATED_AT,
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
    const outcome = this.nextAppendOutcome ?? { status: "inserted" as const, recordId: input.entry.record.id };
    if (outcome.status === "inserted") this.appends.push(input.entry);
    return outcome;
  }

  private select(table: RoomEvolutionLedgerEntry["table"], ids: readonly string[]): readonly unknown[] {
    return ids.flatMap((id) => this.appends
      .filter((entry) => entry.table === table && entry.record.id === id)
      .map((entry) => entry.record));
  }
}

function hypothesisInput(
  scope: RoomEvolutionLedgerScope = SCOPE,
  overrides: Partial<AppendRoomEvolutionHypothesisInputV1> = {},
): AppendRoomEvolutionHypothesisInputV1 {
  return {
    scope,
    id: "hypothesis-evolution-1",
    revision: 1,
    state: "proposed",
    sourceSignalKinds: ["failure", "quality"],
    evidence: [evidence("hypothesis-evidence-1")],
    evidenceHash: hash("hypothesis-evidence-1"),
    declaredScope: ["task_decomposition"],
    riskClass: "moderate",
    expectedMechanism: "A bounded decomposition policy can reduce retries without degrading quality.",
    affectedDomains: ["orchestration"],
    createdByActorId: "evolution-controller",
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function baselineCandidateInput(
  overrides: Partial<AppendRoomEvolutionCandidateVersionInputV1> = {},
): AppendRoomEvolutionCandidateVersionInputV1 {
  return {
    scope: SCOPE,
    id: "candidate-evolution-baseline",
    hypothesisId: "hypothesis-evolution-1",
    versionNumber: 1,
    candidateKind: "source_code",
    baseRevision: "main@0000000",
    candidateRef: "baseline@0000001",
    isolationKind: "worktree",
    isolationRef: "worktree-evolution-baseline",
    immutableInput: { task: "baseline" },
    inputHash: hash("baseline-input"),
    producedByActorId: "worker-candidate",
    baseCandidateVersionId: null,
    rollbackTargetCandidateVersionId: null,
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function candidateInput(
  overrides: Partial<AppendRoomEvolutionCandidateVersionInputV1> = {},
): AppendRoomEvolutionCandidateVersionInputV1 {
  return {
    scope: SCOPE,
    id: "candidate-evolution-2",
    hypothesisId: "hypothesis-evolution-1",
    versionNumber: 2,
    candidateKind: "source_code",
    baseRevision: "baseline@0000001",
    candidateRef: "candidate@0000002",
    isolationKind: "worktree",
    isolationRef: "worktree-evolution-candidate",
    immutableInput: { task: "candidate" },
    inputHash: hash("candidate-input"),
    producedByActorId: "worker-candidate",
    baseCandidateVersionId: "candidate-evolution-baseline",
    rollbackTargetCandidateVersionId: "candidate-evolution-baseline",
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function experimentInput(
  overrides: Partial<AppendRoomEvolutionExperimentInputV1> = {},
): AppendRoomEvolutionExperimentInputV1 {
  return {
    scope: SCOPE,
    id: "experiment-evolution-1",
    hypothesisId: "hypothesis-evolution-1",
    candidateVersionId: "candidate-evolution-2",
    state: "planned",
    inputSnapshotHash: hash("experiment-input"),
    authorizationEvidence: { policy: "evolution-low-priority" },
    authorizationHash: hash("experiment-authorization"),
    capacityPool: "evolution_low_priority",
    createdByActorId: "evolution-controller",
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function benchmarkCaseInput(
  overrides: Partial<AppendRoomEvolutionBenchmarkCaseInputV1> = {},
): AppendRoomEvolutionBenchmarkCaseInputV1 {
  return {
    scope: SCOPE,
    id: "benchmark-case-evolution-1",
    domain: "orchestration",
    caseKind: "golden",
    containsPrivateRoomData: false,
    sourceAuthorizationId: null,
    authorizationEvidence: {},
    casePayload: { task: "decompose" },
    expectedOutcome: { retryCount: 0 },
    contentHash: hash("benchmark-case"),
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function benchmarkResultInput(
  overrides: Partial<AppendRoomEvolutionBenchmarkResultInputV1> = {},
): AppendRoomEvolutionBenchmarkResultInputV1 {
  return {
    scope: SCOPE,
    id: "benchmark-result-evolution-1",
    experimentId: "experiment-evolution-1",
    candidateVersionId: "candidate-evolution-2",
    benchmarkCaseId: "benchmark-case-evolution-1",
    evaluatorActorId: "reviewer-benchmark",
    evaluatorKind: "independent_reviewer",
    outcome: "passed",
    metrics: { quality: 0.95 },
    evidence: [evidence("benchmark-result-evidence-1")],
    evidenceHash: hash("benchmark-result-evidence-1"),
    completedAt: GATE_COMPLETED_AT,
    ...overrides,
  };
}

function gateResultInput(
  overrides: Partial<AppendRoomEvolutionGateResultInputV1> = {},
): AppendRoomEvolutionGateResultInputV1 {
  return {
    scope: SCOPE,
    id: "gate-result-evolution-1",
    experimentId: "experiment-evolution-1",
    candidateVersionId: "candidate-evolution-2",
    benchmarkResultId: "benchmark-result-evolution-1",
    gateName: "quality-regression",
    gateClass: "hard",
    outcome: "passed",
    evaluatorActorId: "reviewer-gate",
    evaluatorKind: "independent_reviewer",
    candidateProducerActorId: "worker-candidate",
    metrics: { quality: 0.95 },
    evidence: [evidence("gate-evidence-1")],
    evidenceHash: hash("gate-evidence-1"),
    promotionEligible: false,
    completedAt: CREATED_AT,
    ...overrides,
  };
}

function canaryInput(
  overrides: Partial<AppendRoomEvolutionCanaryInputV1> = {},
): AppendRoomEvolutionCanaryInputV1 {
  return {
    scope: SCOPE,
    id: "canary-evolution-1",
    experimentId: "experiment-evolution-1",
    candidateVersionId: "candidate-evolution-2",
    allocationVersion: 1,
    allocation: { ratio: 0.1 },
    successCriteria: { quality: { min: 0.9 }, hardGateResultIds: ["gate-result-evolution-1"] },
    failureCriteria: { retryCount: { max: 1 } },
    state: "planned",
    rollbackTargetCandidateVersionId: "candidate-evolution-baseline",
    createdAt: CANARY_CREATED_AT,
    ...overrides,
  };
}

function canaryObservationInput(
  overrides: Partial<AppendRoomEvolutionCanaryObservationInputV1> = {},
): AppendRoomEvolutionCanaryObservationInputV1 {
  return {
    scope: SCOPE,
    id: "canary-observation-evolution-1",
    canaryId: "canary-evolution-1",
    metricName: "quality",
    metricValue: { value: 0.95 },
    threshold: { min: 0.9 },
    breached: false,
    evidence: [evidence("canary-observation-evidence-1")],
    evidenceHash: hash("canary-observation-evidence-1"),
    observedAt: CANARY_OBSERVED_AT,
    ...overrides,
  };
}

function promotionDecisionInput(
  overrides: Partial<AppendRoomEvolutionPromotionDecisionInputV1> = {},
): AppendRoomEvolutionPromotionDecisionInputV1 {
  return {
    scope: SCOPE,
    id: "promotion-decision-evolution-1",
    experimentId: "experiment-evolution-1",
    candidateVersionId: "candidate-evolution-2",
    canaryId: "canary-evolution-1",
    decision: "rollback_required",
    riskClass: "moderate",
    authorityTier: "independent",
    candidateProducerActorId: "worker-candidate",
    decisionActorId: "reviewer-promotion",
    approvalRequestId: null,
    authorizationEvidence: { policy: "evolution-preauthorized" },
    evidence: [evidence("promotion-evidence-1")],
    evidenceHash: hash("promotion-evidence-1"),
    rollbackTargetCandidateVersionId: "candidate-evolution-baseline",
    decidedAt: PROMOTION_DECIDED_AT,
    ...overrides,
  };
}

function rollbackInput(
  overrides: Partial<AppendRoomEvolutionRollbackInputV1> = {},
): AppendRoomEvolutionRollbackInputV1 {
  return {
    scope: SCOPE,
    id: "rollback-evolution-1",
    promotionDecisionId: "promotion-decision-evolution-1",
    canaryId: "canary-evolution-1",
    fromCandidateVersionId: "candidate-evolution-2",
    toCandidateVersionId: "candidate-evolution-baseline",
    triggerKind: "automatic",
    reason: "Canary breach requires a bounded rollback.",
    evidence: [evidence("rollback-evidence-1")],
    evidenceHash: hash("rollback-evidence-1"),
    executedAt: ROLLBACK_EXECUTED_AT,
    ...overrides,
  };
}

async function seedReadyGraph(ledger: AsyncRoomEvolutionLedger): Promise<void> {
  const producerBinding: AppendRoomEvolutionTrustedBindingInputV1 = {
    scope: SCOPE,
    id: "trust-producer",
    actorId: "worker-candidate",
    purpose: "candidate_producer",
    subjectRoomId: ROOM_ID,
    roomBindingId: "binding-producer",
    roomBindingGeneration: 1,
    roleId: "producer",
    roleVersion: 1,
    bindingVersion: 1,
    issuedByPrincipalId: "owner-principal",
    issuerGrantId: "grant-owner",
    issuedAt: CREATED_AT,
    expiresAt: "2026-07-20T11:00:00.000Z",
  };
  const evaluatorBinding: AppendRoomEvolutionTrustedBindingInputV1 = {
    scope: SCOPE,
    id: "trust-evaluator",
    actorId: "reviewer-gate",
    purpose: "independent_evaluator",
    subjectRoomId: ROOM_ID,
    roomBindingId: "binding-evaluator",
    roomBindingGeneration: 1,
    roleId: "evaluator",
    roleVersion: 1,
    bindingVersion: 1,
    issuedByPrincipalId: "owner-principal",
    issuerGrantId: "grant-owner",
    issuedAt: CREATED_AT,
    expiresAt: "2026-07-20T11:00:00.000Z",
  };
  const verifiedBaseline: AppendVerifiedRoomEvolutionCandidateVersionInputV1 = {
    candidate: baselineCandidateInput(),
    candidateHash: hash("baseline-artifact"),
    producerBindingId: producerBinding.id,
    producerBindingVersion: producerBinding.bindingVersion,
  };
  const verifiedCandidate: AppendVerifiedRoomEvolutionCandidateVersionInputV1 = {
    candidate: candidateInput(),
    candidateHash: hash("candidate-artifact"),
    producerBindingId: producerBinding.id,
    producerBindingVersion: producerBinding.bindingVersion,
  };
  const verifiedGate: AppendVerifiedRoomEvolutionGateResultInputV1 = {
    gate: gateResultInput({ promotionEligible: true }),
    candidateHash: hash("candidate-artifact"),
    candidateBindingId: producerBinding.id,
    candidateBindingVersion: producerBinding.bindingVersion,
    evaluatorBindingId: evaluatorBinding.id,
    evaluatorBindingVersion: evaluatorBinding.bindingVersion,
    evaluationArtifactHash: hash("gate-artifact"),
  };
  await ledger.appendHypothesis(hypothesisInput());
  await ledger.appendTrustedBinding(producerBinding);
  await ledger.appendTrustedBinding(evaluatorBinding);
  await ledger.appendVerifiedCandidateVersion(verifiedBaseline);
  await ledger.appendVerifiedCandidateVersion(verifiedCandidate);
  await ledger.appendExperiment(experimentInput());
  await ledger.appendBenchmarkCase(benchmarkCaseInput());
  await ledger.appendBenchmarkResult(benchmarkResultInput());
  await ledger.appendVerifiedGateResult(verifiedGate);
  await ledger.appendCanary(canaryInput());
}

describe("AsyncRoomEvolutionLedger", () => {
  it("appends a linked, bounded evolution graph without overwriting evidence", async () => {
    const persistence = new RecordingEvolutionLedgerPersistence();
    const ledger = new AsyncRoomEvolutionLedger(persistence);

    await seedReadyGraph(ledger);
    await ledger.appendCanaryObservation(canaryObservationInput());
    const promotion = await ledger.appendPromotionDecision(promotionDecisionInput());
    const rollback = await ledger.appendRollback(rollbackInput());

    expect(persistence.appends.map((entry) => entry.table)).toEqual([
      "room_evolution_hypotheses",
      "room_evolution_trusted_bindings",
      "room_evolution_trusted_bindings",
      "room_evolution_candidate_versions",
      "room_evolution_candidate_versions",
      "room_evolution_experiments",
      "room_evolution_benchmark_cases",
      "room_evolution_benchmark_results",
      "room_evolution_gate_results",
      "room_evolution_canaries",
      "room_evolution_canary_observations",
      "room_evolution_promotion_decisions",
      "room_evolution_rollbacks",
    ]);
    expect(promotion.record.decisionActorId).toBe("reviewer-promotion");
    expect(rollback.record.toCandidateVersionId).toBe("candidate-evolution-baseline");
    expect(Object.isFrozen(promotion.record)).toBe(true);
  });

  it("fails closed on source-code isolation, scope leakage, and immutable conflicts", async () => {
    const persistence = new RecordingEvolutionLedgerPersistence();
    const ledger = new AsyncRoomEvolutionLedger(persistence);
    await ledger.appendHypothesis(hypothesisInput());

    await expect(ledger.appendCandidateVersion(baselineCandidateInput({
      candidateKind: "source_code",
      isolationKind: "versioned_policy_store",
    }))).rejects.toMatchObject({ code: "policy_violation" });

    await ledger.appendCandidateVersion(baselineCandidateInput());
    await expect(ledger.appendExperiment(experimentInput({ scope: OTHER_SCOPE }))).rejects.toMatchObject({
      code: "scope_mismatch",
    });

    persistence.nextAppendOutcome = { status: "conflict", recordId: "hypothesis-evolution-conflict" };
    await expect(ledger.appendHypothesis(hypothesisInput(SCOPE, {
      id: "hypothesis-evolution-conflict",
      revision: 2,
    }))).rejects.toMatchObject({ code: "immutable_conflict" });
  });

  it("refuses self-acceptance and high-risk promotion without a human approval", async () => {
    const persistence = new RecordingEvolutionLedgerPersistence();
    const ledger = new AsyncRoomEvolutionLedger(persistence);
    await seedReadyGraph(ledger);

    await expect(ledger.appendPromotionDecision(promotionDecisionInput({
      decisionActorId: "worker-candidate",
    }))).rejects.toMatchObject({ code: "self_acceptance_forbidden" });

    await expect(ledger.appendPromotionDecision(promotionDecisionInput({
      id: "promotion-decision-evolution-high-risk",
      riskClass: "high",
      authorityTier: "independent",
      approvalRequestId: null,
    }))).rejects.toMatchObject({ code: "policy_violation" });
  });
});
