import {
  EVIDENCE_LIMITS,
  TASK_EVALUATION_EVIDENCE_SOURCE_ORDER,
  type EvalEvidenceReference,
  type EvalRun,
  type EvalTaskResult,
  type EvalTaskResultCreateInput,
  type RoomCandidateRecordV1,
  type RoomEvidenceLedgerScope,
  type RoomEvidenceRecordV1,
  type RoomGateResultV1,
  type RoomReviewRecordV1,
  type TaskDetail,
  type TaskEvaluationEvidenceBundle,
  type TaskStore,
} from "@fusion/core";

export const ROOM_EVAL_EVIDENCE_ADAPTER_CONTRACT_VERSION = 1 as const;
export const ROOM_EVAL_EVIDENCE_REFERENCE_LIMIT = 24 as const;

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const GATE_STATUSES = new Set<RoomGateResultV1["status"]>(["passed", "failed", "error", "not_run"]);
const EVAL_REFERENCE_TYPES = new Set<EvalEvidenceReference["type"]>([
  "task_log",
  "task_document",
  "file",
  "command",
  "test",
  "other",
]);

export type RoomEvalEvidenceAdapterErrorCodeV1 =
  | "invalid_input"
  | "eval_run_not_found"
  | "cross_project"
  | "missing_snapshot"
  | "scope_mismatch"
  | "missing_hash"
  | "self_review_forbidden"
  | "forged_reference"
  | "hard_gate_blocked"
  | "deterministic_authority_denied"
  | "source_reference_limit"
  | "collector_result_invalid"
  | "prebound_evidence_forbidden"
  | "eval_store_result_mismatch";

export class RoomEvalEvidenceAdapterError extends Error {
  public constructor(
    public readonly code: RoomEvalEvidenceAdapterErrorCodeV1,
    message: string,
  ) {
    super(message);
    this.name = "RoomEvalEvidenceAdapterError";
  }
}

export interface RoomEvalImmutableCandidateSnapshotV1 {
  readonly scope: RoomEvidenceLedgerScope;
  readonly candidate: RoomCandidateRecordV1;
  readonly evidence: readonly RoomEvidenceRecordV1[];
  readonly reviews: readonly RoomReviewRecordV1[];
  readonly gateResults: readonly RoomGateResultV1[];
}

export interface RoomEvalEvidenceSnapshotReaderPortV1 {
  loadCandidateEvaluation(input: {
    readonly scope: RoomEvidenceLedgerScope;
    readonly candidateId: string;
  }): Promise<RoomEvalImmutableCandidateSnapshotV1 | null>;
}

export interface RoomEvalTaskEvidenceCollectorInputV1 {
  readonly store: TaskStore;
  readonly task: TaskDetail;
  readonly runId: string;
  readonly cwd: string;
}

export interface RoomEvalEvidenceCollectorPortV1 {
  collectTaskEvaluationEvidence(
    input: RoomEvalTaskEvidenceCollectorInputV1,
  ): Promise<TaskEvaluationEvidenceBundle>;
}

export interface RoomEvalStorePortV1 {
  getRun(runId: string): EvalRun | undefined | Promise<EvalRun | undefined>;
  createTaskResult(
    runId: string,
    input: EvalTaskResultCreateInput,
  ): EvalTaskResult | Promise<EvalTaskResult>;
}

export interface RoomEvalDeterministicGateAuthorityDecisionV1 {
  readonly allHardGatesPassed: boolean;
  readonly reason: string;
}

export interface RoomEvalDeterministicGateAuthorityPortV1 {
  evaluate(input: {
    readonly scope: RoomEvidenceLedgerScope;
    readonly candidate: RoomCandidateRecordV1;
    readonly evidence: readonly RoomEvidenceRecordV1[];
    readonly gateResults: readonly RoomGateResultV1[];
  }): RoomEvalDeterministicGateAuthorityDecisionV1 | Promise<RoomEvalDeterministicGateAuthorityDecisionV1>;
}

export interface RoomEvalEvidenceAdapterDependenciesV1 {
  readonly snapshotReader: RoomEvalEvidenceSnapshotReaderPortV1;
  readonly evidenceCollector: RoomEvalEvidenceCollectorPortV1;
  readonly evalStore: RoomEvalStorePortV1;
  readonly deterministicGateAuthority: RoomEvalDeterministicGateAuthorityPortV1;
}

export interface AppendRoomEvalEvidenceInputV1 {
  readonly scope: RoomEvidenceLedgerScope;
  readonly candidateId: string;
  readonly runId: string;
  readonly collectorInput: Omit<RoomEvalTaskEvidenceCollectorInputV1, "runId">;
  readonly evaluation: EvalTaskResultCreateInput;
}

export interface RoomEvalEvidenceAppendResultV1 {
  readonly result: EvalTaskResult;
  readonly referenceCount: number;
  readonly hardGateResultIds: readonly string[];
}

interface ValidatedRoomEvalSnapshotV1 {
  readonly scope: RoomEvidenceLedgerScope;
  readonly candidate: RoomCandidateRecordV1;
  readonly evidence: readonly RoomEvidenceRecordV1[];
  readonly reviews: readonly RoomReviewRecordV1[];
  readonly gateResults: readonly RoomGateResultV1[];
  readonly hardGateResultIds: readonly string[];
}

interface RoomEvalReferenceProjectionV1 {
  readonly references: readonly EvalEvidenceReference[];
  readonly candidateReference: EvalEvidenceReference;
  readonly evidenceReferences: readonly EvalEvidenceReference[];
  readonly reviewReferences: readonly EvalEvidenceReference[];
  readonly gateReferences: readonly EvalEvidenceReference[];
}

export class RoomEvalEvidenceAdapter {
  public constructor(
    private readonly dependencies: RoomEvalEvidenceAdapterDependenciesV1,
  ) {}

  public async appendEvaluation(
    input: AppendRoomEvalEvidenceInputV1,
  ): Promise<RoomEvalEvidenceAppendResultV1> {
    const normalized = normalizeInput(input);
    const evalStore = requireEvalStore(this.dependencies?.evalStore);
    const run = await evalStore.getRun(normalized.runId);
    if (!run) {
      throw new RoomEvalEvidenceAdapterError(
        "eval_run_not_found",
        `Eval run ${normalized.runId} was not found before Room evidence projection.`,
      );
    }
    if (run.projectId !== normalized.scope.projectId) {
      throw new RoomEvalEvidenceAdapterError(
        "cross_project",
        `Eval run ${normalized.runId} belongs to project ${run.projectId}, not Room project ${normalized.scope.projectId}.`,
      );
    }

    const snapshotReader = requireSnapshotReader(this.dependencies?.snapshotReader);
    const snapshot = await snapshotReader.loadCandidateEvaluation({
      scope: normalized.scope,
      candidateId: normalized.candidateId,
    });
    if (!snapshot) {
      throw new RoomEvalEvidenceAdapterError(
        "missing_snapshot",
        `No immutable Room evidence snapshot was available for candidate ${normalized.candidateId}.`,
      );
    }
    const validated = validateSnapshot(normalized.scope, normalized.candidateId, snapshot);
    assertNoBlockedHardGate(validated);

    const authority = requireDeterministicAuthority(this.dependencies?.deterministicGateAuthority);
    const authorityDecision = await authority.evaluate({
      scope: validated.scope,
      candidate: validated.candidate,
      evidence: validated.evidence,
      gateResults: validated.gateResults,
    });
    if (!isAuthorityDecision(authorityDecision) || !authorityDecision.allHardGatesPassed) {
      throw new RoomEvalEvidenceAdapterError(
        "deterministic_authority_denied",
        "The deterministic Room gate authority did not authorize this candidate for Eval persistence.",
      );
    }

    const collector = requireEvidenceCollector(this.dependencies?.evidenceCollector);
    const baseline = await collector.collectTaskEvaluationEvidence({
      ...normalized.collectorInput,
      runId: normalized.runId,
    });
    const projection = projectRoomReferences(validated);
    const advisoryReferences = normalizeAdvisoryReferences(normalized.evaluation.evidence);
    if (projection.references.length + advisoryReferences.length > ROOM_EVAL_EVIDENCE_REFERENCE_LIMIT) {
      throw new RoomEvalEvidenceAdapterError(
        "source_reference_limit",
        `Room Eval evidence must retain at most ${ROOM_EVAL_EVIDENCE_REFERENCE_LIMIT} bounded references.`,
      );
    }
    const evidenceBundle = mergeEvidenceBundle(
      baseline,
      normalized.evaluation.taskId,
      normalized.runId,
      projection,
    );
    const evaluation = buildEvalStoreInput(
      normalized.evaluation,
      validated,
      authorityDecision,
      evidenceBundle,
      [...projection.references, ...advisoryReferences],
    );
    const result = await evalStore.createTaskResult(normalized.runId, evaluation);
    assertPersistedResult(result, normalized.runId, normalized.evaluation.taskId, projection.references);

    return freeze({
      result,
      referenceCount: projection.references.length,
      hardGateResultIds: validated.hardGateResultIds,
    });
  }
}

function normalizeInput(input: AppendRoomEvalEvidenceInputV1): {
  readonly scope: RoomEvidenceLedgerScope;
  readonly candidateId: string;
  readonly runId: string;
  readonly collectorInput: Omit<RoomEvalTaskEvidenceCollectorInputV1, "runId">;
  readonly evaluation: EvalTaskResultCreateInput;
} {
  if (!isRecord(input)) {
    throw new RoomEvalEvidenceAdapterError("invalid_input", "Room Eval evidence append input must be a record.");
  }
  const scope = normalizeScope(input.scope);
  assertReference(input.candidateId, "candidate ID");
  assertReference(input.runId, "Eval run ID");
  if (!isRecord(input.collectorInput) || !isTaskCollectorInput(input.collectorInput)) {
    throw new RoomEvalEvidenceAdapterError("invalid_input", "Room Eval evidence requires a complete existing collector input.");
  }
  if (!isEvalInput(input.evaluation)) {
    throw new RoomEvalEvidenceAdapterError("invalid_input", "Room Eval evidence requires an EvalStore task-result input.");
  }
  if (input.evaluation.taskId !== input.collectorInput.task.id || input.evaluation.taskSnapshot.taskId !== input.evaluation.taskId) {
    throw new RoomEvalEvidenceAdapterError(
      "invalid_input",
      "Eval task identity must match the existing evidence collector task identity.",
    );
  }
  if (input.evaluation.evidenceBundle !== undefined) {
    throw new RoomEvalEvidenceAdapterError(
      "prebound_evidence_forbidden",
      "Room Eval evidence must be merged from the injected collector, not caller-supplied evidenceBundle data.",
    );
  }
  return freeze({
    scope,
    candidateId: input.candidateId,
    runId: input.runId,
    collectorInput: freeze({
      store: input.collectorInput.store,
      task: input.collectorInput.task,
      cwd: input.collectorInput.cwd,
    }),
    evaluation: input.evaluation,
  });
}

function validateSnapshot(
  scope: RoomEvidenceLedgerScope,
  candidateId: string,
  snapshot: RoomEvalImmutableCandidateSnapshotV1,
): ValidatedRoomEvalSnapshotV1 {
  if (!isRecord(snapshot) || !isRecord(snapshot.scope) || !sameScope(scope, snapshot.scope)) {
    throw new RoomEvalEvidenceAdapterError("scope_mismatch", "Immutable Room evidence snapshot scope does not match the requested scope.");
  }
  const candidate = snapshot.candidate;
  if (!isCandidate(candidate) || candidate.id !== candidateId || candidate.roomId !== scope.roomId) {
    throw new RoomEvalEvidenceAdapterError("forged_reference", "Immutable candidate does not match the requested Room candidate identity.");
  }
  assertHash(candidate.contentHash, `candidate ${candidate.id} content hash`);
  const evidence = normalizeEvidence(snapshot.evidence, scope, candidate.id);
  const evidenceIds = new Set(evidence.map((entry) => entry.id));
  const reviews = normalizeReviews(snapshot.reviews, scope, candidate, evidenceIds);
  const gateResults = normalizeGateResults(snapshot.gateResults, scope, candidate.id, evidenceIds);
  const hardGateResultIds = gateResults.filter((entry) => entry.hard).map((entry) => entry.id).sort(compareText);
  return freeze({
    scope: freeze({ projectId: scope.projectId, roomId: scope.roomId }),
    candidate,
    evidence,
    reviews,
    gateResults,
    hardGateResultIds,
  });
}

function normalizeEvidence(
  values: unknown,
  scope: RoomEvidenceLedgerScope,
  candidateId: string,
): readonly RoomEvidenceRecordV1[] {
  if (!Array.isArray(values)) {
    throw new RoomEvalEvidenceAdapterError("invalid_input", "Immutable Room evidence snapshot must contain an evidence array.");
  }
  const ids = new Set<string>();
  const entries = values.map((value) => {
    if (!isEvidence(value) || value.roomId !== scope.roomId || (value.candidateId !== null && value.candidateId !== candidateId)) {
      throw new RoomEvalEvidenceAdapterError("forged_reference", "Room evidence does not belong to the requested Room candidate.");
    }
    assertUniqueId(ids, value.id, "Room evidence");
    assertHash(value.contentHash, `evidence ${value.id} content hash`);
    if (!value.authoritativeSourceRetained || !isNonBlank(value.authoritativeSourceUri) || !isNonBlank(value.sourceVersionOrHash) || !isNonBlank(value.collectionMethod)) {
      throw new RoomEvalEvidenceAdapterError("forged_reference", `Room evidence ${value.id} lacks an authoritative retained source reference.`);
    }
    return value;
  });
  return freeze(entries.sort((left, right) => compareText(left.id, right.id)));
}

function normalizeReviews(
  values: unknown,
  scope: RoomEvidenceLedgerScope,
  candidate: RoomCandidateRecordV1,
  evidenceIds: ReadonlySet<string>,
): readonly RoomReviewRecordV1[] {
  if (!Array.isArray(values)) {
    throw new RoomEvalEvidenceAdapterError("invalid_input", "Immutable Room evidence snapshot must contain a review array.");
  }
  const ids = new Set<string>();
  const entries = values.map((value) => {
    if (!isReview(value) || value.roomId !== scope.roomId || value.candidateId !== candidate.id) {
      throw new RoomEvalEvidenceAdapterError("forged_reference", "Room review does not belong to the requested Room candidate.");
    }
    assertUniqueId(ids, value.id, "Room review");
    assertHash(value.reviewContentHash, `review ${value.id} content hash`);
    if (!value.independentFromProducer || value.reviewerBindingId === candidate.producingBindingId) {
      throw new RoomEvalEvidenceAdapterError("self_review_forbidden", `Room review ${value.id} is not independent from its producer.`);
    }
    assertEvidenceReferences(value.evidenceIds, evidenceIds, `review ${value.id}`);
    return value;
  });
  return freeze(entries.sort((left, right) => compareText(left.id, right.id)));
}

function normalizeGateResults(
  values: unknown,
  scope: RoomEvidenceLedgerScope,
  candidateId: string,
  evidenceIds: ReadonlySet<string>,
): readonly RoomGateResultV1[] {
  if (!Array.isArray(values)) {
    throw new RoomEvalEvidenceAdapterError("invalid_input", "Immutable Room evidence snapshot must contain a gate-result array.");
  }
  const ids = new Set<string>();
  const entries = values.map((value) => {
    if (!isGateResult(value) || value.roomId !== scope.roomId || value.candidateId !== candidateId) {
      throw new RoomEvalEvidenceAdapterError("forged_reference", "Room gate result does not belong to the requested Room candidate.");
    }
    assertUniqueId(ids, value.id, "Room gate result");
    if (!GATE_STATUSES.has(value.status) || !Array.isArray(value.evidenceIds) || value.evidenceIds.length === 0) {
      throw new RoomEvalEvidenceAdapterError("forged_reference", `Room gate ${value.id} lacks immutable evidence references.`);
    }
    assertEvidenceReferences(value.evidenceIds, evidenceIds, `gate ${value.id}`);
    return value;
  });
  return freeze(entries.sort((left, right) => compareText(left.id, right.id)));
}

function assertNoBlockedHardGate(snapshot: ValidatedRoomEvalSnapshotV1): void {
  const blocked = snapshot.gateResults.find((entry) => entry.hard && entry.status !== "passed");
  if (blocked) {
    throw new RoomEvalEvidenceAdapterError(
      "hard_gate_blocked",
      `Hard Room gate ${blocked.id} is ${blocked.status}; model scoring cannot persist this candidate as accepted evidence.`,
    );
  }
}

function projectRoomReferences(snapshot: ValidatedRoomEvalSnapshotV1): RoomEvalReferenceProjectionV1 {
  const candidateReference = freeze({
    type: "other" as const,
    ref: `room-candidate:${snapshot.candidate.id}:${snapshot.candidate.contentHash}`,
    metadata: freeze({
      recordType: "room_candidate",
      roomId: snapshot.scope.roomId,
      candidateId: snapshot.candidate.id,
      contentHash: snapshot.candidate.contentHash,
      protocolId: snapshot.candidate.protocolId,
      protocolVersion: snapshot.candidate.protocolVersion,
      createdAt: snapshot.candidate.createdAt,
    }),
  });
  const evidenceReferences = snapshot.evidence.map((entry) => freeze({
    type: entry.kind === "test" ? "test" as const : entry.kind === "runtime" ? "command" as const : "other" as const,
    ref: `room-evidence:${entry.id}:${entry.contentHash}`,
    metadata: freeze({
      recordType: "room_evidence",
      roomId: snapshot.scope.roomId,
      candidateId: snapshot.candidate.id,
      contentHash: entry.contentHash,
      authoritativeSourceUri: entry.authoritativeSourceUri,
      sourceVersionOrHash: entry.sourceVersionOrHash,
      collectionMethod: entry.collectionMethod,
      capturedAt: entry.capturedAt,
    }),
  }));
  const reviewReferences = snapshot.reviews.map((entry) => freeze({
    type: "other" as const,
    ref: `room-review:${entry.id}:${entry.reviewContentHash}`,
    metadata: freeze({
      recordType: "room_review",
      roomId: snapshot.scope.roomId,
      candidateId: snapshot.candidate.id,
      contentHash: entry.reviewContentHash,
      blind: entry.blind,
      independentFromProducer: entry.independentFromProducer,
      verdict: entry.verdict,
      rubricVersion: entry.rubricVersion,
      committedAt: entry.committedAt,
    }),
  }));
  const hashesByEvidenceId = new Map(snapshot.evidence.map((entry) => [entry.id, entry.contentHash] as const));
  const gateReferences = snapshot.gateResults.map((entry) => {
    const hashes = entry.evidenceIds.map((id) => hashesByEvidenceId.get(id) as string).sort(compareText);
    return freeze({
      type: entry.kind === "test" ? "test" as const : entry.command ? "command" as const : "other" as const,
      ref: `room-gate:${entry.id}:${hashes.join(",")}`,
      metadata: freeze({
        recordType: "room_gate_result",
        roomId: snapshot.scope.roomId,
        candidateId: snapshot.candidate.id,
        evidenceHashes: freeze(hashes),
        profileId: entry.profileId,
        kind: entry.kind,
        hard: entry.hard,
        status: entry.status,
        recordedAt: entry.recordedAt,
      }),
    });
  });
  const references = freeze([candidateReference, ...evidenceReferences, ...reviewReferences, ...gateReferences]);
  if (references.length > ROOM_EVAL_EVIDENCE_REFERENCE_LIMIT) {
    throw new RoomEvalEvidenceAdapterError(
      "source_reference_limit",
      `Immutable Room projection contains ${references.length} references; limit is ${ROOM_EVAL_EVIDENCE_REFERENCE_LIMIT}.`,
    );
  }
  return freeze({
    references,
    candidateReference,
    evidenceReferences: freeze(evidenceReferences),
    reviewReferences: freeze(reviewReferences),
    gateReferences: freeze(gateReferences),
  });
}

function mergeEvidenceBundle(
  baseline: TaskEvaluationEvidenceBundle,
  taskId: string,
  runId: string,
  projection: RoomEvalReferenceProjectionV1,
): TaskEvaluationEvidenceBundle {
  assertCollectorBundle(baseline, taskId, runId);
  const candidate = projection.candidateReference;
  const taskMetadata = appendWithinLimit(
    baseline.taskMetadata,
    [{
      id: `room-candidate:${candidate.ref}`,
      source: "taskMetadata" as const,
      label: "immutable Room candidate",
      taskId,
      runId,
      summary: candidate.ref,
    }],
    EVIDENCE_LIMITS.taskMetadata,
    "taskMetadata",
  );
  const runAudit = appendWithinLimit(
    baseline.runAudit,
    projection.evidenceReferences.map((reference) => ({
      id: `room-evidence:${reference.ref}`,
      source: "runAudit" as const,
      label: "immutable Room evidence",
      taskId,
      runId,
      timestamp: readTimestamp(reference.metadata, "capturedAt"),
      eventId: reference.ref,
      domain: "room",
      mutationType: "immutable_evidence_reference",
      target: reference.ref,
      excerpt: reference.ref,
      truncated: false,
    })),
    EVIDENCE_LIMITS.runAudit,
    "runAudit",
  );
  const reviews = appendWithinLimit(
    baseline.reviews,
    projection.reviewReferences.map((reference, index) => ({
      id: `room-review:${reference.ref}`,
      source: "reviews" as const,
      label: "immutable independent Room review",
      taskId,
      runId,
      timestamp: readTimestamp(reference.metadata, "committedAt"),
      reviewStep: index + 1,
      reviewType: "room_independent",
      verdict: readString(reference.metadata, "verdict"),
      excerpt: reference.ref,
      truncated: false,
    })),
    EVIDENCE_LIMITS.reviews,
    "reviews",
  );
  const workflow = appendWithinLimit(
    baseline.workflow,
    projection.gateReferences.map((reference) => ({
      id: `room-gate:${reference.ref}`,
      source: "workflow" as const,
      label: "immutable deterministic Room gate",
      taskId,
      runId,
      timestamp: readTimestamp(reference.metadata, "recordedAt"),
      workflowStepId: reference.ref,
      stepName: readString(reference.metadata, "profileId"),
      status: readString(reference.metadata, "status"),
      excerpt: reference.ref,
      truncated: false,
    })),
    EVIDENCE_LIMITS.workflow,
    "workflow",
  );
  return {
    taskId,
    runId,
    sourceOrder: TASK_EVALUATION_EVIDENCE_SOURCE_ORDER,
    taskMetadata: sortEntries(taskMetadata),
    commits: sortEntries([...baseline.commits]),
    workflow: sortEntries(workflow),
    reviews: sortEntries(reviews),
    documents: sortEntries([...baseline.documents]),
    taskActivity: sortEntries([...baseline.taskActivity]),
    agentLogs: sortEntries([...baseline.agentLogs]),
    runAudit: sortEntries(runAudit),
  };
}

function buildEvalStoreInput(
  evaluation: EvalTaskResultCreateInput,
  snapshot: ValidatedRoomEvalSnapshotV1,
  authorityDecision: RoomEvalDeterministicGateAuthorityDecisionV1,
  evidenceBundle: TaskEvaluationEvidenceBundle,
  references: readonly EvalEvidenceReference[],
): EvalTaskResultCreateInput {
  return {
    ...evaluation,
    evidence: [...references],
    evidenceBundle,
    metadata: {
      ...(evaluation.metadata ?? {}),
      roomEvidenceAdapter: {
        contractVersion: ROOM_EVAL_EVIDENCE_ADAPTER_CONTRACT_VERSION,
        projectId: snapshot.scope.projectId,
        roomId: snapshot.scope.roomId,
        candidateId: snapshot.candidate.id,
        immutableReferenceCount: references.length,
        immutableReferenceIds: references.map((reference) => reference.ref),
        hardGateResultIds: snapshot.hardGateResultIds,
        deterministicAuthority: "room_gate_authority",
        deterministicAuthorityReason: authorityDecision.reason,
      },
    },
  };
}

function normalizeAdvisoryReferences(values: readonly EvalEvidenceReference[] | undefined): readonly EvalEvidenceReference[] {
  if (values === undefined) return freeze([]);
  if (!Array.isArray(values)) {
    throw new RoomEvalEvidenceAdapterError("invalid_input", "Eval task result evidence must be an array when supplied.");
  }
  const references = values.map((value) => {
    if (!isEvalReference(value) || value.ref.toLowerCase().startsWith("room-")) {
      throw new RoomEvalEvidenceAdapterError(
        "forged_reference",
        "Caller-supplied Eval evidence cannot masquerade as an immutable Room reference.",
      );
    }
    return { ...value, metadata: value.metadata ? { ...value.metadata } : undefined };
  });
  return freeze(references);
}

function assertCollectorBundle(bundle: TaskEvaluationEvidenceBundle, taskId: string, runId: string): void {
  if (!isRecord(bundle) || bundle.taskId !== taskId || bundle.runId !== runId || !Array.isArray(bundle.sourceOrder)
    || bundle.sourceOrder.join("|") !== TASK_EVALUATION_EVIDENCE_SOURCE_ORDER.join("|")) {
    throw new RoomEvalEvidenceAdapterError("collector_result_invalid", "Existing evidence collector returned an incompatible Eval evidence bundle.");
  }
  const groups: Array<[keyof Pick<TaskEvaluationEvidenceBundle, "taskMetadata" | "commits" | "workflow" | "reviews" | "documents" | "taskActivity" | "agentLogs" | "runAudit">, number]> = [
    ["taskMetadata", EVIDENCE_LIMITS.taskMetadata],
    ["commits", EVIDENCE_LIMITS.commits],
    ["workflow", EVIDENCE_LIMITS.workflow],
    ["reviews", EVIDENCE_LIMITS.reviews],
    ["documents", EVIDENCE_LIMITS.documents],
    ["taskActivity", EVIDENCE_LIMITS.taskActivity],
    ["agentLogs", EVIDENCE_LIMITS.agentLogs],
    ["runAudit", EVIDENCE_LIMITS.runAudit],
  ];
  for (const [group, limit] of groups) {
    if (!Array.isArray(bundle[group]) || bundle[group].length > limit) {
      throw new RoomEvalEvidenceAdapterError("collector_result_invalid", `Collector evidence group ${group} exceeds its bounded limit.`);
    }
  }
}

function appendWithinLimit<T extends { readonly id: string; readonly timestamp?: string }>(
  existing: readonly T[],
  additions: readonly T[],
  limit: number,
  group: string,
): T[] {
  if (existing.length + additions.length > limit) {
    throw new RoomEvalEvidenceAdapterError(
      "source_reference_limit",
      `Existing Eval evidence group ${group} has no bounded capacity for immutable Room references.`,
    );
  }
  return [...existing, ...additions];
}

function sortEntries<T extends { readonly id: string; readonly timestamp?: string }>(entries: readonly T[]): T[] {
  return [...entries].sort((left, right) => compareText(left.timestamp ?? "", right.timestamp ?? "") || compareText(left.id, right.id));
}

function assertPersistedResult(
  result: EvalTaskResult,
  runId: string,
  taskId: string,
  immutableReferences: readonly EvalEvidenceReference[],
): void {
  if (!isRecord(result) || result.runId !== runId || result.taskId !== taskId || !Array.isArray(result.evidence)) {
    throw new RoomEvalEvidenceAdapterError("eval_store_result_mismatch", "EvalStore returned a result outside the requested run/task identity.");
  }
  for (const reference of immutableReferences) {
    if (!result.evidence.some((persisted) => persisted?.ref === reference.ref)) {
      throw new RoomEvalEvidenceAdapterError(
        "eval_store_result_mismatch",
        `EvalStore did not retain immutable Room reference ${reference.ref}.`,
      );
    }
  }
}

function assertEvidenceReferences(values: unknown, available: ReadonlySet<string>, owner: string): void {
  if (!Array.isArray(values) || values.length === 0 || values.some((value) => !isReference(value)) || new Set(values).size !== values.length) {
    throw new RoomEvalEvidenceAdapterError("forged_reference", `${owner} must contain distinct immutable evidence IDs.`);
  }
  for (const id of values) {
    if (!available.has(id)) {
      throw new RoomEvalEvidenceAdapterError("forged_reference", `${owner} references unavailable immutable evidence ${id}.`);
    }
  }
}

function assertUniqueId(ids: Set<string>, id: string, label: string): void {
  assertReference(id, `${label} ID`);
  if (ids.has(id)) {
    throw new RoomEvalEvidenceAdapterError("forged_reference", `${label} ${id} appears more than once in one immutable snapshot.`);
  }
  ids.add(id);
}

function normalizeScope(value: unknown): RoomEvidenceLedgerScope {
  if (!isRecord(value) || !isReference(value.projectId) || !isReference(value.roomId)) {
    throw new RoomEvalEvidenceAdapterError("invalid_input", "Room Eval evidence scope requires canonical project and Room IDs.");
  }
  return freeze({ projectId: value.projectId, roomId: value.roomId }) as RoomEvidenceLedgerScope;
}

function assertReference(value: unknown, label: string): asserts value is string {
  if (!isReference(value)) {
    throw new RoomEvalEvidenceAdapterError("invalid_input", `${label} must be a canonical nonblank reference.`);
  }
}

function assertHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw new RoomEvalEvidenceAdapterError("missing_hash", `${label} must be a canonical sha256 hash.`);
  }
}

function requireEvalStore(value: unknown): RoomEvalStorePortV1 {
  if (!isRecord(value) || typeof value.getRun !== "function" || typeof value.createTaskResult !== "function") {
    throw new RoomEvalEvidenceAdapterError("invalid_input", "Room Eval evidence adapter requires the existing EvalStore getRun/createTaskResult port.");
  }
  return value as unknown as RoomEvalStorePortV1;
}

function requireSnapshotReader(value: unknown): RoomEvalEvidenceSnapshotReaderPortV1 {
  if (!isRecord(value) || typeof value.loadCandidateEvaluation !== "function") {
    throw new RoomEvalEvidenceAdapterError("invalid_input", "Room Eval evidence adapter requires an immutable candidate snapshot reader.");
  }
  return value as unknown as RoomEvalEvidenceSnapshotReaderPortV1;
}

function requireEvidenceCollector(value: unknown): RoomEvalEvidenceCollectorPortV1 {
  if (!isRecord(value) || typeof value.collectTaskEvaluationEvidence !== "function") {
    throw new RoomEvalEvidenceAdapterError("invalid_input", "Room Eval evidence adapter requires the existing evidence collector port.");
  }
  return value as unknown as RoomEvalEvidenceCollectorPortV1;
}

function requireDeterministicAuthority(value: unknown): RoomEvalDeterministicGateAuthorityPortV1 {
  if (!isRecord(value) || typeof value.evaluate !== "function") {
    throw new RoomEvalEvidenceAdapterError("invalid_input", "Room Eval evidence adapter requires a deterministic Room gate authority port.");
  }
  return value as unknown as RoomEvalDeterministicGateAuthorityPortV1;
}

function isCandidate(value: unknown): value is RoomCandidateRecordV1 {
  return isRecord(value)
    && isReference(value.id)
    && isReference(value.roomId)
    && isReference(value.nodeId)
    && isReference(value.producingBindingId)
    && isNonBlank(value.contentHash);
}

function isEvidence(value: unknown): value is RoomEvidenceRecordV1 {
  return isRecord(value)
    && isReference(value.id)
    && isReference(value.roomId)
    && (value.candidateId === null || isReference(value.candidateId))
    && isNonBlank(value.contentHash);
}

function isReview(value: unknown): value is RoomReviewRecordV1 {
  return isRecord(value)
    && isReference(value.id)
    && isReference(value.roomId)
    && isReference(value.candidateId)
    && isReference(value.reviewerBindingId)
    && typeof value.independentFromProducer === "boolean"
    && isNonBlank(value.reviewContentHash);
}

function isGateResult(value: unknown): value is RoomGateResultV1 {
  return isRecord(value)
    && isReference(value.id)
    && isReference(value.roomId)
    && isReference(value.candidateId)
    && typeof value.hard === "boolean"
    && typeof value.status === "string";
}

function isTaskCollectorInput(value: Record<string, unknown>): value is Omit<RoomEvalTaskEvidenceCollectorInputV1, "runId"> {
  return isRecord(value.task) && isReference(value.task.id) && isNonBlank(value.cwd) && value.store !== undefined;
}

function isEvalInput(value: unknown): value is EvalTaskResultCreateInput {
  return isRecord(value)
    && isReference(value.taskId)
    && isRecord(value.taskSnapshot)
    && value.taskSnapshot.taskId === value.taskId
    && (value.status === "scored" || value.status === "skipped" || value.status === "error")
    && Array.isArray(value.deterministicSignals);
}

function isAuthorityDecision(value: unknown): value is RoomEvalDeterministicGateAuthorityDecisionV1 {
  return isRecord(value) && typeof value.allHardGatesPassed === "boolean" && isNonBlank(value.reason);
}

function isEvalReference(value: unknown): value is EvalEvidenceReference {
  return isRecord(value) && typeof value.type === "string" && EVAL_REFERENCE_TYPES.has(value.type as EvalEvidenceReference["type"])
    && isNonBlank(value.ref);
}

function sameScope(left: RoomEvidenceLedgerScope, right: Record<string, unknown>): boolean {
  return left.projectId === right.projectId && left.roomId === right.roomId;
}

function readString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function readTimestamp(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = readString(metadata, key);
  return value && !Number.isNaN(Date.parse(value)) ? value : undefined;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isReference(value: unknown): value is string {
  return typeof value === "string" && REFERENCE_PATTERN.test(value);
}

function isNonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function freeze<T>(value: T): Readonly<T> {
  return Object.freeze(value);
}
