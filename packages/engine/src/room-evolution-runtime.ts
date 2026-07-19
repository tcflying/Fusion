import {
  hashRoomValue,
  type RoomEvolutionEvidenceRefV1,
  type RoomEvolutionLedgerScope,
} from "@fusion/core";

import {
  RoomEvolutionBenchmarkCommitCoordinator,
  type RoomEvolutionBenchmarkCommitCoordinatorDependenciesV1,
  type SelectAndCommitRoomEvolutionBenchmarkInputV1,
} from "./room-evolution-benchmark-commit-coordinator.js";
import {
  RoomEvolutionCanaryLedgerAdapter,
  type AppendRoomEvolutionCanaryPlanInputV1,
  type RoomEvolutionCanaryLedgerAdapterDependenciesV1,
} from "./room-evolution-canary-ledger-adapter.js";
import {
  ROOM_EVOLUTION_CANARY_ROLLBACK_COORDINATOR_CONTRACT_VERSION,
  RoomEvolutionCanaryRollbackCoordinator,
  type EvaluateAndRollbackRoomEvolutionCanaryInputV1,
  type RoomEvolutionCanaryRollbackCoordinatorDependenciesV1,
} from "./room-evolution-canary-rollback-coordinator.js";
import {
  RoomEvolutionHypothesisCommitCoordinator,
  type CommitRoomEvolutionHypothesesInputV1,
  type RoomEvolutionHypothesisCommitCoordinatorDependenciesV1,
} from "./room-evolution-hypothesis-commit-coordinator.js";
import {
  RoomEvolutionIsolatedCandidateLedgerAdapter,
  type RequestRoomEvolutionIsolatedCandidateLedgerV1,
  type RoomEvolutionIsolatedCandidateLedgerAdapterDependenciesV1,
} from "./room-evolution-isolated-candidate-ledger-adapter.js";
import {
  RoomEvolutionPromotionCommitCoordinator,
  type RequestRoomEvolutionPromotionCommitV1,
} from "./room-evolution-promotion-commit-coordinator.js";
import {
  RoomEvolutionPromotionLedgerAdapter,
  type RoomEvolutionPromotionLedgerAdapterDependenciesV1,
} from "./room-evolution-promotion-ledger-adapter.js";

export const ROOM_EVOLUTION_RUNTIME_CONTRACT_VERSION = 1 as const;

export interface RoomEvolutionRuntimeCommandIdentityV1 {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

export interface RoomEvolutionCandidateCommandRequestV1 {
  readonly contractVersion: typeof ROOM_EVOLUTION_RUNTIME_CONTRACT_VERSION;
  readonly command: RoomEvolutionRuntimeCommandIdentityV1;
  readonly scope: RoomEvolutionLedgerScope;
  readonly candidateId: string;
  readonly candidateVersionId: string;
  readonly hypothesisId: string;
  readonly candidateRequestHash: string;
  readonly candidateProducerActorId: string;
  readonly branchRef: string;
  readonly worktreePath: string;
  readonly baseRevision: string;
  readonly rollbackTargetCandidateVersionId: string;
  readonly declaredScope: readonly string[];
}

export interface RoomEvolutionCandidateCommandReceiptV1 {
  readonly status: "materialized";
  readonly candidateId: string;
  readonly candidateVersionId: string;
  readonly candidateArtifactHash: string;
  readonly immutableArtifactRef: string;
  readonly worktreePath: string;
  readonly completedAt: string;
}

export interface RoomEvolutionCandidateCommandPortV1 {
  materialize(
    input: RoomEvolutionCandidateCommandRequestV1,
  ): Promise<RoomEvolutionCandidateCommandReceiptV1>;
}

export interface RoomEvolutionRuntimeMaterializedCandidateV1 {
  readonly scope: RoomEvolutionLedgerScope;
  readonly candidateId: string;
  readonly candidateVersionId: string;
  readonly hypothesisId: string;
  readonly candidateRequestHash: string;
  readonly candidateArtifactHash: string;
  readonly immutableArtifactRef: string;
  readonly candidateProducerActorId: string;
  readonly branchRef: string;
  readonly worktreePath: string;
  readonly rollbackTargetCandidateVersionId: string;
}

export interface RoomEvolutionRuntimeIndependentEvaluationRequestV1 {
  readonly contractVersion: typeof ROOM_EVOLUTION_RUNTIME_CONTRACT_VERSION;
  readonly command: RoomEvolutionRuntimeCommandIdentityV1;
  readonly candidate: RoomEvolutionRuntimeMaterializedCandidateV1;
  readonly benchmark: {
    readonly snapshotId: string;
    readonly snapshotHash: string;
    readonly recordIds: readonly string[];
  };
  readonly canary: {
    readonly canaryId: string;
    readonly candidateVersionId: string;
    readonly candidateArtifactHash: string;
    readonly rollbackTargetCandidateVersionId: string;
    readonly allocationHash: string;
  };
}

export interface RoomEvolutionRuntimeIndependentEvaluationResultV1 {
  readonly contractVersion: typeof ROOM_EVOLUTION_RUNTIME_CONTRACT_VERSION;
  readonly scope: RoomEvolutionLedgerScope;
  readonly candidateId: string;
  readonly candidateVersionId: string;
  readonly candidateArtifactHash: string;
  readonly benchmarkSnapshotId: string;
  readonly benchmarkSnapshotHash: string;
  readonly canaryId: string;
  readonly evaluatorActorId: string;
  readonly evaluatorBindingId: string;
  readonly evidence: readonly RoomEvolutionEvidenceRefV1[];
  readonly canary: EvaluateAndRollbackRoomEvolutionCanaryInputV1;
  readonly promotion: RequestRoomEvolutionPromotionCommitV1;
}

export interface RoomEvolutionRuntimeIndependentEvaluatorPortV1 {
  evaluate(
    input: RoomEvolutionRuntimeIndependentEvaluationRequestV1,
  ): Promise<RoomEvolutionRuntimeIndependentEvaluationResultV1>;
}

export interface RoomEvolutionPromotionRuntimeCommandRequestV1 {
  readonly contractVersion: typeof ROOM_EVOLUTION_RUNTIME_CONTRACT_VERSION;
  readonly command: RoomEvolutionRuntimeCommandIdentityV1;
  readonly candidate: RoomEvolutionRuntimeMaterializedCandidateV1;
  readonly canary: {
    readonly id: string;
    readonly candidateVersionId: string;
    readonly candidateArtifactHash: string;
    readonly rollbackTargetCandidateVersionId: string;
  };
  readonly decision: {
    readonly id: string;
    readonly recordId: string;
    readonly candidateArtifactHash: string;
  };
}

export interface RoomEvolutionPromotionRuntimeCommandReceiptV1 {
  readonly status: "promoted";
  readonly candidateId: string;
  readonly candidateVersionId: string;
  readonly candidateArtifactHash: string;
  readonly canaryId: string;
  readonly decisionId: string;
  readonly completedAt: string;
}

export interface RoomEvolutionPromotionRuntimeCommandPortV1 {
  promote(
    input: RoomEvolutionPromotionRuntimeCommandRequestV1,
  ): Promise<RoomEvolutionPromotionRuntimeCommandReceiptV1>;
}

export interface RoomEvolutionRuntimeDependenciesV1 {
  readonly hypothesis: RoomEvolutionHypothesisCommitCoordinatorDependenciesV1;
  readonly hypothesisReference: RoomEvolutionRuntimeDurableHypothesisReferencePortV1;
  readonly candidate: RoomEvolutionIsolatedCandidateLedgerAdapterDependenciesV1;
  readonly candidateCommand: RoomEvolutionCandidateCommandPortV1;
  readonly benchmark: RoomEvolutionBenchmarkCommitCoordinatorDependenciesV1;
  readonly canaryPlan: RoomEvolutionCanaryLedgerAdapterDependenciesV1;
  readonly evaluator: RoomEvolutionRuntimeIndependentEvaluatorPortV1;
  readonly canaryRollback: RoomEvolutionCanaryRollbackCoordinatorDependenciesV1;
  readonly promotion: RoomEvolutionPromotionLedgerAdapterDependenciesV1;
  readonly promotionCommand: RoomEvolutionPromotionRuntimeCommandPortV1;
}

export interface RoomEvolutionRuntimeDurableHypothesisReferenceV1 {
  readonly contractVersion: typeof ROOM_EVOLUTION_RUNTIME_CONTRACT_VERSION;
  readonly scope: RoomEvolutionLedgerScope;
  readonly hypothesisId: string;
  readonly ledgerRecordId: string;
  readonly evidenceHash: string;
  readonly recordedAt: string;
}

export interface RoomEvolutionRuntimeDurableHypothesisReferencePortV1 {
  readHypothesisReference(input: {
    readonly scope: RoomEvolutionLedgerScope;
    readonly hypothesisId: string;
  }): Promise<RoomEvolutionRuntimeDurableHypothesisReferenceV1 | null>;
}

export interface RunRoomEvolutionRuntimeInputV1 {
  readonly contractVersion: typeof ROOM_EVOLUTION_RUNTIME_CONTRACT_VERSION;
  readonly command: RoomEvolutionRuntimeCommandIdentityV1;
  readonly hypotheses: CommitRoomEvolutionHypothesesInputV1;
  readonly candidate: RequestRoomEvolutionIsolatedCandidateLedgerV1;
  readonly benchmark: SelectAndCommitRoomEvolutionBenchmarkInputV1;
  readonly canaryPlan: AppendRoomEvolutionCanaryPlanInputV1;
}

export interface ContinueRoomEvolutionRuntimeFromDurableCandidateInputV1 {
  readonly contractVersion: typeof ROOM_EVOLUTION_RUNTIME_CONTRACT_VERSION;
  readonly command: RoomEvolutionRuntimeCommandIdentityV1;
  readonly candidate: RequestRoomEvolutionIsolatedCandidateLedgerV1;
  readonly benchmark: SelectAndCommitRoomEvolutionBenchmarkInputV1;
  readonly canaryPlan: AppendRoomEvolutionCanaryPlanInputV1;
}

interface RoomEvolutionRuntimeAfterHypothesisInputV1 {
  readonly command: RoomEvolutionRuntimeCommandIdentityV1;
  readonly candidate: RequestRoomEvolutionIsolatedCandidateLedgerV1;
  readonly benchmark: SelectAndCommitRoomEvolutionBenchmarkInputV1;
  readonly canaryPlan: AppendRoomEvolutionCanaryPlanInputV1;
}

export type RoomEvolutionRuntimeStageV1 =
  | "dependency"
  | "input"
  | "hypothesis"
  | "candidate"
  | "candidate_command"
  | "benchmark"
  | "canary_plan"
  | "independent_evaluation"
  | "canary"
  | "promotion_decision"
  | "promotion_command";

export type RoomEvolutionRuntimeResultV1 =
  | {
    readonly status: "withheld";
    readonly stage: RoomEvolutionRuntimeStageV1;
    readonly reason: string;
  }
  | {
    readonly status: "rolled_back";
    readonly candidate: RoomEvolutionRuntimeMaterializedCandidateV1;
    readonly canaryId: string;
    readonly rollbackTargetCandidateVersionId: string;
    readonly rolledBackAt: string;
  }
  | {
    readonly status: "promotion_not_executed";
    readonly candidate: RoomEvolutionRuntimeMaterializedCandidateV1;
    readonly canaryId: string;
    readonly decisionId: string;
    readonly decisionOutcome: "rejected" | "rolled_back" | "inconclusive";
  }
  | {
    readonly status: "promotion_execution_failed";
    readonly candidate: RoomEvolutionRuntimeMaterializedCandidateV1;
    readonly canaryId: string;
    readonly decisionId: string;
    readonly reason: string;
  }
  | {
    readonly status: "promoted";
    readonly candidate: RoomEvolutionRuntimeMaterializedCandidateV1;
    readonly canaryId: string;
    readonly decisionId: string;
    readonly promotedAt: string;
  };

export class RoomEvolutionRuntime {
  public constructor(
    private readonly dependencies: RoomEvolutionRuntimeDependenciesV1,
  ) {}

  public async run(rawInput: RunRoomEvolutionRuntimeInputV1): Promise<RoomEvolutionRuntimeResultV1> {
    const dependencyIssue = validateDependencies(this.dependencies);
    if (dependencyIssue !== null) return withheld("dependency", dependencyIssue);

    const input = normalizeInput(rawInput);
    if (input === null) return withheld("input", "invalid_runtime_request");

    const hypothesis = new RoomEvolutionHypothesisCommitCoordinator(this.dependencies.hypothesis);
    const hypothesisResult = await runStage("hypothesis", async () => hypothesis.commit(input.hypotheses));
    if (isStageFailure(hypothesisResult)) return hypothesisResult.result;
    if (hypothesisResult.value.status !== "committed") {
      return withheld("hypothesis", `hypothesis_${hypothesisResult.value.status}`);
    }
    if (!hypothesisResult.value.committedHypothesisIds.includes(input.candidate.candidateVersion.hypothesisId)) {
      return withheld("hypothesis", "candidate_hypothesis_not_durably_committed");
    }
    if (!isCandidateIsolationIdentifier(input.candidate.candidateVersion.hypothesisId)) {
      return withheld("candidate", "candidate_hypothesis_identifier_incompatible");
    }
    return this.continueAfterDurableHypothesis(input);
  }

  public async continueFromDurableCandidate(
    rawInput: ContinueRoomEvolutionRuntimeFromDurableCandidateInputV1,
  ): Promise<RoomEvolutionRuntimeResultV1> {
    const dependencyIssue = validateDependencies(this.dependencies);
    if (dependencyIssue !== null) return withheld("dependency", dependencyIssue);
    const input = normalizeContinuationInput(rawInput);
    if (input === null) return withheld("input", "invalid_durable_candidate_continuation_request");
    return this.continueAfterDurableHypothesis(input);
  }

  private async continueAfterDurableHypothesis(
    input: RoomEvolutionRuntimeAfterHypothesisInputV1,
  ): Promise<RoomEvolutionRuntimeResultV1> {
    const candidateScope = scopeForCandidate(input.candidate);
    if (candidateScope === null) return withheld("input", "candidate_scope_invalid");
    const hypothesisReference = await runStage("hypothesis", async () => this.dependencies.hypothesisReference.readHypothesisReference({
      scope: cloneScope(candidateScope),
      hypothesisId: input.candidate.candidateVersion.hypothesisId,
    }));
    if (isStageFailure(hypothesisReference)) return hypothesisReference.result;
    if (!isMatchingDurableHypothesisReference(
      hypothesisReference.value,
      candidateScope,
      input.candidate.candidateVersion.hypothesisId,
    )) {
      return withheld("hypothesis", "durable_hypothesis_reference_unavailable");
    }

    const candidateAdapter = new RoomEvolutionIsolatedCandidateLedgerAdapter(this.dependencies.candidate);
    const candidateResult = await runStage("candidate", async () => candidateAdapter.create(input.candidate));
    if (isStageFailure(candidateResult)) return candidateResult.result;
    if (candidateResult.value.status !== "created") {
      return withheld("candidate", `candidate_${candidateResult.value.status}`);
    }

    const candidateCommandRequest = buildCandidateCommandRequest(input.command, candidateScope, input.candidate, candidateResult.value);
    const materialization = await runStage("candidate_command", async () => this.dependencies.candidateCommand.materialize(candidateCommandRequest));
    if (isStageFailure(materialization)) return materialization.result;
    const materializedCandidate = materializeCandidate(candidateScope, input.candidate, candidateResult.value, materialization.value);
    if (materializedCandidate === null) return withheld("candidate_command", "candidate_materialization_receipt_invalid");

    const benchmarkIssue = validateBenchmarkBinding(input.benchmark, materializedCandidate);
    if (benchmarkIssue !== null) return withheld("benchmark", benchmarkIssue);
    const benchmark = new RoomEvolutionBenchmarkCommitCoordinator(this.dependencies.benchmark);
    const benchmarkResult = await runStage("benchmark", async () => benchmark.selectAndCommit(input.benchmark));
    if (isStageFailure(benchmarkResult)) return benchmarkResult.result;
    if (benchmarkResult.value.status !== "committed") {
      return withheld("benchmark", `benchmark_${benchmarkResult.value.status}`);
    }

    const canaryPlanIssue = validateCanaryPlanBinding(input.canaryPlan, materializedCandidate);
    if (canaryPlanIssue !== null) return withheld("canary_plan", canaryPlanIssue);
    const canaryPlan = new RoomEvolutionCanaryLedgerAdapter(this.dependencies.canaryPlan);
    const canaryPlanResult = await runStage("canary_plan", async () => canaryPlan.appendPlan(input.canaryPlan));
    if (isStageFailure(canaryPlanResult)) return canaryPlanResult.result;
    if (canaryPlanResult.value.canaryId !== input.canaryPlan.allocation.id) {
      return withheld("canary_plan", "canary_plan_receipt_invalid");
    }

    const evaluationRequest = buildEvaluationRequest(
      input.command,
      materializedCandidate,
      benchmarkResult.value,
      canaryPlanResult.value.canaryId,
      input.canaryPlan.allocation,
    );
    const evaluated = await runStage("independent_evaluation", async () => this.dependencies.evaluator.evaluate(evaluationRequest));
    if (isStageFailure(evaluated)) return evaluated.result;
    const evaluationIssue = validateEvaluationResult(evaluated.value, evaluationRequest);
    if (evaluationIssue !== null) return withheld("independent_evaluation", evaluationIssue);

    const canary = new RoomEvolutionCanaryRollbackCoordinator(this.dependencies.canaryRollback);
    const canaryResult = await runStage("canary", async () => canary.evaluateAndRollback(evaluated.value.canary));
    if (isStageFailure(canaryResult)) return canaryResult.result;
    if (canaryResult.value.status === "rolled_back") {
      return freeze({
        status: "rolled_back" as const,
        candidate: materializedCandidate,
        canaryId: evaluationRequest.canary.canaryId,
        rollbackTargetCandidateVersionId: canaryResult.value.rollback.targetVersionId,
        rolledBackAt: canaryResult.value.rollback.executedAt,
      });
    }
    if (canaryResult.value.status !== "promotion_eligible" || canaryResult.value.allocationId !== evaluationRequest.canary.canaryId) {
      return withheld("canary", `canary_${canaryResult.value.status}`);
    }

    const promotionLedger = new RoomEvolutionPromotionLedgerAdapter(this.dependencies.promotion);
    const promotion = new RoomEvolutionPromotionCommitCoordinator({ ledger: promotionLedger });
    const promotionResult = await runStage("promotion_decision", async () => promotion.evaluateAndCommit(evaluated.value.promotion));
    if (isStageFailure(promotionResult)) return promotionResult.result;
    if (promotionResult.value.status !== "committed") {
      return withheld("promotion_decision", `promotion_${promotionResult.value.status}`);
    }
    if (promotionResult.value.decision.outcome !== "promoted") {
      return freeze({
        status: "promotion_not_executed" as const,
        candidate: materializedCandidate,
        canaryId: evaluationRequest.canary.canaryId,
        decisionId: promotionResult.value.decision.id,
        decisionOutcome: promotionResult.value.decision.outcome,
      });
    }
    if (promotionResult.value.decision.runtimeAction !== "promote_candidate") {
      return withheld("promotion_decision", "promotion_runtime_action_mismatch");
    }

    const promotionCommandRequest = buildPromotionCommandRequest(
      input.command,
      materializedCandidate,
      evaluationRequest.canary.canaryId,
      promotionResult.value.decision.id,
      promotionResult.value.record.recordId,
    );
    const promoted = await runStage("promotion_command", async () => this.dependencies.promotionCommand.promote(promotionCommandRequest));
    if (isStageFailure(promoted)) {
      return freeze({
        status: "promotion_execution_failed" as const,
        candidate: materializedCandidate,
        canaryId: evaluationRequest.canary.canaryId,
        decisionId: promotionResult.value.decision.id,
        reason: promoted.result.reason,
      });
    }
    if (!isMatchingPromotionReceipt(promoted.value, promotionCommandRequest)) {
      return freeze({
        status: "promotion_execution_failed" as const,
        candidate: materializedCandidate,
        canaryId: evaluationRequest.canary.canaryId,
        decisionId: promotionResult.value.decision.id,
        reason: "promotion_command_receipt_invalid",
      });
    }
    return freeze({
      status: "promoted" as const,
      candidate: materializedCandidate,
      canaryId: evaluationRequest.canary.canaryId,
      decisionId: promotionResult.value.decision.id,
      promotedAt: promoted.value.completedAt,
    });
  }
}

function normalizeInput(value: unknown): RunRoomEvolutionRuntimeInputV1 | null {
  if (!isRecord(value) || !hasExactKeys(value, ["benchmark", "candidate", "canaryPlan", "command", "contractVersion", "hypotheses"])) return null;
  if (value.contractVersion !== ROOM_EVOLUTION_RUNTIME_CONTRACT_VERSION || !isCommand(value.command)) return null;
  if (!isRecord(value.hypotheses) || !isRecord(value.candidate) || !isRecord(value.benchmark) || !isRecord(value.canaryPlan)) return null;
  const input = value as unknown as RunRoomEvolutionRuntimeInputV1;
  if (!isCandidateInputBoundToCommand(input.candidate, input.command)) return null;
  return input;
}

function normalizeContinuationInput(
  value: unknown,
): RoomEvolutionRuntimeAfterHypothesisInputV1 | null {
  if (!isRecord(value) || !hasExactKeys(value, ["benchmark", "candidate", "canaryPlan", "command", "contractVersion"])) return null;
  if (value.contractVersion !== ROOM_EVOLUTION_RUNTIME_CONTRACT_VERSION || !isCommand(value.command)) return null;
  if (!isRecord(value.candidate) || !isRecord(value.benchmark) || !isRecord(value.canaryPlan)) return null;
  const input = value as unknown as ContinueRoomEvolutionRuntimeFromDurableCandidateInputV1;
  if (!isCandidateInputBoundToCommand(input.candidate, input.command)) return null;
  if (!isCandidateIsolationIdentifier(input.candidate.candidateVersion.hypothesisId)) return null;
  return freeze({
    command: cloneCommand(input.command),
    candidate: input.candidate,
    benchmark: input.benchmark,
    canaryPlan: input.canaryPlan,
  });
}

function isCandidateInputBoundToCommand(
  value: unknown,
  command: RoomEvolutionRuntimeCommandIdentityV1,
): value is RequestRoomEvolutionIsolatedCandidateLedgerV1 {
  if (!isRecord(value) || !isRecord(value.request) || !isRecord(value.candidateVersion)) return false;
  const request = value.request;
  const version = value.candidateVersion;
  if (!isRecord(request.command) || !sameCommand(request.command, command) || !isRecord(request.scope) || !isRecord(request.candidate)) return false;
  if (!isIdentifier(request.scope.projectId) || !isIdentifier(request.scope.roomId)) return false;
  if (!isIdentifier(request.candidate.id) || !isIdentifier(request.candidate.hypothesisId) || !isRecord(request.candidate.rollbackTarget)) return false;
  return isIdentifier(version.id)
    && isIdentifier(version.hypothesisId)
    && isHash(version.candidateHash)
    && request.candidate.id === version.id
    && request.candidate.hypothesisId === version.hypothesisId
    && request.candidate.rollbackTarget.candidateVersionId === version.rollbackTargetCandidateVersionId;
}

function scopeForCandidate(
  input: RequestRoomEvolutionIsolatedCandidateLedgerV1,
): RoomEvolutionLedgerScope | null {
  const scope = input.request.scope;
  if (!isIdentifier(scope.projectId) || !isIdentifier(scope.roomId)) return null;
  return freeze({
    projectId: scope.projectId,
    roomId: scope.roomId,
    scopeKind: "room" as const,
    scopeKey: `room:${scope.roomId}`,
  });
}

function buildCandidateCommandRequest(
  command: RoomEvolutionRuntimeCommandIdentityV1,
  scope: RoomEvolutionLedgerScope,
  input: RequestRoomEvolutionIsolatedCandidateLedgerV1,
  candidate: Extract<Awaited<ReturnType<RoomEvolutionIsolatedCandidateLedgerAdapter["create"]>>, { readonly status: "created" }>,
): RoomEvolutionCandidateCommandRequestV1 {
  return freeze({
    contractVersion: ROOM_EVOLUTION_RUNTIME_CONTRACT_VERSION,
    command: cloneCommand(command),
    scope: cloneScope(scope),
    candidateId: candidate.candidate.id,
    candidateVersionId: input.candidateVersion.id,
    hypothesisId: candidate.candidate.hypothesisId,
    candidateRequestHash: input.candidateVersion.candidateHash,
    candidateProducerActorId: candidate.candidate.createdByActorId,
    branchRef: candidate.isolation.branchRef,
    worktreePath: candidate.isolation.worktreePath,
    baseRevision: candidate.isolation.baseRevision,
    rollbackTargetCandidateVersionId: candidate.rollbackLineage.toCandidateVersionId,
    declaredScope: freeze([...candidate.candidate.declaredScope]),
  });
}

function materializeCandidate(
  scope: RoomEvolutionLedgerScope,
  input: RequestRoomEvolutionIsolatedCandidateLedgerV1,
  created: Extract<Awaited<ReturnType<RoomEvolutionIsolatedCandidateLedgerAdapter["create"]>>, { readonly status: "created" }>,
  receipt: RoomEvolutionCandidateCommandReceiptV1,
): RoomEvolutionRuntimeMaterializedCandidateV1 | null {
  if (!isMatchingCandidateReceipt(receipt, input, created)) return null;
  return freeze({
    scope: cloneScope(scope),
    candidateId: created.candidate.id,
    candidateVersionId: input.candidateVersion.id,
    hypothesisId: created.candidate.hypothesisId,
    candidateRequestHash: input.candidateVersion.candidateHash,
    candidateArtifactHash: receipt.candidateArtifactHash,
    immutableArtifactRef: receipt.immutableArtifactRef,
    candidateProducerActorId: created.candidate.createdByActorId,
    branchRef: created.isolation.branchRef,
    worktreePath: created.isolation.worktreePath,
    rollbackTargetCandidateVersionId: created.rollbackLineage.toCandidateVersionId,
  });
}

function isMatchingCandidateReceipt(
  value: unknown,
  input: RequestRoomEvolutionIsolatedCandidateLedgerV1,
  created: Extract<Awaited<ReturnType<RoomEvolutionIsolatedCandidateLedgerAdapter["create"]>>, { readonly status: "created" }>,
): value is RoomEvolutionCandidateCommandReceiptV1 {
  return isRecord(value)
    && value.status === "materialized"
    && value.candidateId === created.candidate.id
    && value.candidateVersionId === input.candidateVersion.id
    && isHash(value.candidateArtifactHash)
    && isNonBlank(value.immutableArtifactRef)
    && value.worktreePath === created.isolation.worktreePath
    && isTimestamp(value.completedAt);
}

function validateBenchmarkBinding(
  input: SelectAndCommitRoomEvolutionBenchmarkInputV1,
  candidate: RoomEvolutionRuntimeMaterializedCandidateV1,
): string | null {
  const selection = input.selection;
  if (!isRecord(selection) || selection.projectId !== candidate.scope.projectId) return "benchmark_project_mismatch";
  if (selection.roomId !== null && selection.roomId !== candidate.scope.roomId) return "benchmark_room_scope_mismatch";
  if (!isRecord(selection.baseline) || selection.baseline.candidateVersionId !== candidate.rollbackTargetCandidateVersionId) {
    return "benchmark_baseline_lineage_mismatch";
  }
  if (!isRecord(selection.candidate)
    || selection.candidate.candidateVersionId !== candidate.candidateVersionId
    || selection.candidate.immutableArtifactHash !== candidate.candidateArtifactHash) {
    return "benchmark_candidate_artifact_mismatch";
  }
  return null;
}

function validateCanaryPlanBinding(
  input: AppendRoomEvolutionCanaryPlanInputV1,
  candidate: RoomEvolutionRuntimeMaterializedCandidateV1,
): string | null {
  const request = input.allocationInput;
  const allocation = input.allocation;
  if (!isRecord(request) || !isRecord(allocation) || request.projectId !== candidate.scope.projectId) return "canary_project_mismatch";
  if (!isRecord(request.candidate)
    || request.candidate.candidateVersionId !== candidate.candidateVersionId
    || request.candidate.candidateHash !== candidate.candidateArtifactHash) {
    return "canary_candidate_artifact_mismatch";
  }
  if (!isRecord(request.baseline) || request.baseline.strategyVersionId !== candidate.rollbackTargetCandidateVersionId) {
    return "canary_baseline_lineage_mismatch";
  }
  if (allocation.candidateVersionId !== candidate.candidateVersionId
    || allocation.candidateHash !== candidate.candidateArtifactHash
    || allocation.rollbackTargetVersionId !== candidate.rollbackTargetCandidateVersionId) {
    return "canary_allocation_lineage_mismatch";
  }
  return null;
}

function buildEvaluationRequest(
  command: RoomEvolutionRuntimeCommandIdentityV1,
  candidate: RoomEvolutionRuntimeMaterializedCandidateV1,
  benchmark: Extract<Awaited<ReturnType<RoomEvolutionBenchmarkCommitCoordinator["selectAndCommit"]>>, { readonly status: "committed" }>,
  canaryId: string,
  allocation: AppendRoomEvolutionCanaryPlanInputV1["allocation"],
): RoomEvolutionRuntimeIndependentEvaluationRequestV1 {
  return freeze({
    contractVersion: ROOM_EVOLUTION_RUNTIME_CONTRACT_VERSION,
    command: cloneCommand(command),
    candidate: cloneMaterializedCandidate(candidate),
    benchmark: freeze({
      snapshotId: benchmark.snapshot.id,
      snapshotHash: benchmark.snapshot.snapshotHash,
      recordIds: freeze([...benchmark.recordIds]),
    }),
    canary: freeze({
      canaryId,
      candidateVersionId: candidate.candidateVersionId,
      candidateArtifactHash: candidate.candidateArtifactHash,
      rollbackTargetCandidateVersionId: candidate.rollbackTargetCandidateVersionId,
      allocationHash: hashRoomValue(allocation),
    }),
  });
}

function validateEvaluationResult(
  value: unknown,
  expected: RoomEvolutionRuntimeIndependentEvaluationRequestV1,
): string | null {
  if (!isRecord(value) || value.contractVersion !== ROOM_EVOLUTION_RUNTIME_CONTRACT_VERSION) return "evaluation_contract_invalid";
  if (!sameScope(value.scope, expected.candidate.scope)) return "evaluation_scope_mismatch";
  if (value.candidateId !== expected.candidate.candidateId
    || value.candidateVersionId !== expected.candidate.candidateVersionId
    || value.candidateArtifactHash !== expected.candidate.candidateArtifactHash
    || value.benchmarkSnapshotId !== expected.benchmark.snapshotId
    || value.benchmarkSnapshotHash !== expected.benchmark.snapshotHash
    || value.canaryId !== expected.canary.canaryId) {
    return "evaluation_lineage_mismatch";
  }
  if (!isIdentifier(value.evaluatorActorId) || value.evaluatorActorId === expected.candidate.candidateProducerActorId) {
    return "independent_evaluator_required";
  }
  if (!isIdentifier(value.evaluatorBindingId) || !isEvidence(value.evidence)) return "evaluation_evidence_invalid";
  if (!isCanaryRollbackInput(value.canary)) return "canary_evaluation_unbound";
  const canary = value.canary;
  if (!sameScope(canary.scope, expected.candidate.scope)
    || canary.canaryId !== expected.canary.canaryId
    || canary.candidateProducerActorId !== expected.candidate.candidateProducerActorId
    || canary.decisionActorId !== value.evaluatorActorId
    || !sameValue(canary.evidence, value.evidence)
    || !matchesHash(canary.evaluation.allocation, expected.canary.allocationHash)
    || canary.evaluation.allocation.candidateVersionId !== expected.candidate.candidateVersionId
    || canary.evaluation.allocation.candidateHash !== expected.candidate.candidateArtifactHash) {
    return "canary_evaluation_unbound";
  }
  if (!isPromotionCommitRequest(value.promotion)) return "promotion_evaluation_unbound";
  const promotion = value.promotion;
  if (!sameCommand(promotion.command, expected.command)) return "promotion_evaluation_unbound";
  const promotionEvaluation = promotion.evaluation;
  if (!isRecord(promotionEvaluation.proposal)
    || promotionEvaluation.proposal.candidateHash !== expected.candidate.candidateArtifactHash
    || !Array.isArray(promotionEvaluation.proposal.proposerBindingIds)
    || promotionEvaluation.proposal.proposerBindingIds.includes(value.evaluatorBindingId)
    || !Array.isArray(promotionEvaluation.hardGateResults)
    || !promotionEvaluation.hardGateResults.some((gate) => gate.status === "passed" && gate.evaluatorBindingIds.includes(value.evaluatorBindingId))
    || promotionEvaluation.canary === null
    || promotionEvaluation.canary.canaryId !== expected.canary.canaryId
    || promotionEvaluation.canary.candidateHash !== expected.candidate.candidateArtifactHash
    || !promotionEvaluation.canary.evaluatorBindingIds.includes(value.evaluatorBindingId)) {
    return "promotion_independent_evidence_unbound";
  }
  return null;
}

function buildPromotionCommandRequest(
  command: RoomEvolutionRuntimeCommandIdentityV1,
  candidate: RoomEvolutionRuntimeMaterializedCandidateV1,
  canaryId: string,
  decisionId: string,
  recordId: string,
): RoomEvolutionPromotionRuntimeCommandRequestV1 {
  return freeze({
    contractVersion: ROOM_EVOLUTION_RUNTIME_CONTRACT_VERSION,
    command: cloneCommand(command),
    candidate: cloneMaterializedCandidate(candidate),
    canary: freeze({
      id: canaryId,
      candidateVersionId: candidate.candidateVersionId,
      candidateArtifactHash: candidate.candidateArtifactHash,
      rollbackTargetCandidateVersionId: candidate.rollbackTargetCandidateVersionId,
    }),
    decision: freeze({
      id: decisionId,
      recordId,
      candidateArtifactHash: candidate.candidateArtifactHash,
    }),
  });
}

function isMatchingPromotionReceipt(
  value: unknown,
  expected: RoomEvolutionPromotionRuntimeCommandRequestV1,
): value is RoomEvolutionPromotionRuntimeCommandReceiptV1 {
  return isRecord(value)
    && value.status === "promoted"
    && value.candidateId === expected.candidate.candidateId
    && value.candidateVersionId === expected.candidate.candidateVersionId
    && value.candidateArtifactHash === expected.candidate.candidateArtifactHash
    && value.canaryId === expected.canary.id
    && value.decisionId === expected.decision.id
    && isTimestamp(value.completedAt);
}

async function runStage<T>(
  stage: RoomEvolutionRuntimeStageV1,
  operation: () => Promise<T>,
): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false; readonly result: Extract<RoomEvolutionRuntimeResultV1, { readonly status: "withheld" }> }> {
  try {
    return freeze({ ok: true as const, value: await operation() });
  } catch {
    return freeze({ ok: false as const, result: withheld(stage, "stage_failed") });
  }
}

function isStageFailure<T>(
  value: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly result: Extract<RoomEvolutionRuntimeResultV1, { readonly status: "withheld" }> },
): value is { readonly ok: false; readonly result: Extract<RoomEvolutionRuntimeResultV1, { readonly status: "withheld" }> } {
  return value.ok === false;
}

function validateDependencies(value: unknown): string | null {
  if (!isRecord(value)) return "runtime_dependencies_invalid";
  if (!hasMethod(value.hypothesis, "ledger", "appendHypothesis")) return "hypothesis_ledger_port_required";
  if (!hasMethod(value.hypothesisReference, null, "readHypothesisReference")) return "hypothesis_reference_port_required";
  if (!hasMethod(value.candidate, "git", "createDedicatedCandidate")
    || !hasMethod(value.candidate, "contextReader", "readIsolatedCandidateContext")
    || !hasMethod(value.candidate, "ledger", "appendCandidateVersion")) return "candidate_worktree_context_and_ledger_ports_required";
  if (!hasMethod(value.candidateCommand, null, "materialize")) return "candidate_command_port_required";
  if (!hasMethod(value.benchmark, "ledger", "appendBenchmarkCase")) return "benchmark_ledger_port_required";
  if (!hasMethod(value.canaryPlan, "contextReader", "readCanaryContext")
    || !hasMethod(value.canaryPlan, "ledger", "appendCanary")) return "canary_plan_context_and_ledger_ports_required";
  if (!hasMethod(value.evaluator, null, "evaluate")) return "independent_evaluator_port_required";
  if (!hasMethod(value.canaryRollback, "ledger", "appendCanaryObservation")
    || !hasMethod(value.canaryRollback, "ledger", "appendPromotionDecision")
    || !hasMethod(value.canaryRollback, "ledger", "appendRollback")
    || !hasMethod(value.canaryRollback, "runtime", "rollback")) return "canary_rollback_ledger_and_runtime_ports_required";
  if (!hasMethod(value.promotion, "contextReader", "readPromotionContext")
    || !hasMethod(value.promotion, "ledger", "appendPromotionDecision")) return "promotion_context_and_ledger_ports_required";
  if (!hasMethod(value.promotionCommand, null, "promote")) return "promotion_command_port_required";
  return null;
}

function hasMethod(value: unknown, nestedKey: string | null, method: string): boolean {
  if (!isRecord(value)) return false;
  const target = nestedKey === null ? value : value[nestedKey];
  return isRecord(target) && typeof target[method] === "function";
}

function sameCommand(left: unknown, right: RoomEvolutionRuntimeCommandIdentityV1): boolean {
  return isRecord(left)
    && left.commandId === right.commandId
    && left.idempotencyKey === right.idempotencyKey
    && left.correlationId === right.correlationId
    && left.causationId === right.causationId;
}

function sameScope(value: unknown, expected: RoomEvolutionLedgerScope): value is RoomEvolutionLedgerScope {
  return isRecord(value)
    && value.projectId === expected.projectId
    && value.roomId === expected.roomId
    && value.scopeKind === expected.scopeKind
    && value.scopeKey === expected.scopeKey;
}

function cloneCommand(value: RoomEvolutionRuntimeCommandIdentityV1): RoomEvolutionRuntimeCommandIdentityV1 {
  return freeze({ ...value });
}

function cloneScope(value: RoomEvolutionLedgerScope): RoomEvolutionLedgerScope {
  return freeze({ ...value });
}

function cloneMaterializedCandidate(
  value: RoomEvolutionRuntimeMaterializedCandidateV1,
): RoomEvolutionRuntimeMaterializedCandidateV1 {
  return freeze({ ...value, scope: cloneScope(value.scope) });
}

function isCommand(value: unknown): value is RoomEvolutionRuntimeCommandIdentityV1 {
  return isRecord(value)
    && isIdentifier(value.commandId)
    && isIdentifier(value.idempotencyKey)
    && isIdentifier(value.correlationId)
    && (value.causationId === null || isIdentifier(value.causationId));
}

function isEvidence(value: unknown): value is readonly RoomEvolutionEvidenceRefV1[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  const ids = new Set<string>();
  return value.every((entry) => {
    if (!isRecord(entry)
      || !isIdentifier(entry.id)
      || ids.has(entry.id)
      || typeof entry.source !== "string"
      || !isNonBlank(entry.sourceRef)
      || !isHash(entry.evidenceHash)
      || !isTimestamp(entry.observedAt)) return false;
    ids.add(entry.id);
    return true;
  });
}

function isCanaryRollbackInput(value: unknown): value is EvaluateAndRollbackRoomEvolutionCanaryInputV1 {
  return isRecord(value)
    && value.contractVersion === ROOM_EVOLUTION_CANARY_ROLLBACK_COORDINATOR_CONTRACT_VERSION
    && isScope(value.scope)
    && isIdentifier(value.experimentId)
    && isIdentifier(value.canaryId)
    && isIdentifier(value.promotionDecisionId)
    && isIdentifier(value.rollbackId)
    && isIdentifier(value.candidateProducerActorId)
    && isIdentifier(value.decisionActorId)
    && value.candidateProducerActorId !== value.decisionActorId
    && (value.riskClass === "low" || value.riskClass === "moderate" || value.riskClass === "high" || value.riskClass === "critical")
    && (value.authorityTier === "automatic_pre_authorized" || value.authorityTier === "independent" || value.authorityTier === "human")
    && (value.approvalRequestId === null || isIdentifier(value.approvalRequestId))
    && isRecord(value.authorizationEvidence)
    && isEvidence(value.evidence)
    && isCanaryEvaluation(value.evaluation);
}

function isCanaryEvaluation(value: unknown): boolean {
  return isRecord(value)
    && value.contractVersion === ROOM_EVOLUTION_RUNTIME_CONTRACT_VERSION
    && isRecord(value.allocation)
    && isIdentifier(value.allocation.id)
    && isIdentifier(value.allocation.projectId)
    && isIdentifier(value.allocation.candidateVersionId)
    && isHash(value.allocation.candidateHash)
    && isIdentifier(value.allocation.rollbackTargetVersionId)
    && Array.isArray(value.allocation.roomIds)
    && value.allocation.roomIds.every(isIdentifier)
    && isTimestamp(value.evaluatedAt)
    && Array.isArray(value.roomOutcomes);
}

function isPromotionCommitRequest(value: unknown): value is RequestRoomEvolutionPromotionCommitV1 {
  return isRecord(value)
    && hasExactKeys(value, ["command", "decisionId", "evaluation"])
    && isCommand(value.command)
    && isIdentifier(value.decisionId)
    && isPromotionEvaluation(value.evaluation);
}

function isPromotionEvaluation(value: unknown): boolean {
  return isRecord(value)
    && value.contractVersion === ROOM_EVOLUTION_RUNTIME_CONTRACT_VERSION
    && isRecord(value.proposal)
    && isIdentifier(value.proposal.id)
    && isHash(value.proposal.candidateHash)
    && Array.isArray(value.proposal.proposerBindingIds)
    && value.proposal.proposerBindingIds.every(isIdentifier)
    && isTimestamp(value.proposal.requestedAt)
    && Array.isArray(value.requiredHardGateIds)
    && value.requiredHardGateIds.every(isIdentifier)
    && Array.isArray(value.hardGateResults)
    && value.hardGateResults.every(isPromotionHardGateResult)
    && Array.isArray(value.risks)
    && (value.canary === null || isPromotionCanaryEvidence(value.canary))
    && isTimestamp(value.evaluatedAt);
}

function isPromotionHardGateResult(value: unknown): boolean {
  return isRecord(value)
    && isIdentifier(value.gateId)
    && (value.status === "passed" || value.status === "failed")
    && Array.isArray(value.evaluatorBindingIds)
    && value.evaluatorBindingIds.every(isIdentifier)
    && isHash(value.evidenceHash);
}

function isPromotionCanaryEvidence(value: unknown): boolean {
  return isRecord(value)
    && value.source === "durable_room_evolution_canary_ledger"
    && isIdentifier(value.canaryId)
    && isHash(value.candidateHash)
    && isTimestamp(value.completedAt)
    && Array.isArray(value.evaluatorBindingIds)
    && value.evaluatorBindingIds.every(isIdentifier);
}

function isScope(value: unknown): value is RoomEvolutionLedgerScope {
  return isRecord(value)
    && isIdentifier(value.projectId)
    && (value.roomId === null || isIdentifier(value.roomId))
    && (value.scopeKind === "project" || value.scopeKind === "room")
    && isIdentifier(value.scopeKey);
}

function sameValue(left: unknown, right: unknown): boolean {
  try {
    return hashRoomValue(left) === hashRoomValue(right);
  } catch {
    return false;
  }
}

function matchesHash(value: unknown, expected: string): boolean {
  try {
    return hashRoomValue(value) === expected;
  } catch {
    return false;
  }
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

function isCandidateIsolationIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]{2,127}$/u.test(value);
}

function isMatchingDurableHypothesisReference(
  value: unknown,
  scope: RoomEvolutionLedgerScope,
  hypothesisId: string,
): value is RoomEvolutionRuntimeDurableHypothesisReferenceV1 {
  return isRecord(value)
    && value.contractVersion === ROOM_EVOLUTION_RUNTIME_CONTRACT_VERSION
    && isRecord(value.scope)
    && value.scope.projectId === scope.projectId
    && value.scope.roomId === scope.roomId
    && value.scope.scopeKind === scope.scopeKind
    && value.scope.scopeKey === scope.scopeKey
    && value.hypothesisId === hypothesisId
    && value.ledgerRecordId === hypothesisId
    && isHash(value.evidenceHash)
    && isTimestamp(value.recordedAt);
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
}

function isNonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonicalExpected = [...expected].sort();
  return actual.length === canonicalExpected.length && actual.every((key, index) => key === canonicalExpected[index]);
}

function withheld(
  stage: RoomEvolutionRuntimeStageV1,
  reason: string,
): Extract<RoomEvolutionRuntimeResultV1, { readonly status: "withheld" }> {
  return freeze({ status: "withheld" as const, stage, reason });
}

function freeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  for (const nested of Object.values(value)) freeze(nested);
  return Object.freeze(value);
}
