import { describe, expect, it } from "vitest";

import {
  AsyncRoomEvolutionLedger,
  type AppendRoomEvolutionCanaryInputV1,
  type AppendRoomEvolutionCanarySuccessOutcomeInputV1,
  type AppendRoomEvolutionCandidateVersionInputV1,
  type AppendRoomEvolutionExperimentInputV1,
  type AppendRoomEvolutionGateResultInputV1,
  type AppendRoomEvolutionHypothesisInputV1,
  type AppendRoomEvolutionTrustedBindingInputV1,
  type AppendVerifiedRoomEvolutionCandidateVersionInputV1,
  type AppendVerifiedRoomEvolutionGateResultInputV1,
  type AppendVerifiedRoomEvolutionPromotionDecisionInputV1,
  type RoomEvolutionBenchmarkCaseRecordV1,
  type RoomEvolutionBenchmarkResultRecordV1,
  type RoomEvolutionCanaryObservationRecordV1,
  type RoomEvolutionCanaryRecordV1,
  type RoomEvolutionCanarySuccessOutcomeRecordV1,
  type RoomEvolutionCandidateVersionRecordV1,
  type RoomEvolutionExperimentRecordV1,
  type RoomEvolutionGateResultRecordV1,
  type RoomEvolutionHypothesisRecordV1,
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
} from "../async-room-evolution-ledger.js";
import { hashRoomValue } from "../room-integrity.js";

const PROJECT_ID = "project-evolution-trust";
const ROOM_ID = "room-evolution-trust";
const CREATED_AT = "2026-07-19T19:30:00.000Z";
const EXPIRES_AT = "2026-07-20T19:30:00.000Z";
const SCOPE = {
  projectId: PROJECT_ID,
  roomId: ROOM_ID,
  scopeKind: "room",
  scopeKey: `room:${ROOM_ID}`,
} as const satisfies RoomEvolutionLedgerScope;
const OTHER_PROJECT_SCOPE = {
  projectId: "project-evolution-trust-other",
  roomId: ROOM_ID,
  scopeKind: "room",
  scopeKey: `room:${ROOM_ID}`,
} as const satisfies RoomEvolutionLedgerScope;

const hash = (value: unknown): string => hashRoomValue(value);
const evidence = (id: string) => ({
  id,
  source: "durable_room_ledger" as const,
  sourceRef: `source:${id}`,
  evidenceHash: hash({ id }),
  observedAt: CREATED_AT,
});

class InMemoryEvolutionLedgerPersistence implements RoomEvolutionLedgerPersistence, RoomEvolutionLedgerTransaction {
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
      hypotheses: this.select("room_evolution_hypotheses", input.hypothesisIds, input.scope) as readonly RoomEvolutionHypothesisRecordV1[],
      candidateVersions: this.select("room_evolution_candidate_versions", input.candidateVersionIds, input.scope) as readonly RoomEvolutionCandidateVersionRecordV1[],
      experiments: this.select("room_evolution_experiments", input.experimentIds, input.scope) as readonly RoomEvolutionExperimentRecordV1[],
      benchmarkCases: this.select("room_evolution_benchmark_cases", input.benchmarkCaseIds, input.scope) as readonly RoomEvolutionBenchmarkCaseRecordV1[],
      benchmarkResults: this.select("room_evolution_benchmark_results", input.benchmarkResultIds, input.scope) as readonly RoomEvolutionBenchmarkResultRecordV1[],
      gateResults: this.select("room_evolution_gate_results", input.gateResultIds, input.scope) as readonly RoomEvolutionGateResultRecordV1[],
      canaries: this.select("room_evolution_canaries", input.canaryIds, input.scope) as readonly RoomEvolutionCanaryRecordV1[],
      canaryObservations: this.select("room_evolution_canary_observations", input.canaryObservationIds, input.scope) as readonly RoomEvolutionCanaryObservationRecordV1[],
      canarySuccessOutcomes: this.select("room_evolution_canary_success_outcomes", input.canarySuccessOutcomeIds, input.scope) as readonly RoomEvolutionCanarySuccessOutcomeRecordV1[],
      trustedBindings: this.select("room_evolution_trusted_bindings", input.trustedBindingIds, input.scope) as readonly RoomEvolutionTrustedBindingRecordV1[],
      promotionDecisions: this.select("room_evolution_promotion_decisions", input.promotionDecisionIds, input.scope) as readonly RoomEvolutionPromotionDecisionRecordV1[],
      rollbacks: this.select("room_evolution_rollbacks", input.rollbackIds, input.scope) as readonly RoomEvolutionRollbackRecordV1[],
    };
  }

  async findCanarySuccessOutcome(
    scope: RoomEvolutionLedgerScope,
    canaryId: string,
  ): Promise<RoomEvolutionCanarySuccessOutcomeRecordV1 | null> {
    return this.appends
      .filter((entry) => entry.table === "room_evolution_canary_success_outcomes")
      .map((entry) => entry.record)
      .find((record) => record.projectId === scope.projectId
        && record.roomId === scope.roomId
        && record.scopeKey === scope.scopeKey
        && record.canaryId === canaryId) as RoomEvolutionCanarySuccessOutcomeRecordV1 | undefined ?? null;
  }

  async findTrustedBindingRevocation(
    scope: RoomEvolutionLedgerScope,
    trustedBindingId: string,
  ): Promise<{ readonly trustedBindingId: string; readonly revokedAt: string } | null> {
    return this.appends
      .filter((entry) => entry.table === "room_evolution_trusted_binding_revocations")
      .map((entry) => entry.record)
      .find((record) => record.projectId === scope.projectId
        && record.roomId === scope.roomId
        && record.scopeKey === scope.scopeKey
        && record.trustedBindingId === trustedBindingId) as { readonly trustedBindingId: string; readonly revokedAt: string } | undefined ?? null;
  }

  async resolveTrustedBindingSubject(input: {
    readonly projectId: string;
    readonly roomId: string;
    readonly roomBindingId: string;
  }): Promise<{
    readonly projectId: string;
    readonly roomId: string;
    readonly roomBindingId: string;
    readonly roomBindingGeneration: number;
    readonly roleId: string;
    readonly roleVersion: number;
  } | null> {
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
  }): Promise<{
    readonly projectId: string;
    readonly grantId: string;
    readonly principalId: string;
    readonly role: "owner" | "admin" | "operator" | "observer" | "auditor";
    readonly roomId: string | null;
    readonly grantedAt: string;
    readonly revokedAt: string | null;
  } | null> {
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

  async append(input: {
    readonly scope: RoomEvolutionLedgerScope;
    readonly entry: RoomEvolutionLedgerEntry;
  }): Promise<RoomEvolutionLedgerAppendOutcome> {
    if (this.appends.some((entry) => entry.table === input.entry.table && entry.record.id === input.entry.record.id)) {
      return { status: "conflict", recordId: input.entry.record.id };
    }
    this.appends.push(input.entry);
    return { status: "inserted", recordId: input.entry.record.id };
  }

  private select(
    table: RoomEvolutionLedgerEntry["table"],
    ids: readonly string[],
    scope: RoomEvolutionLedgerScope,
  ): readonly unknown[] {
    return ids.flatMap((id) => this.appends
      .filter((entry) => entry.table === table
        && entry.record.id === id
        && entry.record.projectId === scope.projectId
        && entry.record.roomId === scope.roomId
        && entry.record.scopeKey === scope.scopeKey)
      .map((entry) => entry.record));
  }
}

function hypothesis(): AppendRoomEvolutionHypothesisInputV1 {
  return {
    scope: SCOPE,
    id: "hypothesis-trust-1",
    revision: 1,
    state: "proposed",
    sourceSignalKinds: ["failure"],
    evidence: [evidence("hypothesis-trust")],
    evidenceHash: hash("hypothesis-trust"),
    declaredScope: ["protocol"],
    riskClass: "moderate",
    expectedMechanism: "Preserve a durable independent evaluation chain.",
    affectedDomains: ["orchestration"],
    createdByActorId: "evolution-controller",
    createdAt: CREATED_AT,
  };
}

function trustedBinding(
  overrides: Partial<AppendRoomEvolutionTrustedBindingInputV1> = {},
): AppendRoomEvolutionTrustedBindingInputV1 {
  return {
    scope: SCOPE,
    id: "trust-producer",
    actorId: "actor-producer",
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
    expiresAt: EXPIRES_AT,
    ...overrides,
  };
}

function candidate(
  overrides: Partial<AppendRoomEvolutionCandidateVersionInputV1> = {},
): AppendRoomEvolutionCandidateVersionInputV1 {
  return {
    scope: SCOPE,
    id: "candidate-trust-baseline",
    hypothesisId: "hypothesis-trust-1",
    versionNumber: 1,
    candidateKind: "protocol",
    baseRevision: "strategy@baseline",
    candidateRef: "strategy@candidate-baseline",
    isolationKind: "versioned_policy_store",
    isolationRef: "policy-store-baseline",
    immutableInput: { objective: "baseline" },
    inputHash: hash("candidate-trust-baseline-input"),
    producedByActorId: "actor-producer",
    baseCandidateVersionId: null,
    rollbackTargetCandidateVersionId: null,
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function verifiedCandidate(
  overrides: Partial<AppendVerifiedRoomEvolutionCandidateVersionInputV1> = {},
): AppendVerifiedRoomEvolutionCandidateVersionInputV1 {
  return {
    candidate: candidate(),
    candidateHash: hash("candidate-trust-baseline-artifact"),
    producerBindingId: "trust-producer",
    producerBindingVersion: 1,
    ...overrides,
  };
}

function experiment(): AppendRoomEvolutionExperimentInputV1 {
  return {
    scope: SCOPE,
    id: "experiment-trust-1",
    hypothesisId: "hypothesis-trust-1",
    candidateVersionId: "candidate-trust-next",
    state: "planned",
    inputSnapshotHash: hash("experiment-trust-input"),
    authorizationEvidence: { pool: "evolution_low_priority" },
    authorizationHash: hash("experiment-trust-authorization"),
    capacityPool: "evolution_low_priority",
    createdByActorId: "evolution-controller",
    createdAt: CREATED_AT,
  };
}

function gate(
  overrides: Partial<AppendRoomEvolutionGateResultInputV1> = {},
): AppendRoomEvolutionGateResultInputV1 {
  return {
    scope: SCOPE,
    id: "gate-trust-1",
    experimentId: "experiment-trust-1",
    candidateVersionId: "candidate-trust-next",
    benchmarkResultId: null,
    gateName: "independent-hard-gate",
    gateClass: "hard",
    outcome: "passed",
    evaluatorActorId: "actor-evaluator",
    evaluatorKind: "independent_reviewer",
    candidateProducerActorId: "actor-producer",
    metrics: { quality: 0.95 },
    evidence: [evidence("gate-trust")],
    evidenceHash: hash("gate-trust"),
    promotionEligible: true,
    completedAt: CREATED_AT,
    ...overrides,
  };
}

function verifiedGate(
  overrides: Partial<AppendVerifiedRoomEvolutionGateResultInputV1> = {},
): AppendVerifiedRoomEvolutionGateResultInputV1 {
  return {
    gate: gate(),
    candidateHash: hash("candidate-trust-next-artifact"),
    candidateBindingId: "trust-producer",
    candidateBindingVersion: 1,
    evaluatorBindingId: "trust-evaluator",
    evaluatorBindingVersion: 1,
    evaluationArtifactHash: hash("gate-trust-artifact"),
    ...overrides,
  };
}

function canary(): AppendRoomEvolutionCanaryInputV1 {
  return {
    scope: SCOPE,
    id: "canary-trust-1",
    experimentId: "experiment-trust-1",
    candidateVersionId: "candidate-trust-next",
    allocationVersion: 1,
    allocation: { roomIds: ["room-canary-a"], fraction: 0.1 },
    successCriteria: { quality: { min: 0.9 } },
    failureCriteria: { correctionRate: { max: 0.05 } },
    state: "running",
    rollbackTargetCandidateVersionId: "candidate-trust-baseline",
    createdAt: CREATED_AT,
  };
}

function canarySuccess(
  overrides: Partial<AppendRoomEvolutionCanarySuccessOutcomeInputV1> = {},
): AppendRoomEvolutionCanarySuccessOutcomeInputV1 {
  return {
    scope: SCOPE,
    id: "canary-success-trust-1",
    canaryId: "canary-trust-1",
    experimentId: "experiment-trust-1",
    candidateVersionId: "candidate-trust-next",
    candidateHash: hash("candidate-trust-next-artifact"),
    candidateBindingId: "trust-producer",
    candidateBindingVersion: 1,
    evaluatorBindingId: "trust-evaluator",
    evaluatorBindingVersion: 1,
    gateResultIds: ["gate-trust-1"],
    allocationHash: hash(canary().allocation),
    artifactHash: hash("canary-success-artifact"),
    metrics: { quality: 0.96, correctionRate: 0.01 },
    evidence: [evidence("canary-success")],
    evidenceHash: hash("canary-success"),
    completedAt: CREATED_AT,
    ...overrides,
  };
}

function verifiedPromotion(
  overrides: Partial<AppendVerifiedRoomEvolutionPromotionDecisionInputV1> = {},
): AppendVerifiedRoomEvolutionPromotionDecisionInputV1 {
  return {
    decision: {
      scope: SCOPE,
      id: "promotion-trust-1",
      experimentId: "experiment-trust-1",
      candidateVersionId: "candidate-trust-next",
      canaryId: "canary-trust-1",
      decision: "promoted",
      riskClass: "moderate",
      authorityTier: "independent",
      candidateProducerActorId: "actor-producer",
      decisionActorId: "actor-evaluator",
      approvalRequestId: null,
      authorizationEvidence: { policy: "pre-authorized" },
      evidence: [evidence("promotion-trust")],
      evidenceHash: hash("promotion-trust"),
      rollbackTargetCandidateVersionId: "candidate-trust-baseline",
      decidedAt: CREATED_AT,
    },
    canarySuccessOutcomeId: "canary-success-trust-1",
    decisionBindingId: "trust-evaluator",
    decisionBindingVersion: 1,
    ...overrides,
  };
}

async function seedVerifiedGraph(ledger: AsyncRoomEvolutionLedger): Promise<void> {
  await ledger.appendHypothesis(hypothesis());
  await ledger.appendTrustedBinding(trustedBinding());
  await ledger.appendTrustedBinding(trustedBinding({
    id: "trust-evaluator",
    actorId: "actor-evaluator",
    purpose: "independent_evaluator",
    roomBindingId: "binding-evaluator",
    roleId: "evaluator",
  }));
  await ledger.appendVerifiedCandidateVersion(verifiedCandidate());
  await ledger.appendVerifiedCandidateVersion(verifiedCandidate({
    candidate: candidate({
      id: "candidate-trust-next",
      versionNumber: 2,
      baseRevision: "strategy@candidate-baseline",
      candidateRef: "strategy@candidate-next",
      immutableInput: { objective: "next" },
      inputHash: hash("candidate-trust-next-input"),
      baseCandidateVersionId: "candidate-trust-baseline",
      rollbackTargetCandidateVersionId: "candidate-trust-baseline",
    }),
    candidateHash: hash("candidate-trust-next-artifact"),
  }));
  await ledger.appendExperiment(experiment());
  await ledger.appendVerifiedGateResult(verifiedGate());
  await ledger.appendCanary(canary());
}

describe("AsyncRoomEvolutionLedger trusted evolution receipts", () => {
  it("persists and read-backs an independent canary success before a promotion can reference it", async () => {
    const persistence = new InMemoryEvolutionLedgerPersistence();
    const ledger = new AsyncRoomEvolutionLedger(persistence);
    await seedVerifiedGraph(ledger);

    await expect(ledger.appendPromotionDecision(verifiedPromotion().decision))
      .rejects.toMatchObject({ code: "policy_violation" });

    const success = await ledger.appendCanarySuccessOutcome(canarySuccess());
    const promotion = await ledger.appendVerifiedPromotionDecision(verifiedPromotion());

    expect(success.record.candidateHash).toBe(hash("candidate-trust-next-artifact"));
    expect(success.record.metricsHash).toBe(hash({ quality: 0.96, correctionRate: 0.01 }));
    expect(promotion.record.canarySuccessOutcomeId).toBe(success.record.id);
    expect(promotion.record.decisionBindingId).toBe("trust-evaluator");
    expect(Object.isFrozen(success.record)).toBe(true);
  });

  it("rejects cross-project, same-actor, hash-or-binding mismatch, and canary-success replays", async () => {
    const persistence = new InMemoryEvolutionLedgerPersistence();
    const ledger = new AsyncRoomEvolutionLedger(persistence);
    await seedVerifiedGraph(ledger);

    await ledger.appendTrustedBinding(trustedBinding({
      id: "trust-evaluator-same-actor",
      actorId: "actor-producer",
      purpose: "independent_evaluator",
      roomBindingId: "binding-evaluator",
      roleId: "evaluator",
    }));

    await expect(ledger.appendVerifiedGateResult(verifiedGate({
      gate: gate({ id: "gate-trust-same-actor", evaluatorActorId: "actor-producer" }),
      evaluatorBindingId: "trust-evaluator-same-actor",
    }))).rejects.toMatchObject({ code: "self_acceptance_forbidden" });

    await expect(ledger.appendCanarySuccessOutcome(canarySuccess({
      id: "canary-success-cross-project",
      scope: OTHER_PROJECT_SCOPE,
    }))).rejects.toMatchObject({ code: "reference_not_found" });

    await expect(ledger.appendCanarySuccessOutcome(canarySuccess({
      id: "canary-success-hash-mismatch",
      candidateHash: hash("tampered-candidate-artifact"),
    }))).rejects.toMatchObject({ code: "invalid_reference" });

    await expect(ledger.appendCanarySuccessOutcome(canarySuccess({
      id: "canary-success-binding-mismatch",
      candidateBindingId: "trust-evaluator",
    }))).rejects.toMatchObject({ code: "invalid_reference" });

    await ledger.appendCanarySuccessOutcome(canarySuccess());
    await expect(ledger.appendCanarySuccessOutcome(canarySuccess())).rejects.toMatchObject({ code: "immutable_conflict" });
    await expect(ledger.appendCanarySuccessOutcome(canarySuccess({ id: "canary-success-replay-other-id" })))
      .rejects.toMatchObject({ code: "immutable_conflict" });

    await expect(ledger.appendTrustedBinding(trustedBinding({ actorId: "actor-tampered" })))
      .rejects.toMatchObject({ code: "immutable_conflict" });
  });

  it("fails closed for role mismatch, expiry, and durable trusted-binding revocation", async () => {
    const persistence = new InMemoryEvolutionLedgerPersistence();
    const ledger = new AsyncRoomEvolutionLedger(persistence);
    await seedVerifiedGraph(ledger);

    await expect(ledger.appendTrustedBinding(trustedBinding({
      id: "trust-producer-role-mismatch",
      roleId: "evaluator",
    }))).rejects.toMatchObject({ code: "invalid_reference" });

    await expect(ledger.appendCanarySuccessOutcome(canarySuccess({
      id: "canary-success-expired",
      completedAt: EXPIRES_AT,
    }))).rejects.toMatchObject({ code: "trusted_binding_expired" });

    await ledger.appendTrustedBindingRevocation({
      scope: SCOPE,
      id: "trust-producer-revocation",
      trustedBindingId: "trust-producer",
      revokedByPrincipalId: "owner-principal",
      revokerGrantId: "grant-owner",
      reason: "The producer binding is no longer trusted for evolution work.",
      evidence: [evidence("trust-producer-revocation")],
      evidenceHash: hash("trust-producer-revocation"),
      revokedAt: CREATED_AT,
    });

    await expect(ledger.appendCanarySuccessOutcome(canarySuccess({
      id: "canary-success-revoked",
    }))).rejects.toMatchObject({ code: "trusted_binding_revoked" });
  });
});
