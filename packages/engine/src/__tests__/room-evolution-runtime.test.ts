import { describe, expect, it, vi } from "vitest";

import {
  allocateRoomEvolutionCanary,
  collectAuthorizedRoomEvolutionOutcomeSignals,
  hashRoomValue,
  type AppendRoomEvolutionBenchmarkCaseInputV1,
  type AppendRoomEvolutionCanaryInputV1,
  type AppendRoomEvolutionCandidateVersionInputV1,
  type AppendRoomEvolutionHypothesisInputV1,
  type AppendRoomEvolutionPromotionDecisionInputV1,
  type RoomEvolutionCanaryRecordV1,
  type RoomEvolutionCandidateVersionRecordV1,
  type RoomEvolutionHypothesisRecordV1,
  type RoomEvolutionLedgerAppendResult,
  type RoomEvolutionPromotionDecisionRecordV1,
} from "@fusion/core";

import {
  RoomEvolutionRuntime,
  type RoomEvolutionRuntimeDependenciesV1,
  type RunRoomEvolutionRuntimeInputV1,
} from "../room-evolution-runtime.js";

const ARTIFACT_HASH = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BASE_REVISION = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ROLLBACK_REVISION = "cccccccccccccccccccccccccccccccccccccccc";
const PROJECT_ID = "project-runtime";
const ROOM_ID = "room-runtime";
const CANDIDATE_ID = "candidate-runtime-v2";
const ROLLBACK_CANDIDATE_ID = "candidate-runtime-v1";
const HYPOTHESIS_ID = "hypothesis:template-runtime:room:room-runtime:v1";
const AS_OF = "2026-07-19T17:00:00.000Z";
const CANARY_EVALUATED_AT = "2026-07-19T17:01:00.000Z";
const PROMOTION_EVALUATED_AT = "2026-07-19T17:02:00.000Z";

const scope = {
  projectId: PROJECT_ID,
  roomId: ROOM_ID,
  scopeKind: "room" as const,
  scopeKey: `room:${ROOM_ID}`,
};

function command() {
  return {
    commandId: "command-runtime-1",
    idempotencyKey: "key-runtime-1",
    correlationId: "correlation-runtime-1",
    causationId: null,
  };
}

function evidence(id = "evidence-runtime-1") {
  return {
    id,
    source: "independent_review" as const,
    sourceRef: `evidence-${id}`,
    evidenceHash: ARTIFACT_HASH,
    observedAt: CANARY_EVALUATED_AT,
  };
}

function hypotheses() {
  const observations = collectAuthorizedRoomEvolutionOutcomeSignals({
    contractVersion: 1,
    projectId: PROJECT_ID,
    asOf: AS_OF,
    maxObservationAgeMs: 60_000,
    observations: [
      {
        contractVersion: 1,
        id: "failure-runtime-1",
        projectId: PROJECT_ID,
        roomId: ROOM_ID,
        kind: "failure",
        source: "deterministic_gate",
        sourceRef: "failure-runtime-source",
        evidenceHash: ARTIFACT_HASH,
        observedAt: AS_OF,
        unit: "count",
        value: 1,
      },
      {
        contractVersion: 1,
        id: "retry-runtime-1",
        projectId: PROJECT_ID,
        roomId: ROOM_ID,
        kind: "retry",
        source: "durable_room_ledger",
        sourceRef: "retry-runtime-source",
        evidenceHash: ARTIFACT_HASH,
        observedAt: AS_OF,
        unit: "count",
        value: 1,
      },
    ],
  });
  if (!observations.ok) throw new Error(JSON.stringify(observations.issues));
  return {
    contractVersion: 1 as const,
    signals: observations.value,
    templates: [{
      contractVersion: 1 as const,
      id: "template-runtime",
      scopeKind: "room" as const,
      revision: 1,
      triggerSignalKinds: ["failure", "retry"] as const,
      minimumObservationCount: 2,
      declaredScope: ["policy"],
      riskClass: "moderate" as const,
      expectedMechanism: "Bounded policy candidate reduces repeated retries.",
      affectedDomains: ["orchestration"],
      createdByActorId: "hypothesis-controller",
    }],
  };
}

function candidateInput(hypothesisId = HYPOTHESIS_ID) {
  const request = {
    contractVersion: 1 as const,
    command: command(),
    scope: { projectId: PROJECT_ID, roomId: ROOM_ID },
    candidate: {
      id: CANDIDATE_ID,
      hypothesisId,
      kind: "policy" as const,
      riskClass: "moderate" as const,
      mechanism: "policy" as const,
      declaredScope: ["policy"],
      repositoryRootPath: "C:\\repo\\runtime",
      baseRevision: BASE_REVISION,
      rollbackTarget: {
        candidateVersionId: ROLLBACK_CANDIDATE_ID,
        revision: ROLLBACK_REVISION,
        candidateRef: `refs/heads/fusion/evolution/${ROLLBACK_CANDIDATE_ID}`,
      },
      createdByActorId: "candidate-producer",
    },
    approval: null,
  };
  return {
    contractVersion: 1 as const,
    request,
    candidateVersion: {
      id: CANDIDATE_ID,
      hypothesisId,
      candidateHash: hashRoomValue(request),
      versionNumber: 2,
      baseCandidateVersionId: ROLLBACK_CANDIDATE_ID,
      rollbackTargetCandidateVersionId: ROLLBACK_CANDIDATE_ID,
    },
  };
}

function benchmarkInput() {
  const collections = ["fixed", "rolling_difficult", "adversarial", "authorized_historical_replay"] as const;
  const materialization = (collection: typeof collections[number]) => ({
    casePayload: { collection },
    expectedOutcome: { status: "pass" },
  });
  const cases = collections.map((collection) => {
    const body = materialization(collection);
    const source = collection === "authorized_historical_replay"
      ? {
        kind: "authorized_historical_outcome" as const,
        inclusionAuthority: "authorized_historical_ingestion" as const,
        authorization: {
          id: "authorization-history-runtime",
          evidenceHash: ARTIFACT_HASH,
          grantedByActorId: "benchmark-governance",
          grantedAt: AS_OF,
        },
      }
      : collection === "adversarial"
        ? {
          kind: "independent_adversarial_corpus" as const,
          inclusionAuthority: "independent_benchmark_governance" as const,
          authorization: null,
        }
        : collection === "rolling_difficult"
          ? {
            kind: "authorized_difficulty_pool" as const,
            inclusionAuthority: "human_curator" as const,
            authorization: null,
          }
          : {
            kind: "human_curated_fixed" as const,
            inclusionAuthority: "human_curator" as const,
            authorization: null,
          };
    return {
      contractVersion: 1 as const,
      id: `case-runtime-${collection}`,
      version: 1,
      contentHash: hashRoomValue(body),
      projectId: PROJECT_ID,
      roomId: ROOM_ID,
      domain: "coding",
      collection,
      difficulty: collection === "rolling_difficult" ? 95 : 50,
      risk: { classification: "low" as const, authorization: null },
      privacy: { containsPrivateData: false, authorization: null },
      source: {
        kind: source.kind,
        reference: `catalog-${collection}`,
        evidenceHash: ARTIFACT_HASH,
        inclusionAuthority: source.inclusionAuthority,
        authorActorId: "benchmark-governance",
        authorization: source.authorization,
      },
    };
  });
  const selection = {
    contractVersion: 1 as const,
    projectId: PROJECT_ID,
    roomId: ROOM_ID,
    snapshotId: "benchmark-snapshot-runtime-v1",
    catalogVersion: 1,
    asOf: AS_OF,
    baseline: {
      candidateVersionId: ROLLBACK_CANDIDATE_ID,
      immutableArtifactHash: ARTIFACT_HASH,
      producerActorIds: ["baseline-producer"],
    },
    candidate: {
      candidateVersionId: CANDIDATE_ID,
      immutableArtifactHash: ARTIFACT_HASH,
      producerActorIds: ["candidate-producer"],
    },
    plans: collections.map((collection) => ({ collection, minimumCases: 1, maximumCases: 1 })),
    cases,
  };
  return {
    contractVersion: 1 as const,
    selection,
    materializations: cases.map((entry) => ({
      caseId: entry.id,
      version: entry.version,
      contentHash: entry.contentHash,
      ...materialization(entry.collection),
      createdAt: AS_OF,
    })),
  };
}

function canaryPlanInput() {
  const allocationInput = {
    contractVersion: 1 as const,
    projectId: PROJECT_ID,
    requestId: "request-runtime-v1",
    candidate: {
      candidateVersionId: CANDIDATE_ID,
      candidateHash: ARTIFACT_HASH,
      riskClass: "moderate" as const,
      eligibleRoomIds: [ROOM_ID],
    },
    baseline: {
      strategyVersionId: ROLLBACK_CANDIDATE_ID,
      snapshotId: "baseline-runtime-v1",
      snapshotHash: ARTIFACT_HASH,
    },
    authorization: {
      source: "durable_independent_gate_ledger" as const,
      candidateHash: ARTIFACT_HASH,
      gateResultIds: ["gate-runtime-security"],
      independentEvaluatorBindingIds: ["binding-independent"],
      authorizedAt: AS_OF,
      humanApprovalId: null,
    },
    capacity: {
      configuredSlots: 4,
      activeSlots: 1,
      reservedRecoverySlots: 1,
      observedAt: AS_OF,
    },
    policy: {
      minimumRooms: 1,
      maximumRooms: 1,
      maximumEligibleFraction: 1,
      minimumSamplesPerRoom: 2,
      objectives: [{ id: "quality", direction: "higher_is_better" as const, maximumDegradation: 0.1 }],
    },
    allocatedAt: AS_OF,
  };
  const allocated = allocateRoomEvolutionCanary(allocationInput);
  if (!allocated.ok) throw new Error(JSON.stringify(allocated.reason));
  return { allocationInput, allocation: allocated.allocation };
}

function runtimeInput(): RunRoomEvolutionRuntimeInputV1 {
  return {
    contractVersion: 1,
    command: command(),
    hypotheses: hypotheses(),
    candidate: candidateInput(),
    benchmark: benchmarkInput(),
    canaryPlan: canaryPlanInput(),
  };
}

function continuationInput() {
  return {
    contractVersion: 1 as const,
    command: command(),
    candidate: candidateInput("hypothesis-runtime-1"),
    benchmark: benchmarkInput(),
    canaryPlan: canaryPlanInput(),
  };
}

function hypothesisRecord(
  input: AppendRoomEvolutionHypothesisInputV1,
): RoomEvolutionLedgerAppendResult<"room_evolution_hypotheses", RoomEvolutionHypothesisRecordV1> {
  return {
    table: "room_evolution_hypotheses",
    record: {
      contractVersion: 1,
      id: input.id,
      projectId: input.scope.projectId,
      roomId: input.scope.roomId,
      scopeKind: input.scope.scopeKind,
      scopeKey: input.scope.scopeKey,
      revision: input.revision,
      state: input.state,
      sourceSignalKinds: input.sourceSignalKinds,
      evidence: input.evidence,
      evidenceHash: input.evidenceHash,
      declaredScope: input.declaredScope,
      riskClass: input.riskClass,
      expectedMechanism: input.expectedMechanism,
      affectedDomains: input.affectedDomains,
      createdByActorId: input.createdByActorId,
      createdAt: input.createdAt,
    },
  };
}

function candidateRecord(
  input: AppendRoomEvolutionCandidateVersionInputV1,
): RoomEvolutionLedgerAppendResult<"room_evolution_candidate_versions", RoomEvolutionCandidateVersionRecordV1> {
  return {
    table: "room_evolution_candidate_versions",
    record: {
      contractVersion: 1,
      id: input.id,
      projectId: input.scope.projectId,
      roomId: input.scope.roomId,
      scopeKind: input.scope.scopeKind,
      scopeKey: input.scope.scopeKey,
      hypothesisId: input.hypothesisId,
      versionNumber: input.versionNumber,
      candidateKind: input.candidateKind,
      baseRevision: input.baseRevision,
      candidateRef: input.candidateRef,
      isolationKind: input.isolationKind,
      isolationRef: input.isolationRef,
      immutableInput: input.immutableInput,
      inputHash: input.inputHash,
      producedByActorId: input.producedByActorId,
      baseCandidateVersionId: input.baseCandidateVersionId,
      rollbackTargetCandidateVersionId: input.rollbackTargetCandidateVersionId,
      createdAt: input.createdAt,
    },
  };
}

function canaryRecord(
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

function promotionRecord(
  input: AppendRoomEvolutionPromotionDecisionInputV1,
): RoomEvolutionLedgerAppendResult<"room_evolution_promotion_decisions", RoomEvolutionPromotionDecisionRecordV1> {
  return {
    table: "room_evolution_promotion_decisions",
    record: {
      contractVersion: 1,
      id: input.id,
      projectId: input.scope.projectId,
      roomId: input.scope.roomId,
      scopeKind: input.scope.scopeKind,
      scopeKey: input.scope.scopeKey,
      experimentId: input.experimentId,
      candidateVersionId: input.candidateVersionId,
      canaryId: input.canaryId,
      decision: input.decision,
      riskClass: input.riskClass,
      authorityTier: input.authorityTier,
      candidateProducerActorId: input.candidateProducerActorId,
      decisionActorId: input.decisionActorId,
      approvalRequestId: input.approvalRequestId,
      authorizationEvidence: input.authorizationEvidence,
      evidence: input.evidence,
      evidenceHash: input.evidenceHash,
      rollbackTargetCandidateVersionId: input.rollbackTargetCandidateVersionId,
      decidedAt: input.decidedAt,
    },
  };
}

function harness(options: { readonly degraded?: boolean; readonly forgedEvaluation?: boolean } = {}) {
  const input = runtimeInput();
  const continuation = continuationInput();
  const calls: string[] = [];
  const plan = input.canaryPlan;
  const dependencies: RoomEvolutionRuntimeDependenciesV1 = {
    hypothesis: {
      ledger: {
        appendHypothesis: vi.fn(async (append) => {
          calls.push("hypothesis");
          return hypothesisRecord(append);
        }),
      },
    },
    hypothesisReference: {
      readHypothesisReference: vi.fn(async (request) => {
        calls.push("hypothesis-reference");
        return {
          contractVersion: 1 as const,
          scope: request.scope,
          hypothesisId: request.hypothesisId,
          ledgerRecordId: request.hypothesisId,
          evidenceHash: ARTIFACT_HASH,
          recordedAt: AS_OF,
        };
      }),
    },
    candidate: {
      git: {
        createDedicatedCandidate: vi.fn(async (request) => {
          calls.push("worktree");
          return {
            contractVersion: 1,
            candidateId: request.candidateId,
            scope: request.scope,
            repositoryRootPath: request.repositoryRootPath,
            branchRef: request.branchRef,
            worktreeName: request.worktreeName,
            worktreePath: `${request.repositoryRootPath}\\.worktrees\\${request.worktreeName}`,
            baseRevision: request.baseRevision,
            rollbackTarget: request.rollbackTarget,
            checkout: {
              kind: "linked_worktree" as const,
              cleanliness: "clean" as const,
              occupancy: "dedicated" as const,
              mutationTarget: "candidate_worktree" as const,
            },
          };
        }),
      },
      contextReader: {
        readIsolatedCandidateContext: vi.fn(async ({ request, candidateVersion }) => ({
          contractVersion: 1,
          scope,
          candidateId: candidateVersion.id,
          hypothesisId: candidateVersion.hypothesisId,
          candidateHash: candidateVersion.candidateHash,
          versionNumber: candidateVersion.versionNumber,
          baseCandidateVersionId: candidateVersion.baseCandidateVersionId,
          rollbackTargetCandidateVersionId: candidateVersion.rollbackTargetCandidateVersionId,
          producedByActorId: request.candidate.createdByActorId,
          createdAt: AS_OF,
        })),
      },
      ledger: {
        appendCandidateVersion: vi.fn(async (append) => {
          calls.push("candidate-ledger");
          return candidateRecord(append);
        }),
      },
    },
    candidateCommand: {
      materialize: vi.fn(async (request) => {
        calls.push("candidate-command");
        return {
          status: "materialized" as const,
          candidateId: request.candidateId,
          candidateVersionId: request.candidateVersionId,
          candidateArtifactHash: ARTIFACT_HASH,
          immutableArtifactRef: "artifact-runtime-v2",
          worktreePath: request.worktreePath,
          completedAt: CANARY_EVALUATED_AT,
        };
      }),
    },
    benchmark: {
      ledger: {
        appendBenchmarkCase: vi.fn(async (append: AppendRoomEvolutionBenchmarkCaseInputV1) => {
          calls.push("benchmark");
          return { table: "room_evolution_benchmark_cases" as const, record: { id: append.id, contentHash: append.contentHash } };
        }),
      },
    },
    canaryPlan: {
      contextReader: {
        readCanaryContext: vi.fn(async () => ({
          contractVersion: 1,
          scope,
          experimentId: "experiment-runtime",
          candidateVersionId: CANDIDATE_ID,
          candidateHash: ARTIFACT_HASH,
          candidateProducerActorId: "candidate-producer",
          canaryControllerActorId: "canary-controller",
          rollbackTargetCandidateVersionId: ROLLBACK_CANDIDATE_ID,
          allocationVersion: 1,
          evidence: [{ ...evidence("canary-plan-runtime"), source: "durable_room_ledger" as const }],
        })),
      },
      ledger: {
        appendCanary: vi.fn(async (append) => {
          calls.push("canary-plan");
          return canaryRecord(append);
        }),
      },
    },
    evaluator: {
      evaluate: vi.fn(async (request) => {
        calls.push("evaluator");
        const quality = options.degraded ? 0.5 : 0.92;
        const runtimeEvidence = [evidence()];
        return {
          contractVersion: 1 as const,
          scope,
          candidateId: options.forgedEvaluation ? "candidate-forged" : request.candidate.candidateId,
          candidateVersionId: request.candidate.candidateVersionId,
          candidateArtifactHash: request.candidate.candidateArtifactHash,
          benchmarkSnapshotId: request.benchmark.snapshotId,
          benchmarkSnapshotHash: request.benchmark.snapshotHash,
          canaryId: request.canary.canaryId,
          evaluatorActorId: "independent-evaluator",
          evaluatorBindingId: "binding-independent",
          evidence: runtimeEvidence,
          canary: {
            contractVersion: 1 as const,
            scope,
            experimentId: "experiment-runtime",
            canaryId: request.canary.canaryId,
            promotionDecisionId: "decision-canary-runtime",
            rollbackId: "rollback-runtime",
            candidateProducerActorId: "candidate-producer",
            decisionActorId: "independent-evaluator",
            riskClass: "moderate" as const,
            authorityTier: "independent" as const,
            approvalRequestId: null,
            authorizationEvidence: { source: "durable_independent_gate_ledger" },
            evidence: runtimeEvidence,
            evaluation: {
              contractVersion: 1 as const,
              allocation: plan.allocation,
              evaluatedAt: CANARY_EVALUATED_AT,
              roomOutcomes: [{
                roomId: ROOM_ID,
                baselineSnapshotId: "baseline-runtime-v1",
                samples: 2,
                objectives: [{ id: "quality", baseline: 0.9, candidate: quality }],
              }],
            },
          },
          promotion: {
            command: request.command,
            decisionId: "decision-promotion-runtime",
            evaluation: {
              contractVersion: 1 as const,
              proposal: {
                id: "proposal-runtime",
                candidateHash: ARTIFACT_HASH,
                proposerBindingIds: ["binding-producer"],
                requestedAt: AS_OF,
              },
              requiredHardGateIds: ["gate-security"],
              hardGateResults: [{
                gateId: "gate-security",
                status: "passed" as const,
                evaluatorBindingIds: ["binding-independent"],
                evidenceHash: ARTIFACT_HASH,
              }],
              risks: [],
              canary: {
                source: "durable_room_evolution_canary_ledger" as const,
                canaryId: request.canary.canaryId,
                candidateHash: ARTIFACT_HASH,
                completedAt: CANARY_EVALUATED_AT,
                sampleCount: 2,
                minimumSampleCount: 2,
                qualityScore: quality,
                minimumQualityScore: 0.8,
                metrics: [{ id: "quality", baseline: 0.9, canary: quality, maxDegradation: 0.1 }],
                evaluatorBindingIds: ["binding-independent"],
              },
              evaluatedAt: PROMOTION_EVALUATED_AT,
            },
          },
        };
      }),
    },
    canaryRollback: {
      ledger: {
        appendCanaryObservation: vi.fn(async (append) => {
          calls.push("rollback-observation");
          return { table: "room_evolution_canary_observations" as const, record: { id: append.id } };
        }),
        appendPromotionDecision: vi.fn(async (append) => {
          calls.push("rollback-decision");
          return { table: "room_evolution_promotion_decisions" as const, record: { id: append.id } };
        }),
        appendRollback: vi.fn(async (append) => {
          calls.push("rollback-ledger");
          return { table: "room_evolution_rollbacks" as const, record: { id: append.id } };
        }),
      },
      runtime: {
        rollback: vi.fn(async (request) => {
          calls.push("rollback-command");
          return {
            status: "rolled_back" as const,
            canaryId: request.canaryId,
            targetVersionId: request.targetVersionId,
            roomIds: request.roomIds,
            completedAt: PROMOTION_EVALUATED_AT,
          };
        }),
      },
    },
    promotion: {
      contextReader: {
        readPromotionContext: vi.fn(async (read) => ({
          contractVersion: 1,
          scope,
          proposalId: read.evaluation.proposal.id,
          candidateHash: read.evaluation.proposal.candidateHash,
          experimentId: "experiment-runtime",
          candidateVersionId: CANDIDATE_ID,
          canaryId: read.evaluation.canary?.canaryId ?? null,
          rollbackTargetCandidateVersionId: ROLLBACK_CANDIDATE_ID,
          riskClass: "moderate" as const,
          changeSurfaces: ["policy" as const],
          autoPromotionPreAuthorized: false,
          hardGates: [
            { gateClass: "correctness" as const, outcome: "passed" as const, evaluatorActorId: "gate-correctness" },
            { gateClass: "security" as const, outcome: "passed" as const, evaluatorActorId: "gate-security" },
            { gateClass: "user_constraints" as const, outcome: "passed" as const, evaluatorActorId: "gate-constraints" },
            { gateClass: "evidence_integrity" as const, outcome: "passed" as const, evaluatorActorId: "gate-evidence" },
            { gateClass: "regression" as const, outcome: "passed" as const, evaluatorActorId: "gate-regression" },
          ],
          authorityTier: "independent" as const,
          candidateProducerActorId: "candidate-producer",
          decisionActorId: "promotion-arbiter",
          approvalRequestId: null,
          authorizationEvidence: { source: "durable_independent_gate_ledger" },
          evidence: [{ ...evidence("promotion-runtime"), source: "durable_room_ledger" as const }],
        })),
      },
      ledger: {
        appendPromotionDecision: vi.fn(async (append) => {
          calls.push("promotion-ledger");
          return promotionRecord(append);
        }),
      },
    },
    promotionCommand: {
      promote: vi.fn(async (request) => {
        calls.push("promotion-command");
        return {
          status: "promoted" as const,
          candidateId: request.candidate.candidateId,
          candidateVersionId: request.candidate.candidateVersionId,
          candidateArtifactHash: request.candidate.candidateArtifactHash,
          canaryId: request.canary.id,
          decisionId: request.decision.id,
          completedAt: PROMOTION_EVALUATED_AT,
        };
      }),
    },
  };
  return { input, continuation, calls, dependencies };
}

describe("RoomEvolutionRuntime", () => {
  it("requires every execution port explicitly and never supplies a promotion command default", async () => {
    const harnessed = harness();
    const dependencies = {
      ...harnessed.dependencies,
      promotionCommand: {},
    } as unknown as RoomEvolutionRuntimeDependenciesV1;

    const result = await new RoomEvolutionRuntime(dependencies).continueFromDurableCandidate(harnessed.continuation);

    expect(result).toEqual({
      status: "withheld",
      stage: "dependency",
      reason: "promotion_command_port_required",
    });
    expect(harnessed.calls).toEqual([]);
  });

  it("fails closed at the current derived-hypothesis to isolated-candidate identifier boundary", async () => {
    const harnessed = harness();

    const result = await new RoomEvolutionRuntime(harnessed.dependencies).run(harnessed.input);

    expect(result).toEqual({
      status: "withheld",
      stage: "candidate",
      reason: "candidate_hypothesis_identifier_incompatible",
    });
    expect(harnessed.calls).toEqual(["hypothesis"]);
  });

  it("requires a durable hypothesis reference before reopening a continuation candidate", async () => {
    const harnessed = harness();
    harnessed.dependencies.hypothesisReference.readHypothesisReference = vi.fn(async () => null);

    const result = await new RoomEvolutionRuntime(harnessed.dependencies).continueFromDurableCandidate(harnessed.continuation);

    expect(result).toEqual({
      status: "withheld",
      stage: "hypothesis",
      reason: "durable_hypothesis_reference_unavailable",
    });
    expect(harnessed.calls).toEqual([]);
  });

  it("materializes only in the isolated worktree and promotes only after independent evidence, an eligible canary, and a durable decision", async () => {
    const harnessed = harness();

    const result = await new RoomEvolutionRuntime(harnessed.dependencies).continueFromDurableCandidate(harnessed.continuation);

    expect(result).toMatchObject({
      status: "promoted",
      candidate: { candidateId: CANDIDATE_ID, candidateArtifactHash: ARTIFACT_HASH },
      decisionId: "decision-promotion-runtime",
    });
    expect(harnessed.calls).toEqual([
      "hypothesis-reference",
      "worktree",
      "candidate-ledger",
      "candidate-command",
      "benchmark",
      "benchmark",
      "benchmark",
      "benchmark",
      "canary-plan",
      "evaluator",
      "promotion-ledger",
      "promotion-command",
    ]);
  });

  it("withholds a forged evaluator lineage before canary execution or promotion", async () => {
    const harnessed = harness({ forgedEvaluation: true });

    const result = await new RoomEvolutionRuntime(harnessed.dependencies).continueFromDurableCandidate(harnessed.continuation);

    expect(result).toEqual({
      status: "withheld",
      stage: "independent_evaluation",
      reason: "evaluation_lineage_mismatch",
    });
    expect(harnessed.calls).toContain("evaluator");
    expect(harnessed.calls).not.toContain("promotion-ledger");
    expect(harnessed.calls).not.toContain("promotion-command");
    expect(harnessed.calls).not.toContain("rollback-command");
  });

  it("never reports a promotion when the runtime command cannot prove the exact durable decision and candidate", async () => {
    const harnessed = harness();
    harnessed.dependencies.promotionCommand.promote = vi.fn(async (request) => {
      harnessed.calls.push("promotion-command");
      return {
        status: "promoted" as const,
        candidateId: request.candidate.candidateId,
        candidateVersionId: request.candidate.candidateVersionId,
        candidateArtifactHash: request.candidate.candidateArtifactHash,
        canaryId: request.canary.id,
        decisionId: "decision-mismatched",
        completedAt: PROMOTION_EVALUATED_AT,
      };
    });

    const result = await new RoomEvolutionRuntime(harnessed.dependencies).continueFromDurableCandidate(harnessed.continuation);

    expect(result).toMatchObject({
      status: "promotion_execution_failed",
      reason: "promotion_command_receipt_invalid",
    });
    expect(harnessed.calls).toContain("promotion-ledger");
    expect(harnessed.calls).toContain("promotion-command");
  });

  it("uses the existing canary rollback coordinator and never attempts promotion when the independent canary degrades", async () => {
    const harnessed = harness({ degraded: true });

    const result = await new RoomEvolutionRuntime(harnessed.dependencies).continueFromDurableCandidate(harnessed.continuation);

    expect(result).toMatchObject({
      status: "rolled_back",
      rollbackTargetCandidateVersionId: ROLLBACK_CANDIDATE_ID,
    });
    expect(harnessed.calls.slice(-4)).toEqual([
      "rollback-observation",
      "rollback-decision",
      "rollback-command",
      "rollback-ledger",
    ]);
    expect(harnessed.calls).not.toContain("promotion-ledger");
    expect(harnessed.calls).not.toContain("promotion-command");
  });
});
