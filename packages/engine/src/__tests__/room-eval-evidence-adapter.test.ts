import {
  TASK_EVALUATION_EVIDENCE_SOURCE_ORDER,
  type EvalRun,
  type EvalTaskResult,
  type EvalTaskResultCreateInput,
  type RoomCandidateRecordV1,
  type RoomEvidenceLedgerCandidateEvaluation,
  type RoomEvidenceLedgerScope,
  type RoomEvidenceRecordV1,
  type RoomGateResultV1,
  type RoomReviewRecordV1,
  type TaskDetail,
  type TaskEvaluationEvidenceBundle,
  type TaskStore,
} from "@fusion/core";
import { describe, expect, it, vi } from "vitest";

import {
  RoomEvalEvidenceAdapter,
  RoomEvalEvidenceAdapterError,
} from "../room-eval-evidence-adapter.js";

const CREATED_AT = "2026-07-19T12:00:00.000Z";
const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const SCOPE = {
  projectId: "project-1",
  roomId: "room-1",
} as const satisfies RoomEvidenceLedgerScope;

type RoomEvalEvidenceSnapshotFixture = RoomEvidenceLedgerCandidateEvaluation & {
  readonly evidence: readonly RoomEvidenceRecordV1[];
};

function task(): TaskDetail {
  return {
    id: "task-1",
    title: "Evaluate Room evidence",
  } as unknown as TaskDetail;
}

function collectorBundle(taskId = "task-1", runId = "ER-1"): TaskEvaluationEvidenceBundle {
  return {
    taskId,
    runId,
    sourceOrder: TASK_EVALUATION_EVIDENCE_SOURCE_ORDER,
    taskMetadata: [],
    commits: [],
    workflow: [],
    reviews: [],
    documents: [],
    taskActivity: [],
    agentLogs: [],
    runAudit: [],
  };
}

function evalRun(projectId = SCOPE.projectId): EvalRun {
  return {
    id: "ER-1",
    projectId,
    status: "running",
    trigger: "manual",
    scope: "project",
    window: {},
    requestedTaskIds: ["task-1"],
    evaluatedTaskIds: [],
    counts: { totalTasks: 1, scoredTasks: 0, skippedTasks: 0, erroredTasks: 0 },
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

function candidate(overrides: Partial<RoomCandidateRecordV1> = {}): RoomCandidateRecordV1 {
  return {
    contractVersion: 1,
    id: "candidate-1",
    roomId: SCOPE.roomId,
    nodeId: "node-1",
    producingBindingId: "binding-producer",
    nativeSessionId: "native-producer",
    happierSessionId: "happier-producer",
    providerId: "codex",
    modelRef: "gpt-5.6",
    protocolId: "protocol-1",
    protocolVersion: 1,
    contextVersion: "context-v1",
    inputVersion: "input-v1",
    configVersion: "config-v1",
    contentHash: HASH_A,
    artifactIds: [],
    parentCandidateIds: [],
    gateResultIds: [],
    reviewIds: [],
    promotionState: "pending",
    createdAt: CREATED_AT,
    ...overrides,
  } as RoomCandidateRecordV1;
}

function evidence(overrides: Partial<RoomEvidenceRecordV1> = {}): RoomEvidenceRecordV1 {
  return {
    contractVersion: 1,
    id: "evidence-1",
    roomId: SCOPE.roomId,
    nodeId: "node-1",
    candidateId: "candidate-1",
    kind: "test",
    authoritativeSourceUri: "https://evidence.example/test-1",
    sourceVersionOrHash: "revision-1",
    capturedAt: CREATED_AT,
    collectionMethod: "vitest",
    collectorBindingId: "binding-verifier",
    contentHash: HASH_B,
    artifactIds: [],
    authoritativeSourceRetained: true,
    expiresAt: null,
    ...overrides,
  } as RoomEvidenceRecordV1;
}

function review(overrides: Partial<RoomReviewRecordV1> = {}): RoomReviewRecordV1 {
  return {
    contractVersion: 1,
    id: "review-1",
    roomId: SCOPE.roomId,
    nodeId: "node-1",
    candidateId: "candidate-1",
    blindCandidateRef: "blind-candidate-a",
    reviewerBindingId: "binding-reviewer",
    reviewerNativeSessionId: "native-reviewer",
    reviewerHappierSessionId: "happier-reviewer",
    blind: true,
    producerIdentityHidden: true,
    independentFromProducer: true,
    verdict: "accept",
    rubricVersion: "rubric-v1",
    evidenceIds: ["evidence-1"],
    dissentIds: [],
    reviewContentHash: HASH_B,
    committedAt: CREATED_AT,
    ...overrides,
  } as RoomReviewRecordV1;
}

function gate(overrides: Partial<RoomGateResultV1> = {}): RoomGateResultV1 {
  return {
    contractVersion: 1,
    id: "gate-1",
    roomId: SCOPE.roomId,
    nodeId: "node-1",
    candidateId: "candidate-1",
    profileId: "code-v1",
    kind: "test",
    hard: true,
    status: "passed",
    evidenceIds: ["evidence-1"],
    evaluatorBindingId: "binding-verifier",
    command: "pnpm test",
    exitCode: 0,
    recordedAt: CREATED_AT,
    ...overrides,
  } as RoomGateResultV1;
}

function snapshot(overrides: Partial<RoomEvalEvidenceSnapshotFixture> = {}): RoomEvalEvidenceSnapshotFixture {
  return {
    scope: SCOPE,
    candidate: candidate(),
    evidence: [evidence()],
    gateResults: [gate()],
    reviews: [review()],
    dissents: [],
    promotions: [],
    ...overrides,
  } as RoomEvalEvidenceSnapshotFixture;
}

function resultInput(overrides: Partial<EvalTaskResultCreateInput> = {}): EvalTaskResultCreateInput {
  return {
    taskId: "task-1",
    taskSnapshot: { taskId: "task-1", title: "Evaluate Room evidence" },
    status: "scored",
    overallScore: 73,
    maxScore: 100,
    categoryScores: [],
    deterministicSignals: [{ signalId: "base-deterministic", kind: "workflow", name: "workflow", passed: true }],
    aiSignals: [{ signalId: "model-observation", kind: "model", name: "model observation", value: "advisory" }],
    followUps: [],
    ...overrides,
  };
}

function persistedResult(runId: string, input: EvalTaskResultCreateInput): EvalTaskResult {
  return {
    id: "ETR-1",
    runId,
    taskId: input.taskId,
    taskSnapshot: input.taskSnapshot,
    status: input.status,
    overallScore: input.overallScore,
    maxScore: input.maxScore,
    categoryScores: input.categoryScores ?? [],
    rationale: input.rationale,
    summary: input.summary,
    evidence: input.evidence ?? [],
    evidenceBundle: input.evidenceBundle,
    deterministicSignals: input.deterministicSignals ?? [],
    aiSignals: input.aiSignals,
    followUps: input.followUps ?? [],
    provenance: input.provenance,
    metadata: input.metadata,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

function createHarness(options: {
  readonly evaluation?: RoomEvalEvidenceSnapshotFixture;
  readonly run?: EvalRun | undefined;
  readonly authorityDecision?: { readonly allHardGatesPassed: boolean; readonly reason: string };
} = {}) {
  const evaluation = options.evaluation ?? snapshot();
  const collectTaskEvaluationEvidence = vi.fn(async () => collectorBundle());
  const createTaskResult = vi.fn(async (runId: string, input: EvalTaskResultCreateInput) => persistedResult(runId, input));
  const getRun = vi.fn(async () => options.run ?? evalRun());
  const evaluate = vi.fn(async () => options.authorityDecision ?? {
    allHardGatesPassed: true,
    reason: "immutable deterministic gates passed",
  });
  const adapter = new RoomEvalEvidenceAdapter({
    snapshotReader: {
      loadCandidateEvaluation: async () => evaluation,
    },
    evidenceCollector: { collectTaskEvaluationEvidence },
    evalStore: { getRun, createTaskResult },
    deterministicGateAuthority: { evaluate },
  });
  return {
    adapter,
    collectTaskEvaluationEvidence,
    createTaskResult,
    evaluate,
  };
}

function appendInput(evaluation: EvalTaskResultCreateInput = resultInput()) {
  return {
    scope: SCOPE,
    candidateId: "candidate-1",
    runId: "ER-1",
    collectorInput: {
      store: {} as TaskStore,
      task: task(),
      cwd: "G:\\codex-project\\fusion",
    },
    evaluation,
  };
}

describe("RoomEvalEvidenceAdapter", () => {
  it("projects bounded immutable Room references through the existing collector and EvalStore without changing scores", async () => {
    const harness = createHarness();

    const result = await harness.adapter.appendEvaluation(appendInput());

    expect(harness.collectTaskEvaluationEvidence).toHaveBeenCalledWith({
      store: expect.anything(),
      task: expect.objectContaining({ id: "task-1" }),
      runId: "ER-1",
      cwd: "G:\\codex-project\\fusion",
    });
    expect(harness.evaluate).toHaveBeenCalledTimes(1);
    expect(harness.createTaskResult).toHaveBeenCalledTimes(1);
    const [, persisted] = harness.createTaskResult.mock.calls[0] as [string, EvalTaskResultCreateInput];
    expect(persisted.overallScore).toBe(73);
    expect(persisted.categoryScores).toEqual([]);
    expect(persisted.deterministicSignals).toEqual(resultInput().deterministicSignals);
    expect(persisted.aiSignals).toEqual(resultInput().aiSignals);
    expect(persisted.evidenceBundle?.taskMetadata).toHaveLength(1);
    expect(persisted.evidenceBundle?.runAudit).toHaveLength(1);
    expect(persisted.evidenceBundle?.reviews).toHaveLength(1);
    expect(persisted.evidenceBundle?.workflow).toHaveLength(1);
    expect(persisted.evidence).toHaveLength(4);
    expect(persisted.evidence?.every((reference) => reference.ref.includes("sha256:"))).toBe(true);
    expect(result.referenceCount).toBe(4);
    expect(result.result.id).toBe("ETR-1");
  });

  it("does not persist a model-scored result when an immutable hard gate or its deterministic authority blocks it", async () => {
    const failedGate = snapshot({ gateResults: [gate({ status: "failed" })] });
    const harness = createHarness({ evaluation: failedGate });

    await expect(harness.adapter.appendEvaluation(appendInput(resultInput({ overallScore: 100 })))).rejects.toMatchObject({
      code: "hard_gate_blocked",
    } satisfies Partial<RoomEvalEvidenceAdapterError>);
    expect(harness.createTaskResult).not.toHaveBeenCalled();

    const denied = createHarness({
      authorityDecision: { allHardGatesPassed: false, reason: "deterministic policy denied candidate" },
    });
    await expect(denied.adapter.appendEvaluation(appendInput())).rejects.toMatchObject({
      code: "deterministic_authority_denied",
    } satisfies Partial<RoomEvalEvidenceAdapterError>);
    expect(denied.createTaskResult).not.toHaveBeenCalled();
  });

  it("rejects cross-project and cross-Room runs before collector or EvalStore persistence", async () => {
    const wrongProject = createHarness({ run: evalRun("project-other") });
    await expect(wrongProject.adapter.appendEvaluation(appendInput())).rejects.toMatchObject({
      code: "cross_project",
    } satisfies Partial<RoomEvalEvidenceAdapterError>);
    expect(wrongProject.collectTaskEvaluationEvidence).not.toHaveBeenCalled();

    const wrongRoom = createHarness({
      evaluation: snapshot({ scope: { projectId: SCOPE.projectId, roomId: "room-other" } as RoomEvidenceLedgerScope }),
    });
    await expect(wrongRoom.adapter.appendEvaluation(appendInput())).rejects.toMatchObject({
      code: "scope_mismatch",
    } satisfies Partial<RoomEvalEvidenceAdapterError>);
    expect(wrongRoom.collectTaskEvaluationEvidence).not.toHaveBeenCalled();
  });

  it("rejects missing hashes, producer self-review, and forged evidence references", async () => {
    const missingHash = createHarness({
      evaluation: snapshot({ candidate: candidate({ contentHash: "sha256:not-a-real-hash" }) }),
    });
    await expect(missingHash.adapter.appendEvaluation(appendInput())).rejects.toMatchObject({
      code: "missing_hash",
    } satisfies Partial<RoomEvalEvidenceAdapterError>);

    const selfReview = createHarness({
      evaluation: snapshot({ reviews: [review({ reviewerBindingId: "binding-producer" })] }),
    });
    await expect(selfReview.adapter.appendEvaluation(appendInput())).rejects.toMatchObject({
      code: "self_review_forbidden",
    } satisfies Partial<RoomEvalEvidenceAdapterError>);

    const forgedReference = createHarness({
      evaluation: snapshot({ gateResults: [gate({ evidenceIds: ["evidence-forged"] })] }),
    });
    await expect(forgedReference.adapter.appendEvaluation(appendInput())).rejects.toMatchObject({
      code: "forged_reference",
    } satisfies Partial<RoomEvalEvidenceAdapterError>);
  });

  it("fails closed when the immutable reference set exceeds the bounded Eval evidence budget", async () => {
    const extraEvidence = Array.from({ length: 25 }, (_, index) => evidence({
      id: `evidence-${index + 2}`,
      contentHash: `sha256:${String(index % 10).repeat(64)}`,
    }));
    const harness = createHarness({
      evaluation: snapshot({ evidence: [evidence(), ...extraEvidence] }),
    });
    await expect(harness.adapter.appendEvaluation(appendInput())).rejects.toMatchObject({
      code: "source_reference_limit",
    } satisfies Partial<RoomEvalEvidenceAdapterError>);
    expect(harness.createTaskResult).not.toHaveBeenCalled();
  });
});
