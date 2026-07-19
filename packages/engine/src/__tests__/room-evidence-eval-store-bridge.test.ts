import {
  hashRoomValue,
  type EvalRun,
  type EvalTaskResult,
  type RoomEvidenceLedgerScope,
  type TaskDetail,
  type TaskStore,
} from "@fusion/core";
import { describe, expect, it, vi } from "vitest";

import {
  RoomEvidenceEvalStoreBridge,
  RoomEvidenceEvalStoreBridgeError,
  type RoomEvidenceEvalStoreAuthorizedRecordV1,
  type RoomEvidenceEvalStoreBridgeInputV1,
} from "../room-evidence-eval-store-bridge.js";

const CREATED_AT = "2026-07-19T16:00:00.000Z";
const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const HASH_C = `sha256:${"c".repeat(64)}`;
const HASH_D = `sha256:${"d".repeat(64)}`;
const SCOPE = {
  projectId: "project-1",
  roomId: "room-1",
} as const satisfies RoomEvidenceLedgerScope;

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function evalRun(overrides: Partial<EvalRun> = {}): EvalRun {
  return {
    id: "ER-1",
    projectId: SCOPE.projectId,
    status: "completed",
    trigger: "manual",
    scope: "project",
    window: {},
    requestedTaskIds: ["task-1"],
    evaluatedTaskIds: ["task-1"],
    counts: { totalTasks: 1, scoredTasks: 1, skippedTasks: 0, erroredTasks: 0 },
    provenance: {
      evaluatorProvider: "codex",
      evaluatorModelId: "gpt-5.6",
      evaluatorVersion: "v1",
    },
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    completedAt: CREATED_AT,
    ...overrides,
  };
}

function evalResult(overrides: Partial<EvalTaskResult> = {}): EvalTaskResult {
  return {
    id: "ETR-1",
    runId: "ER-1",
    taskId: "task-1",
    taskSnapshot: { taskId: "task-1", title: "Room evidence bridge" },
    status: "scored",
    overallScore: 83,
    maxScore: 100,
    categoryScores: [],
    evidence: [{
      type: "test",
      ref: "eval-receipt:unit-1",
      metadata: { contentHash: HASH_B },
    }],
    deterministicSignals: [{
      signalId: "deterministic-1",
      kind: "test",
      name: "unit",
      passed: true,
    }],
    aiSignals: [{
      signalId: "advisory-1",
      kind: "model",
      name: "advisory",
      value: "independent evaluator observation",
    }],
    followUps: [],
    provenance: {
      evaluatorProvider: "codex",
      evaluatorModelId: "gpt-5.6",
      evaluatorVersion: "v1",
    },
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function evaluationContentHash(input: {
  readonly authorizationRef: string;
  readonly authorizationHash: string;
  readonly sourceReceipt: { readonly id: string; readonly contentHash: string; readonly issuedAt: string };
  readonly evaluatorBindingId: string;
  readonly run: EvalRun;
  readonly result: EvalTaskResult;
}): string {
  return hashRoomValue({
    contractVersion: 1,
    immutable: true,
    authorizationRef: input.authorizationRef,
    authorizationHash: input.authorizationHash,
    sourceReceipt: input.sourceReceipt,
    evaluatorBindingId: input.evaluatorBindingId,
    run: input.run,
    result: input.result,
  });
}

function record(
  overrides: Partial<Omit<RoomEvidenceEvalStoreAuthorizedRecordV1, "evaluationContentHash">> = {},
  freeze = true,
): RoomEvidenceEvalStoreAuthorizedRecordV1 {
  const value = {
    contractVersion: 1 as const,
    immutable: true as const,
    authorizationRef: "authorization-1",
    authorizationHash: HASH_C,
    sourceReceipt: {
      id: "receipt-1",
      contentHash: HASH_D,
      issuedAt: CREATED_AT,
    },
    evaluatorBindingId: "binding-evaluator",
    run: evalRun(),
    result: evalResult(),
    ...overrides,
  };
  const withHash = {
    ...value,
    evaluationContentHash: evaluationContentHash(value),
  } as RoomEvidenceEvalStoreAuthorizedRecordV1;
  return freeze ? deepFreeze(withHash) : withHash;
}

function input(
  source: RoomEvidenceEvalStoreAuthorizedRecordV1 = record(),
): RoomEvidenceEvalStoreBridgeInputV1 {
  return {
    scope: SCOPE,
    candidate: {
      id: "candidate-1",
      roomId: SCOPE.roomId,
      contentHash: HASH_A,
      producingBindingId: "binding-producer",
    },
    record: source,
    collectorInput: {
      store: {} as TaskStore,
      task: { id: "task-1" } as TaskDetail,
      cwd: "G:\\codex-project\\fusion",
    },
  };
}

function createHarness(options: {
  readonly verification?: (value: Parameters<NonNullable<ConstructorParameters<typeof RoomEvidenceEvalStoreBridge>[0]["authorizationVerifier"]>["verify"]>[0]) => unknown;
} = {}) {
  const claimedReceipts = new Set<string>();
  const verify = vi.fn(async (value: Parameters<NonNullable<ConstructorParameters<typeof RoomEvidenceEvalStoreBridge>[0]["authorizationVerifier"]>["verify"]>[0]) => options.verification?.(value) ?? ({
    status: "authorized" as const,
    authorizationRef: value.record.authorizationRef,
    authorizationHash: value.record.authorizationHash,
    scope: value.scope,
    candidateId: value.candidate.id,
    candidateContentHash: value.candidate.contentHash,
    evaluatorBindingId: value.record.evaluatorBindingId,
    sourceReceiptId: value.record.sourceReceipt.id,
    sourceReceiptHash: value.record.sourceReceipt.contentHash,
    evaluationContentHash: value.record.evaluationContentHash,
  }));
  const claim = vi.fn(async (value: Parameters<NonNullable<ConstructorParameters<typeof RoomEvidenceEvalStoreBridge>[0]["receiptLedger"]>["claim"]>[0]) => {
    const key = [value.scope.projectId, value.scope.roomId, value.candidateId, value.sourceReceiptId, value.sourceReceiptHash].join(":");
    const status = claimedReceipts.has(key) ? "duplicate" as const : "claimed" as const;
    claimedReceipts.add(key);
    return {
      status,
      scope: value.scope,
      candidateId: value.candidateId,
      sourceReceiptId: value.sourceReceiptId,
      sourceReceiptHash: value.sourceReceiptHash,
      evaluationContentHash: value.evaluationContentHash,
    };
  });
  return {
    bridge: new RoomEvidenceEvalStoreBridge({
      authorizationVerifier: { verify },
      receiptLedger: { claim },
    }),
    verify,
    claim,
  };
}

describe("RoomEvidenceEvalStoreBridge", () => {
  it("turns one authorized immutable EvalStore result into a bounded Room evidence workflow input without changing scoring", async () => {
    const harness = createHarness();

    const result = await harness.bridge.prepare(input());

    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("Expected the first immutable receipt to be ready.");
    expect(result.workflowInput.scope).toEqual(SCOPE);
    expect(result.workflowInput.candidateId).toBe("candidate-1");
    expect(result.workflowInput.runId).toBe("ER-1");
    expect(result.workflowInput.evaluation.overallScore).toBe(83);
    expect(result.workflowInput.evaluation.deterministicSignals).toEqual(evalResult().deterministicSignals);
    expect(result.workflowInput.evaluation.evidenceBundle).toBeUndefined();
    expect(result.workflowInput.evaluation.metadata).toMatchObject({
      roomEvidenceEvalStoreBridge: {
        contractVersion: 1,
        authorizationRef: "authorization-1",
        sourceReceiptId: "receipt-1",
        sourceReceiptHash: HASH_D,
        evaluationContentHash: result.evaluationContentHash,
        candidateContentHash: HASH_A,
        evaluatorBindingId: "binding-evaluator",
      },
    });
    expect(Object.isFrozen(result.workflowInput)).toBe(true);
    expect(Object.isFrozen(result.workflowInput.evaluation)).toBe(true);
    expect(harness.verify).toHaveBeenCalledTimes(1);
    expect(harness.claim).toHaveBeenCalledTimes(1);
  });

  it("rejects self-evaluation and cross-scope EvalStore records before claiming a receipt", async () => {
    const self = record({ evaluatorBindingId: "binding-producer" });
    const selfHarness = createHarness();
    await expect(selfHarness.bridge.prepare(input(self))).rejects.toMatchObject({
      code: "self_evaluation_forbidden",
    } satisfies Partial<RoomEvidenceEvalStoreBridgeError>);
    expect(selfHarness.verify).not.toHaveBeenCalled();
    expect(selfHarness.claim).not.toHaveBeenCalled();

    const wrongProject = record({ run: evalRun({ projectId: "project-other" }) });
    const projectHarness = createHarness();
    await expect(projectHarness.bridge.prepare(input(wrongProject))).rejects.toMatchObject({
      code: "cross_scope",
    } satisfies Partial<RoomEvidenceEvalStoreBridgeError>);
    expect(projectHarness.verify).not.toHaveBeenCalled();
    expect(projectHarness.claim).not.toHaveBeenCalled();
  });

  it("rejects mutable or hash-tampered EvalStore payloads before authorization", async () => {
    const mutableHarness = createHarness();
    await expect(mutableHarness.bridge.prepare(input(record({}, false)))).rejects.toMatchObject({
      code: "mutable_payload",
    } satisfies Partial<RoomEvidenceEvalStoreBridgeError>);
    expect(mutableHarness.verify).not.toHaveBeenCalled();

    const baseline = record();
    const tampered = deepFreeze({
      ...baseline,
      result: deepFreeze({ ...baseline.result, summary: "tampered after receipt" }),
    }) as RoomEvidenceEvalStoreAuthorizedRecordV1;
    const tamperedHarness = createHarness();
    await expect(tamperedHarness.bridge.prepare(input(tampered))).rejects.toMatchObject({
      code: "content_hash_mismatch",
    } satisfies Partial<RoomEvidenceEvalStoreBridgeError>);
    expect(tamperedHarness.verify).not.toHaveBeenCalled();

    const unsupportedArrayEntry = deepFreeze({
      ...baseline,
      result: deepFreeze({
        ...baseline.result,
        evidence: deepFreeze([undefined]) as unknown as EvalTaskResult["evidence"],
      }),
    }) as RoomEvidenceEvalStoreAuthorizedRecordV1;
    const unsupportedHarness = createHarness();
    await expect(unsupportedHarness.bridge.prepare(input(unsupportedArrayEntry))).rejects.toMatchObject({
      code: "mutable_payload",
    } satisfies Partial<RoomEvidenceEvalStoreBridgeError>);
    expect(unsupportedHarness.verify).not.toHaveBeenCalled();
  });

  it("deduplicates a source receipt so only its first accepted evaluation can enter the Room workflow", async () => {
    const harness = createHarness();
    const first = await harness.bridge.prepare(input());
    const second = await harness.bridge.prepare(input());

    expect(first.status).toBe("ready");
    expect(second).toMatchObject({
      status: "duplicate",
      sourceReceiptId: "receipt-1",
      sourceReceiptHash: HASH_D,
    });
    expect(harness.claim).toHaveBeenCalledTimes(2);
  });

  it("rejects a verifier acknowledgement that does not bind the exact independent evaluator and receipt", async () => {
    const harness = createHarness({
      verification: (value) => ({
        status: "authorized" as const,
        authorizationRef: value.record.authorizationRef,
        authorizationHash: value.record.authorizationHash,
        scope: value.scope,
        candidateId: value.candidate.id,
        candidateContentHash: value.candidate.contentHash,
        evaluatorBindingId: "binding-forged",
        sourceReceiptId: value.record.sourceReceipt.id,
        sourceReceiptHash: value.record.sourceReceipt.contentHash,
        evaluationContentHash: value.record.evaluationContentHash,
      }),
    });

    await expect(harness.bridge.prepare(input())).rejects.toMatchObject({
      code: "authorization_mismatch",
    } satisfies Partial<RoomEvidenceEvalStoreBridgeError>);
    expect(harness.claim).not.toHaveBeenCalled();
  });

  it("rejects unbounded or Room-prefixed advisory references instead of letting mutable Eval payloads masquerade as Room evidence", async () => {
    const tooMany = record({
      result: evalResult({
        evidence: Array.from({ length: 25 }, (_, index) => ({
          type: "test" as const,
          ref: `eval-receipt:${index + 1}`,
        })),
      }),
    });
    await expect(createHarness().bridge.prepare(input(tooMany))).rejects.toMatchObject({
      code: "source_reference_limit",
    } satisfies Partial<RoomEvidenceEvalStoreBridgeError>);

    const forgedRoomReference = record({
      result: evalResult({ evidence: [{ type: "other", ref: "room-evidence:forged" }] }),
    });
    await expect(createHarness().bridge.prepare(input(forgedRoomReference))).rejects.toMatchObject({
      code: "untrusted_reference",
    } satisfies Partial<RoomEvidenceEvalStoreBridgeError>);
  });
});
