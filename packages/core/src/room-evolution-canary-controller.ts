export const ROOM_EVOLUTION_CANARY_CONTROLLER_CONTRACT_VERSION = 1 as const;

export type RoomEvolutionCanaryRiskClassV1 = "low" | "moderate" | "high" | "critical";
export type RoomEvolutionCanaryObjectiveDirectionV1 = "higher_is_better" | "lower_is_better";

export interface RoomEvolutionCanaryCandidateV1 {
  readonly candidateVersionId: string;
  readonly candidateHash: string;
  readonly riskClass: RoomEvolutionCanaryRiskClassV1;
  readonly eligibleRoomIds: readonly string[];
}

export interface RoomEvolutionCanaryBaselineV1 {
  readonly strategyVersionId: string;
  readonly snapshotId: string;
  readonly snapshotHash: string;
}

export interface RoomEvolutionCanaryAuthorizationV1 {
  readonly source: "durable_independent_gate_ledger";
  readonly candidateHash: string;
  readonly gateResultIds: readonly string[];
  readonly independentEvaluatorBindingIds: readonly string[];
  readonly authorizedAt: string;
  readonly humanApprovalId: string | null;
}

export interface RoomEvolutionCanaryCapacityV1 {
  readonly configuredSlots: number;
  readonly activeSlots: number;
  readonly reservedRecoverySlots: number;
  readonly observedAt: string;
}

export interface RoomEvolutionCanaryObjectivePolicyV1 {
  readonly id: string;
  readonly direction: RoomEvolutionCanaryObjectiveDirectionV1;
  readonly maximumDegradation: number;
}

export interface RoomEvolutionCanaryPolicyV1 {
  readonly minimumRooms: number;
  readonly maximumRooms: number;
  readonly maximumEligibleFraction: number;
  readonly minimumSamplesPerRoom: number;
  readonly objectives: readonly RoomEvolutionCanaryObjectivePolicyV1[];
}

export interface AllocateRoomEvolutionCanaryInputV1 {
  readonly contractVersion: typeof ROOM_EVOLUTION_CANARY_CONTROLLER_CONTRACT_VERSION;
  readonly projectId: string;
  readonly requestId: string;
  readonly candidate: RoomEvolutionCanaryCandidateV1;
  readonly baseline: RoomEvolutionCanaryBaselineV1;
  readonly authorization: RoomEvolutionCanaryAuthorizationV1;
  readonly capacity: RoomEvolutionCanaryCapacityV1;
  readonly policy: RoomEvolutionCanaryPolicyV1;
  readonly allocatedAt: string;
}

export interface RoomEvolutionCanaryAllocationV1 {
  readonly contractVersion: typeof ROOM_EVOLUTION_CANARY_CONTROLLER_CONTRACT_VERSION;
  readonly id: string;
  readonly projectId: string;
  readonly requestId: string;
  readonly candidateVersionId: string;
  readonly candidateHash: string;
  readonly riskClass: RoomEvolutionCanaryRiskClassV1;
  readonly baselineStrategyVersionId: string;
  readonly baselineSnapshotId: string;
  readonly baselineSnapshotHash: string;
  readonly rollbackTargetVersionId: string;
  readonly roomIds: readonly string[];
  readonly reservedRecoverySlots: number;
  readonly policy: RoomEvolutionCanaryPolicyV1;
  readonly allocatedAt: string;
  readonly modelSelfAuthorizationExcluded: true;
}

export type RoomEvolutionCanaryAllocationWithheldCodeV1 =
  | "invalid_input"
  | "invalid_timestamp"
  | "candidate_not_independently_authorized"
  | "human_approval_required"
  | "capacity_unavailable"
  | "eligible_population_below_minimum";

export type AllocateRoomEvolutionCanaryResultV1 =
  | { readonly ok: true; readonly status: "allocated"; readonly allocation: RoomEvolutionCanaryAllocationV1 }
  | { readonly ok: false; readonly reason: { readonly code: RoomEvolutionCanaryAllocationWithheldCodeV1; readonly message: string } };

export interface RoomEvolutionCanaryRoomObjectiveOutcomeV1 {
  readonly id: string;
  readonly baseline: number;
  readonly candidate: number;
}

export interface RoomEvolutionCanaryRoomOutcomeV1 {
  readonly roomId: string;
  readonly baselineSnapshotId: string;
  readonly samples: number;
  readonly objectives: readonly RoomEvolutionCanaryRoomObjectiveOutcomeV1[];
}

export interface EvaluateRoomEvolutionCanaryInputV1 {
  readonly contractVersion: typeof ROOM_EVOLUTION_CANARY_CONTROLLER_CONTRACT_VERSION;
  readonly allocation: RoomEvolutionCanaryAllocationV1;
  readonly evaluatedAt: string;
  readonly roomOutcomes: readonly RoomEvolutionCanaryRoomOutcomeV1[];
}

export type RoomEvolutionCanaryEvaluationWithheldCodeV1 =
  | "invalid_input"
  | "invalid_timestamp"
  | "baseline_snapshot_mismatch"
  | "outcome_room_mismatch"
  | "insufficient_samples"
  | "objective_mismatch";

export type EvaluateRoomEvolutionCanaryResultV1 =
  | {
    readonly ok: true;
    readonly status: "rollback_required";
    readonly rollback: {
      readonly allocationId: string;
      readonly targetVersionId: string;
      readonly roomIds: readonly string[];
      readonly evaluatedAt: string;
      readonly reasons: readonly string[];
    };
  }
  | {
    readonly ok: true;
    readonly status: "eligible_for_independent_promotion";
    readonly allocationId: string;
    readonly evaluatedAt: string;
    readonly modelSelfAcceptanceExcluded: true;
  }
  | { readonly ok: false; readonly reason: { readonly code: RoomEvolutionCanaryEvaluationWithheldCodeV1; readonly message: string } };

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const HASH = /^sha256:[a-f0-9]{64}$/u;
const RISK_CLASSES = new Set<RoomEvolutionCanaryRiskClassV1>(["low", "moderate", "high", "critical"]);
const DIRECTIONS = new Set<RoomEvolutionCanaryObjectiveDirectionV1>(["higher_is_better", "lower_is_better"]);

export function allocateRoomEvolutionCanary(
  input: AllocateRoomEvolutionCanaryInputV1,
): AllocateRoomEvolutionCanaryResultV1 {
  const parsed = parseAllocationInput(input);
  if (!parsed.ok) return parsed;
  const { candidate, baseline, authorization, capacity, policy } = parsed.value;
  if (authorization.candidateHash !== candidate.candidateHash) {
    return withheldAllocation("candidate_not_independently_authorized", "Independent authorization does not bind the requested candidate hash.");
  }
  if ((candidate.riskClass === "high" || candidate.riskClass === "critical") && authorization.humanApprovalId === null) {
    return withheldAllocation("human_approval_required", "High-risk candidate canaries require a durable human approval id.");
  }
  const eligibleLimit = Math.floor(candidate.eligibleRoomIds.length * policy.maximumEligibleFraction);
  const availableSlots = capacity.configuredSlots - capacity.activeSlots - capacity.reservedRecoverySlots;
  const maximumRooms = Math.min(policy.maximumRooms, eligibleLimit, availableSlots);
  if (maximumRooms < policy.minimumRooms) {
    const code = candidate.eligibleRoomIds.length < policy.minimumRooms || eligibleLimit < policy.minimumRooms
      ? "eligible_population_below_minimum"
      : "capacity_unavailable";
    return withheldAllocation(code, "The bounded canary cannot allocate its required minimum without violating eligibility or recovery capacity.");
  }
  const roomIds = candidate.eligibleRoomIds.slice(0, policy.minimumRooms);
  return Object.freeze({
    ok: true as const,
    status: "allocated" as const,
    allocation: freezeAllocation({
      contractVersion: ROOM_EVOLUTION_CANARY_CONTROLLER_CONTRACT_VERSION,
      id: `canary:${parsed.value.projectId}:${parsed.value.requestId}`,
      projectId: parsed.value.projectId,
      requestId: parsed.value.requestId,
      candidateVersionId: candidate.candidateVersionId,
      candidateHash: candidate.candidateHash,
      riskClass: candidate.riskClass,
      baselineStrategyVersionId: baseline.strategyVersionId,
      baselineSnapshotId: baseline.snapshotId,
      baselineSnapshotHash: baseline.snapshotHash,
      rollbackTargetVersionId: baseline.strategyVersionId,
      roomIds,
      reservedRecoverySlots: capacity.reservedRecoverySlots,
      policy,
      allocatedAt: parsed.value.allocatedAt,
      modelSelfAuthorizationExcluded: true as const,
    }),
  });
}

export function evaluateRoomEvolutionCanary(
  input: EvaluateRoomEvolutionCanaryInputV1,
): EvaluateRoomEvolutionCanaryResultV1 {
  const parsed = parseEvaluationInput(input);
  if (!parsed.ok) return parsed;
  const { allocation, evaluatedAt, outcomes } = parsed.value;
  const byRoom = new Map(outcomes.map((outcome) => [outcome.roomId, outcome]));
  const reasons: string[] = [];
  for (const roomId of allocation.roomIds) {
    const outcome = byRoom.get(roomId)!;
    for (const policy of allocation.policy.objectives) {
      const objective = outcome.objectives.find((entry) => entry.id === policy.id)!;
      const degradation = policy.direction === "higher_is_better"
        ? objective.baseline - objective.candidate
        : objective.candidate - objective.baseline;
      if (degradation > policy.maximumDegradation) {
        reasons.push(`${roomId}:${policy.id}:degradation=${degradation}`);
      }
    }
  }
  if (reasons.length > 0) {
    return Object.freeze({
      ok: true as const,
      status: "rollback_required" as const,
      rollback: Object.freeze({
        allocationId: allocation.id,
        targetVersionId: allocation.rollbackTargetVersionId,
        roomIds: Object.freeze([...allocation.roomIds]),
        evaluatedAt,
        reasons: Object.freeze([...reasons].sort()),
      }),
    });
  }
  return Object.freeze({
    ok: true as const,
    status: "eligible_for_independent_promotion" as const,
    allocationId: allocation.id,
    evaluatedAt,
    modelSelfAcceptanceExcluded: true as const,
  });
}

function parseAllocationInput(input: unknown):
  | { readonly ok: true; readonly value: {
    readonly projectId: string;
    readonly requestId: string;
    readonly candidate: RoomEvolutionCanaryCandidateV1;
    readonly baseline: RoomEvolutionCanaryBaselineV1;
    readonly authorization: RoomEvolutionCanaryAuthorizationV1;
    readonly capacity: RoomEvolutionCanaryCapacityV1;
    readonly policy: RoomEvolutionCanaryPolicyV1;
    readonly allocatedAt: string;
  } }
  | { readonly ok: false; readonly reason: { readonly code: RoomEvolutionCanaryAllocationWithheldCodeV1; readonly message: string } } {
  if (!isRecord(input) || !hasExactKeys(input, ["contractVersion", "projectId", "requestId", "candidate", "baseline", "authorization", "capacity", "policy", "allocatedAt"])) {
    return withheldAllocation("invalid_input", "Canary allocation input must have the exact v1 shape.");
  }
  if (input.contractVersion !== ROOM_EVOLUTION_CANARY_CONTROLLER_CONTRACT_VERSION) {
    return withheldAllocation("invalid_input", "Canary allocation contract version is unsupported.");
  }
  if (!isIdentifier(input.projectId) || !isIdentifier(input.requestId)) {
    return withheldAllocation("invalid_input", "Project and request ids must be canonical identifiers.");
  }
  if (!isTimestamp(input.allocatedAt)) return withheldAllocation("invalid_timestamp", "allocatedAt must be an ISO timestamp.");
  const candidate = parseCandidate(input.candidate);
  const baseline = parseBaseline(input.baseline);
  const authorization = parseAuthorization(input.authorization, input.allocatedAt);
  const capacity = parseCapacity(input.capacity, input.allocatedAt);
  const policy = parsePolicy(input.policy);
  if (!candidate || !baseline || !authorization || !capacity || !policy) {
    return withheldAllocation("invalid_input", "Canary input contains an invalid candidate, baseline, authorization, capacity, or policy.");
  }
  return { ok: true, value: { projectId: input.projectId, requestId: input.requestId, candidate, baseline, authorization, capacity, policy, allocatedAt: input.allocatedAt } };
}

function parseEvaluationInput(input: unknown):
  | { readonly ok: true; readonly value: { readonly allocation: RoomEvolutionCanaryAllocationV1; readonly evaluatedAt: string; readonly outcomes: readonly RoomEvolutionCanaryRoomOutcomeV1[] } }
  | { readonly ok: false; readonly reason: { readonly code: RoomEvolutionCanaryEvaluationWithheldCodeV1; readonly message: string } } {
  if (!isRecord(input) || !hasExactKeys(input, ["contractVersion", "allocation", "evaluatedAt", "roomOutcomes"])) {
    return withheldEvaluation("invalid_input", "Canary evaluation input must have the exact v1 shape.");
  }
  if (input.contractVersion !== ROOM_EVOLUTION_CANARY_CONTROLLER_CONTRACT_VERSION || !isAllocation(input.allocation)) {
    return withheldEvaluation("invalid_input", "Canary evaluation requires a valid immutable allocation.");
  }
  if (!isTimestamp(input.evaluatedAt) || Date.parse(input.evaluatedAt) < Date.parse(input.allocation.allocatedAt)) {
    return withheldEvaluation("invalid_timestamp", "evaluatedAt must be a timestamp after allocation.");
  }
  if (!Array.isArray(input.roomOutcomes) || input.roomOutcomes.length !== input.allocation.roomIds.length) {
    return withheldEvaluation("outcome_room_mismatch", "Canary evaluation must include exactly one outcome for each allocated Room.");
  }
  const expectedRooms = new Set(input.allocation.roomIds);
  const seenRooms = new Set<string>();
  const expectedObjectiveIds = input.allocation.policy.objectives.map((entry) => entry.id);
  const outcomes: RoomEvolutionCanaryRoomOutcomeV1[] = [];
  for (const value of input.roomOutcomes) {
    if (!isRoomOutcome(value)) return withheldEvaluation("invalid_input", "Canary Room outcome is invalid.");
    if (!expectedRooms.has(value.roomId) || seenRooms.has(value.roomId)) {
      return withheldEvaluation("outcome_room_mismatch", "Canary outcome Room ids must equal the allocation Room ids exactly once.");
    }
    seenRooms.add(value.roomId);
    if (value.baselineSnapshotId !== input.allocation.baselineSnapshotId) {
      return withheldEvaluation("baseline_snapshot_mismatch", "Every canary outcome must use the allocation's immutable baseline snapshot.");
    }
    if (value.samples < input.allocation.policy.minimumSamplesPerRoom) {
      return withheldEvaluation("insufficient_samples", "Each canary Room outcome must meet the policy minimum samples.");
    }
    if (!sameUniqueSet(value.objectives.map((entry) => entry.id), expectedObjectiveIds)) {
      return withheldEvaluation("objective_mismatch", "Each Room outcome must evaluate the same immutable objective set as the allocation.");
    }
    outcomes.push(freezeRoomOutcome(value));
  }
  return { ok: true, value: { allocation: input.allocation, evaluatedAt: input.evaluatedAt, outcomes: Object.freeze(outcomes.sort((left, right) => left.roomId.localeCompare(right.roomId))) } };
}

function parseCandidate(value: unknown): RoomEvolutionCanaryCandidateV1 | null {
  if (!isRecord(value) || !hasExactKeys(value, ["candidateVersionId", "candidateHash", "riskClass", "eligibleRoomIds"])) return null;
  if (!isIdentifier(value.candidateVersionId) || !isHash(value.candidateHash) || !RISK_CLASSES.has(value.riskClass as RoomEvolutionCanaryRiskClassV1) || !isIdentifierList(value.eligibleRoomIds)) return null;
  return Object.freeze({ candidateVersionId: value.candidateVersionId, candidateHash: value.candidateHash, riskClass: value.riskClass as RoomEvolutionCanaryRiskClassV1, eligibleRoomIds: Object.freeze([...value.eligibleRoomIds].sort()) });
}

function parseBaseline(value: unknown): RoomEvolutionCanaryBaselineV1 | null {
  if (!isRecord(value) || !hasExactKeys(value, ["strategyVersionId", "snapshotId", "snapshotHash"])) return null;
  if (!isIdentifier(value.strategyVersionId) || !isIdentifier(value.snapshotId) || !isHash(value.snapshotHash)) return null;
  return Object.freeze({ strategyVersionId: value.strategyVersionId, snapshotId: value.snapshotId, snapshotHash: value.snapshotHash });
}

function parseAuthorization(value: unknown, allocatedAt: string): RoomEvolutionCanaryAuthorizationV1 | null {
  if (!isRecord(value) || !hasExactKeys(value, ["source", "candidateHash", "gateResultIds", "independentEvaluatorBindingIds", "authorizedAt", "humanApprovalId"])) return null;
  if (value.source !== "durable_independent_gate_ledger" || !isHash(value.candidateHash) || !isIdentifierList(value.gateResultIds) || !isIdentifierList(value.independentEvaluatorBindingIds) || !isTimestamp(value.authorizedAt) || Date.parse(value.authorizedAt) > Date.parse(allocatedAt) || !(value.humanApprovalId === null || isIdentifier(value.humanApprovalId))) return null;
  return Object.freeze({ source: value.source, candidateHash: value.candidateHash, gateResultIds: Object.freeze([...value.gateResultIds].sort()), independentEvaluatorBindingIds: Object.freeze([...value.independentEvaluatorBindingIds].sort()), authorizedAt: value.authorizedAt, humanApprovalId: value.humanApprovalId });
}

function parseCapacity(value: unknown, allocatedAt: string): RoomEvolutionCanaryCapacityV1 | null {
  if (!isRecord(value) || !hasExactKeys(value, ["configuredSlots", "activeSlots", "reservedRecoverySlots", "observedAt"])) return null;
  if (!isNonNegativeSafeInteger(value.configuredSlots) || !isNonNegativeSafeInteger(value.activeSlots) || !isNonNegativeSafeInteger(value.reservedRecoverySlots)) return null;
  const configuredSlots = value.configuredSlots;
  const activeSlots = value.activeSlots;
  const reservedRecoverySlots = value.reservedRecoverySlots;
  if (activeSlots + reservedRecoverySlots > configuredSlots || !isTimestamp(value.observedAt) || Date.parse(value.observedAt) > Date.parse(allocatedAt)) return null;
  const capacity = value as unknown as RoomEvolutionCanaryCapacityV1;
  return Object.freeze({ configuredSlots: capacity.configuredSlots, activeSlots: capacity.activeSlots, reservedRecoverySlots: capacity.reservedRecoverySlots, observedAt: capacity.observedAt });
}

function parsePolicy(value: unknown): RoomEvolutionCanaryPolicyV1 | null {
  if (!isRecord(value) || !hasExactKeys(value, ["minimumRooms", "maximumRooms", "maximumEligibleFraction", "minimumSamplesPerRoom", "objectives"])) return null;
  if (!isPositiveSafeInteger(value.minimumRooms) || !isPositiveSafeInteger(value.maximumRooms) || value.minimumRooms > value.maximumRooms || typeof value.maximumEligibleFraction !== "number" || !Number.isFinite(value.maximumEligibleFraction) || value.maximumEligibleFraction <= 0 || value.maximumEligibleFraction > 1 || !isPositiveSafeInteger(value.minimumSamplesPerRoom) || !Array.isArray(value.objectives) || value.objectives.length === 0) return null;
  const ids = new Set<string>();
  const objectives: RoomEvolutionCanaryObjectivePolicyV1[] = [];
  for (const objective of value.objectives) {
    if (!isRecord(objective) || !hasExactKeys(objective, ["id", "direction", "maximumDegradation"]) || !isIdentifier(objective.id) || !DIRECTIONS.has(objective.direction as RoomEvolutionCanaryObjectiveDirectionV1) || typeof objective.maximumDegradation !== "number" || !Number.isFinite(objective.maximumDegradation) || objective.maximumDegradation < 0 || ids.has(objective.id)) return null;
    ids.add(objective.id);
    objectives.push(Object.freeze({ id: objective.id, direction: objective.direction as RoomEvolutionCanaryObjectiveDirectionV1, maximumDegradation: objective.maximumDegradation }));
  }
  return Object.freeze({ minimumRooms: value.minimumRooms, maximumRooms: value.maximumRooms, maximumEligibleFraction: value.maximumEligibleFraction, minimumSamplesPerRoom: value.minimumSamplesPerRoom, objectives: Object.freeze(objectives.sort((left, right) => left.id.localeCompare(right.id))) });
}

function isAllocation(value: unknown): value is RoomEvolutionCanaryAllocationV1 {
  if (!isRecord(value) || !hasExactKeys(value, ["contractVersion", "id", "projectId", "requestId", "candidateVersionId", "candidateHash", "riskClass", "baselineStrategyVersionId", "baselineSnapshotId", "baselineSnapshotHash", "rollbackTargetVersionId", "roomIds", "reservedRecoverySlots", "policy", "allocatedAt", "modelSelfAuthorizationExcluded"])) return false;
  return value.contractVersion === ROOM_EVOLUTION_CANARY_CONTROLLER_CONTRACT_VERSION && isIdentifier(value.id) && isIdentifier(value.projectId) && isIdentifier(value.requestId) && isIdentifier(value.candidateVersionId) && isHash(value.candidateHash) && RISK_CLASSES.has(value.riskClass as RoomEvolutionCanaryRiskClassV1) && isIdentifier(value.baselineStrategyVersionId) && isIdentifier(value.baselineSnapshotId) && isHash(value.baselineSnapshotHash) && isIdentifier(value.rollbackTargetVersionId) && isIdentifierList(value.roomIds) && isNonNegativeSafeInteger(value.reservedRecoverySlots) && parsePolicy(value.policy) !== null && isTimestamp(value.allocatedAt) && value.modelSelfAuthorizationExcluded === true;
}

function isRoomOutcome(value: unknown): value is RoomEvolutionCanaryRoomOutcomeV1 {
  if (!isRecord(value) || !hasExactKeys(value, ["roomId", "baselineSnapshotId", "samples", "objectives"]) || !isIdentifier(value.roomId) || !isIdentifier(value.baselineSnapshotId) || !isPositiveSafeInteger(value.samples) || !Array.isArray(value.objectives) || value.objectives.length === 0) return false;
  const ids = new Set<string>();
  return value.objectives.every((objective) => {
    if (!isRecord(objective) || !hasExactKeys(objective, ["id", "baseline", "candidate"]) || !isIdentifier(objective.id) || ids.has(objective.id) || typeof objective.baseline !== "number" || !Number.isFinite(objective.baseline) || typeof objective.candidate !== "number" || !Number.isFinite(objective.candidate)) return false;
    ids.add(objective.id);
    return true;
  });
}

function freezeAllocation(value: RoomEvolutionCanaryAllocationV1): RoomEvolutionCanaryAllocationV1 {
  return Object.freeze({ ...value, roomIds: Object.freeze([...value.roomIds]), policy: Object.freeze({ ...value.policy, objectives: Object.freeze(value.policy.objectives.map((objective) => Object.freeze({ ...objective }))) }) });
}

function freezeRoomOutcome(value: RoomEvolutionCanaryRoomOutcomeV1): RoomEvolutionCanaryRoomOutcomeV1 {
  return Object.freeze({ ...value, objectives: Object.freeze(value.objectives.map((objective) => Object.freeze({ ...objective })).sort((left, right) => left.id.localeCompare(right.id))) });
}

function withheldAllocation(
  code: RoomEvolutionCanaryAllocationWithheldCodeV1,
  message: string,
): Extract<AllocateRoomEvolutionCanaryResultV1, { readonly ok: false }> {
  return Object.freeze({ ok: false as const, reason: Object.freeze({ code, message }) });
}

function withheldEvaluation(
  code: RoomEvolutionCanaryEvaluationWithheldCodeV1,
  message: string,
): Extract<EvaluateRoomEvolutionCanaryResultV1, { readonly ok: false }> {
  return Object.freeze({ ok: false as const, reason: Object.freeze({ code, message }) });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function isIdentifierList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length > 0 && value.every(isIdentifier) && new Set(value).size === value.length;
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && HASH.test(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function sameUniqueSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length && left.every((value) => right.includes(value));
}
