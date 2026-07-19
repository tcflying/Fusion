import type { ProjectId, RoomId, RoomTurnId } from "./room-contracts/ids.js";
import { hashRoomValue } from "./room-integrity.js";

export const ROOM_STRATEGY_VERSION_PINNING_CONTRACT_VERSION = 1 as const;

export type RoomStrategyPromotionStateV1 = "candidate" | "promoted" | "rejected" | "rolled_back";
export type RoomStrategyCompatibilityStateV1 = "compatible" | "incompatible";
export type RoomStrategyCompatibilityEvaluatorKindV1 =
  | "deterministic_migration_gate"
  | "independent_evaluator"
  | "model_self_report";
export type RoomStrategyUpgradeAuthorityKindV1 =
  | "human_operator"
  | "independent_authorizer"
  | "model_self_report";
export type RoomStrategyUpgradeEvidenceKindV1 = "promotion" | "compatibility" | "rollback";
export type RoomStrategyUpgradeEvidenceSourceKindV1 =
  | "durable_evolution_ledger"
  | "deterministic_gate"
  | "independent_evaluator"
  | "human_operator"
  | "model_self_report";

export interface RoomStrategyVersionReferenceV1 {
  readonly strategyVersionId: string;
  readonly projectId: ProjectId;
  readonly immutableContentHash: string;
  readonly promotionState: RoomStrategyPromotionStateV1;
  readonly promotionDecisionId: string | null;
  readonly producerActorId: string;
  readonly promotedAt: string | null;
}

export interface RoomStrategyRuntimeSnapshotV1 {
  readonly projectId: ProjectId;
  readonly roomId: RoomId;
  readonly aggregateVersion: number;
  readonly activeTurnId: RoomTurnId | null;
}

export interface RoomStrategyVersionPinV1 {
  readonly projectId: ProjectId;
  readonly roomId: RoomId;
  readonly pinVersion: number;
  readonly aggregateVersion: number;
  readonly strategy: RoomStrategyVersionReferenceV1;
  readonly pinnedAt: string;
}

export interface RoomStrategyUpgradeRequestV1 {
  readonly upgradeId: string;
  readonly projectId: ProjectId;
  readonly roomId: RoomId;
  readonly expectedPinVersion: number;
  readonly expectedAggregateVersion: number;
  readonly requestedAt: string;
  readonly targetStrategy: RoomStrategyVersionReferenceV1;
  readonly rollbackTarget: RoomStrategyVersionReferenceV1;
}

export interface RoomStrategySettledTurnBoundaryV1 {
  readonly projectId: ProjectId;
  readonly roomId: RoomId;
  readonly aggregateVersion: number;
  readonly activeTurnId: null;
  readonly settledTurnId: RoomTurnId;
  readonly state: "completed" | "cancelled" | "uncertain";
  readonly settledAt: string;
}

export interface RoomStrategyCompatibilityContractV1 {
  readonly compatibilityId: string;
  readonly projectId: ProjectId;
  readonly roomId: RoomId;
  readonly sourceStrategyVersionId: string;
  readonly sourceImmutableContentHash: string;
  readonly targetStrategyVersionId: string;
  readonly targetImmutableContentHash: string;
  readonly state: RoomStrategyCompatibilityStateV1;
  readonly evaluatorKind: RoomStrategyCompatibilityEvaluatorKindV1;
  readonly evaluatorId: string;
  readonly compatibilityHash: string;
  readonly evidenceHash: string;
  readonly evaluatedAt: string;
}

export interface RoomStrategyUpgradeAuthorizationV1 {
  readonly authorizationId: string;
  readonly projectId: ProjectId;
  readonly roomId: RoomId;
  readonly sourceStrategyVersionId: string;
  readonly sourceImmutableContentHash: string;
  readonly targetStrategyVersionId: string;
  readonly targetImmutableContentHash: string;
  readonly granted: boolean;
  readonly authorityKind: RoomStrategyUpgradeAuthorityKindV1;
  readonly authorityId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly evidenceHash: string;
}

export interface RoomStrategyUpgradeIndependentEvidenceV1 {
  readonly evidenceId: string;
  readonly projectId: ProjectId;
  readonly roomId: RoomId;
  readonly strategyVersionId: string;
  readonly kind: RoomStrategyUpgradeEvidenceKindV1;
  readonly sourceKind: RoomStrategyUpgradeEvidenceSourceKindV1;
  readonly sourceId: string;
  readonly observedAt: string;
  readonly evidenceHash: string;
}

export interface EvaluateRoomStrategyVersionPinningInputV1 {
  readonly contractVersion: typeof ROOM_STRATEGY_VERSION_PINNING_CONTRACT_VERSION;
  readonly asOf: string;
  readonly room: RoomStrategyRuntimeSnapshotV1;
  readonly currentPin: RoomStrategyVersionPinV1;
  readonly request: RoomStrategyUpgradeRequestV1;
  readonly turnBoundary: RoomStrategySettledTurnBoundaryV1;
  readonly compatibility: RoomStrategyCompatibilityContractV1;
  readonly authorization: RoomStrategyUpgradeAuthorizationV1;
  readonly independentEvidence: readonly RoomStrategyUpgradeIndependentEvidenceV1[];
}

export type RoomStrategyVersionPinningIssueCodeV1 =
  | "invalid_input"
  | "scope_mismatch"
  | "current_pin_not_promoted"
  | "target_not_promoted"
  | "target_identity_conflict"
  | "turn_boundary_required"
  | "stale_version_conflict"
  | "compatibility_mismatch"
  | "incompatible_target"
  | "authorization_required"
  | "authorization_expired"
  | "self_authorization_forbidden"
  | "untrusted_evidence_source"
  | "evidence_not_independent"
  | "missing_independent_evidence"
  | "rollback_target_required"
  | "append_ack_mismatch"
  | "append_failed";

export interface RoomStrategyVersionPinningIssueV1 {
  readonly code: RoomStrategyVersionPinningIssueCodeV1;
  readonly path: string;
  readonly message: string;
}

export interface RoomStrategyVersionUpgradeRecordV1 {
  readonly contractVersion: typeof ROOM_STRATEGY_VERSION_PINNING_CONTRACT_VERSION;
  readonly recordId: string;
  readonly recordHash: string;
  readonly upgradeId: string;
  readonly projectId: ProjectId;
  readonly roomId: RoomId;
  readonly sourcePinVersion: number;
  readonly sourceAggregateVersion: number;
  readonly sourceStrategyVersionId: string;
  readonly sourceImmutableContentHash: string;
  readonly targetStrategyVersionId: string;
  readonly targetImmutableContentHash: string;
  readonly targetPromotionDecisionId: string;
  readonly expectedPinVersion: number;
  readonly expectedAggregateVersion: number;
  readonly activation: {
    readonly kind: "after_settled_turn";
    readonly settledTurnId: RoomTurnId;
    readonly settledTurnState: "completed" | "cancelled" | "uncertain";
    readonly settledAt: string;
  };
  readonly compatibility: {
    readonly compatibilityId: string;
    readonly compatibilityHash: string;
    readonly evidenceHash: string;
    readonly evaluatorKind: "deterministic_migration_gate" | "independent_evaluator";
    readonly evaluatorId: string;
  };
  readonly authorization: {
    readonly authorizationId: string;
    readonly authorityKind: "human_operator" | "independent_authorizer";
    readonly authorityId: string;
    readonly evidenceHash: string;
  };
  readonly evidence: readonly {
    readonly evidenceId: string;
    readonly strategyVersionId: string;
    readonly kind: RoomStrategyUpgradeEvidenceKindV1;
    readonly sourceKind: Exclude<RoomStrategyUpgradeEvidenceSourceKindV1, "model_self_report">;
    readonly sourceId: string;
    readonly observedAt: string;
    readonly evidenceHash: string;
  }[];
  readonly evidenceHash: string;
  readonly rollbackTarget: {
    readonly strategyVersionId: string;
    readonly immutableContentHash: string;
    readonly promotionDecisionId: string;
  };
  readonly requestedAt: string;
  readonly recordedAt: string;
}

export type RoomStrategyVersionPinningResultV1 =
  | { readonly ok: true; readonly record: RoomStrategyVersionUpgradeRecordV1 }
  | { readonly ok: false; readonly issues: readonly RoomStrategyVersionPinningIssueV1[] };

export interface RoomStrategyVersionUpgradeAppendAckV1 {
  readonly status: "recorded";
  readonly recordId: string;
  readonly recordHash: string;
}

export interface RoomStrategyVersionUpgradeAppendPortV1 {
  append(record: RoomStrategyVersionUpgradeRecordV1): Promise<RoomStrategyVersionUpgradeAppendAckV1>;
}

export interface CommitRoomStrategyVersionUpgradeInputV1 {
  readonly input: EvaluateRoomStrategyVersionPinningInputV1;
  readonly appendPort: RoomStrategyVersionUpgradeAppendPortV1;
}

export type CommitRoomStrategyVersionUpgradeResultV1 =
  | { readonly ok: true; readonly record: RoomStrategyVersionUpgradeRecordV1 }
  | { readonly ok: false; readonly issues: readonly RoomStrategyVersionPinningIssueV1[] }
  | { readonly ok: false; readonly reason: RoomStrategyVersionPinningIssueV1 };

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const HASH = /^sha256:[a-f0-9]{64}$/u;
const PROMOTION_STATES = new Set<RoomStrategyPromotionStateV1>(["candidate", "promoted", "rejected", "rolled_back"]);
const COMPATIBILITY_STATES = new Set<RoomStrategyCompatibilityStateV1>(["compatible", "incompatible"]);
const COMPATIBILITY_EVALUATORS = new Set<RoomStrategyCompatibilityEvaluatorKindV1>([
  "deterministic_migration_gate", "independent_evaluator", "model_self_report",
]);
const AUTHORITY_KINDS = new Set<RoomStrategyUpgradeAuthorityKindV1>([
  "human_operator", "independent_authorizer", "model_self_report",
]);
const EVIDENCE_KINDS = new Set<RoomStrategyUpgradeEvidenceKindV1>(["promotion", "compatibility", "rollback"]);
const EVIDENCE_SOURCES = new Set<RoomStrategyUpgradeEvidenceSourceKindV1>([
  "durable_evolution_ledger", "deterministic_gate", "independent_evaluator", "human_operator", "model_self_report",
]);
const SETTLED_TURN_STATES = new Set<RoomStrategySettledTurnBoundaryV1["state"]>(["completed", "cancelled", "uncertain"]);

type RuntimeRecord = Record<string, unknown>;

/*
FNXC:RoomStrategyVersionPinning 2026-07-19-15:27:
Running Rooms must consume an immutable strategy only after a durable promotion.
An upgrade is not a model action: this pure rule emits a hash-bound record only
after an exact pin/version match, a settled turn boundary, independent evidence,
explicit compatibility, authorization, and a reversible promoted rollback target.
*/
export function evaluateRoomStrategyVersionPinning(
  input: EvaluateRoomStrategyVersionPinningInputV1,
): RoomStrategyVersionPinningResultV1 {
  const issues: RoomStrategyVersionPinningIssueV1[] = [];
  const candidate = input as unknown;
  const topLevelKeys = [
    "contractVersion", "asOf", "room", "currentPin", "request", "turnBoundary", "compatibility", "authorization", "independentEvidence",
  ];
  if (!isRecord(candidate) || !hasExactKeys(candidate, topLevelKeys)) {
    return fail([{ code: "invalid_input", path: "$", message: "input must have the exact v1 shape" }]);
  }
  if (candidate.contractVersion !== ROOM_STRATEGY_VERSION_PINNING_CONTRACT_VERSION) {
    issue(issues, "invalid_input", "$.contractVersion", "must equal the supported contract version");
  }
  const asOf = parseTimestamp(candidate.asOf, "$.asOf", issues);
  const room = parseRoom(candidate.room, issues);
  const currentPin = parsePin(candidate.currentPin, "$.currentPin", issues);
  const request = parseRequest(candidate.request, issues);
  const turnBoundary = parseTurnBoundary(candidate.turnBoundary, issues);
  const compatibility = parseCompatibility(candidate.compatibility, issues);
  const authorization = parseAuthorization(candidate.authorization, issues);
  const evidence = parseEvidenceCollection(candidate.independentEvidence, issues);
  if (
    candidate.contractVersion !== ROOM_STRATEGY_VERSION_PINNING_CONTRACT_VERSION ||
    !asOf ||
    !room ||
    !currentPin ||
    !request ||
    !turnBoundary ||
    !compatibility ||
    !authorization ||
    !evidence
  ) {
    return fail(issues);
  }

  validateRoomAndCurrentPin(room, currentPin, request, issues);
  validateTurnBoundary(room, turnBoundary, asOf, issues);
  validateTargetAndRollback(currentPin, request, issues);
  validateCompatibility(room, currentPin, request, compatibility, issues);
  validateAuthorization(room, currentPin, request, authorization, asOf, issues);
  validateEvidence(room, currentPin, request, evidence, asOf, issues);
  if (issues.length > 0) return fail(issues);
  return succeed(buildRecord(asOf, currentPin, request, turnBoundary, compatibility, authorization, evidence));
}

export async function commitRoomStrategyVersionUpgrade(
  input: CommitRoomStrategyVersionUpgradeInputV1,
): Promise<CommitRoomStrategyVersionUpgradeResultV1> {
  if (!isRecord(input) || !hasExactKeys(input, ["input", "appendPort"]) || !isRecord(input.appendPort) || typeof input.appendPort.append !== "function") {
    return appendFailure("invalid_input", "$.appendPort", "a strategy upgrade commit requires an injected append port");
  }
  const evaluated = evaluateRoomStrategyVersionPinning(input.input);
  if (!evaluated.ok) return evaluated;
  try {
    const acknowledgement = await input.appendPort.append(evaluated.record);
    if (!isExactAppendAcknowledgement(acknowledgement, evaluated.record)) {
      return appendFailure("append_ack_mismatch", "$.appendPort.append", "append must acknowledge the exact immutable upgrade record id and hash");
    }
    return evaluated;
  } catch {
    return appendFailure("append_failed", "$.appendPort.append", "append failed before the immutable upgrade record was acknowledged");
  }
}

function isRecord(value: unknown): value is RuntimeRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: RuntimeRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareText);
  const expected = [...keys].sort(compareText);
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && HASH.test(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function issue(
  issues: RoomStrategyVersionPinningIssueV1[],
  code: RoomStrategyVersionPinningIssueCodeV1,
  path: string,
  message: string,
): void {
  issues.push({ code, path, message });
}

function fail(issues: readonly RoomStrategyVersionPinningIssueV1[]): RoomStrategyVersionPinningResultV1 {
  return deepFreeze({
    ok: false,
    issues: [...issues].sort((left, right) => {
      const path = compareText(left.path, right.path);
      return path !== 0 ? path : compareText(left.code, right.code);
    }),
  });
}

function succeed(record: RoomStrategyVersionUpgradeRecordV1): RoomStrategyVersionPinningResultV1 {
  return deepFreeze({ ok: true, record });
}

function appendFailure(
  code: Extract<RoomStrategyVersionPinningIssueCodeV1, "invalid_input" | "append_ack_mismatch" | "append_failed">,
  path: string,
  message: string,
): CommitRoomStrategyVersionUpgradeResultV1 {
  return deepFreeze({ ok: false, reason: { code, path, message } });
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null) return value;
  const objectValue = value as object;
  if (seen.has(objectValue)) return value;
  seen.add(objectValue);
  for (const key of Reflect.ownKeys(objectValue)) {
    const descriptor = Object.getOwnPropertyDescriptor(objectValue, key);
    if (descriptor && "value" in descriptor) deepFreeze(descriptor.value, seen);
  }
  Object.freeze(objectValue);
  return value;
}

function parseIdentifier(value: unknown, path: string, issues: RoomStrategyVersionPinningIssueV1[]): string | undefined {
  if (!isIdentifier(value)) {
    issue(issues, "invalid_input", path, "must be a canonical non-empty identifier");
    return undefined;
  }
  return value;
}

function parseHash(value: unknown, path: string, issues: RoomStrategyVersionPinningIssueV1[]): string | undefined {
  if (!isHash(value)) {
    issue(issues, "invalid_input", path, "must be a canonical SHA-256 hash");
    return undefined;
  }
  return value;
}

function parseTimestamp(value: unknown, path: string, issues: RoomStrategyVersionPinningIssueV1[]): string | undefined {
  if (!isCanonicalTimestamp(value)) {
    issue(issues, "invalid_input", path, "must be a canonical UTC timestamp");
    return undefined;
  }
  return value;
}

function parseStrategy(
  value: unknown,
  path: string,
  issues: RoomStrategyVersionPinningIssueV1[],
): RoomStrategyVersionReferenceV1 | undefined {
  const keys = [
    "strategyVersionId", "projectId", "immutableContentHash", "promotionState", "promotionDecisionId", "producerActorId", "promotedAt",
  ];
  if (!isRecord(value) || !hasExactKeys(value, keys)) {
    issue(issues, "invalid_input", path, "strategy must have the exact immutable v1 reference shape");
    return undefined;
  }
  const strategyVersionId = parseIdentifier(value.strategyVersionId, `${path}.strategyVersionId`, issues);
  const projectId = parseIdentifier(value.projectId, `${path}.projectId`, issues);
  const immutableContentHash = parseHash(value.immutableContentHash, `${path}.immutableContentHash`, issues);
  const producerActorId = parseIdentifier(value.producerActorId, `${path}.producerActorId`, issues);
  const promotionDecisionId = value.promotionDecisionId === null
    ? null
    : parseIdentifier(value.promotionDecisionId, `${path}.promotionDecisionId`, issues);
  const promotedAt = value.promotedAt === null ? null : parseTimestamp(value.promotedAt, `${path}.promotedAt`, issues);
  if (typeof value.promotionState !== "string" || !PROMOTION_STATES.has(value.promotionState as RoomStrategyPromotionStateV1)) {
    issue(issues, "invalid_input", `${path}.promotionState`, "must name a supported promotion state");
  }
  if (
    !strategyVersionId ||
    !projectId ||
    !immutableContentHash ||
    !producerActorId ||
    promotionDecisionId === undefined ||
    promotedAt === undefined ||
    typeof value.promotionState !== "string" ||
    !PROMOTION_STATES.has(value.promotionState as RoomStrategyPromotionStateV1)
  ) {
    return undefined;
  }
  const promotionState = value.promotionState as RoomStrategyPromotionStateV1;
  if ((promotionState === "promoted") !== (promotionDecisionId !== null && promotedAt !== null)) {
    issue(issues, "invalid_input", path, "only a promoted immutable strategy may carry exactly one promotion decision and timestamp");
    return undefined;
  }
  return {
    strategyVersionId,
    projectId,
    immutableContentHash,
    promotionState,
    promotionDecisionId,
    producerActorId,
    promotedAt,
  };
}

function parseRoom(value: unknown, issues: RoomStrategyVersionPinningIssueV1[]): RoomStrategyRuntimeSnapshotV1 | undefined {
  const path = "$.room";
  if (!isRecord(value) || !hasExactKeys(value, ["projectId", "roomId", "aggregateVersion", "activeTurnId"])) {
    issue(issues, "invalid_input", path, "room must have the exact runtime snapshot shape");
    return undefined;
  }
  const projectId = parseIdentifier(value.projectId, `${path}.projectId`, issues);
  const roomId = parseIdentifier(value.roomId, `${path}.roomId`, issues);
  if (!isNonNegativeSafeInteger(value.aggregateVersion)) {
    issue(issues, "invalid_input", `${path}.aggregateVersion`, "must be a non-negative safe integer");
  }
  const activeTurnId = value.activeTurnId === null ? null : parseIdentifier(value.activeTurnId, `${path}.activeTurnId`, issues);
  if (!projectId || !roomId || !isNonNegativeSafeInteger(value.aggregateVersion) || activeTurnId === undefined) return undefined;
  return { projectId, roomId, aggregateVersion: value.aggregateVersion, activeTurnId };
}

function parsePin(
  value: unknown,
  path: string,
  issues: RoomStrategyVersionPinningIssueV1[],
): RoomStrategyVersionPinV1 | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["projectId", "roomId", "pinVersion", "aggregateVersion", "strategy", "pinnedAt"])) {
    issue(issues, "invalid_input", path, "pin must have the exact v1 shape");
    return undefined;
  }
  const projectId = parseIdentifier(value.projectId, `${path}.projectId`, issues);
  const roomId = parseIdentifier(value.roomId, `${path}.roomId`, issues);
  const strategy = parseStrategy(value.strategy, `${path}.strategy`, issues);
  const pinnedAt = parseTimestamp(value.pinnedAt, `${path}.pinnedAt`, issues);
  if (!isPositiveSafeInteger(value.pinVersion)) issue(issues, "invalid_input", `${path}.pinVersion`, "must be a positive safe integer");
  if (!isNonNegativeSafeInteger(value.aggregateVersion)) issue(issues, "invalid_input", `${path}.aggregateVersion`, "must be a non-negative safe integer");
  if (!projectId || !roomId || !strategy || !pinnedAt || !isPositiveSafeInteger(value.pinVersion) || !isNonNegativeSafeInteger(value.aggregateVersion)) return undefined;
  return { projectId, roomId, pinVersion: value.pinVersion, aggregateVersion: value.aggregateVersion, strategy, pinnedAt };
}

function parseRequest(value: unknown, issues: RoomStrategyVersionPinningIssueV1[]): RoomStrategyUpgradeRequestV1 | undefined {
  const path = "$.request";
  const keys = [
    "upgradeId", "projectId", "roomId", "expectedPinVersion", "expectedAggregateVersion", "requestedAt", "targetStrategy", "rollbackTarget",
  ];
  if (!isRecord(value) || !hasExactKeys(value, keys)) {
    issue(issues, "invalid_input", path, "upgrade request must have the exact v1 shape");
    return undefined;
  }
  const upgradeId = parseIdentifier(value.upgradeId, `${path}.upgradeId`, issues);
  const projectId = parseIdentifier(value.projectId, `${path}.projectId`, issues);
  const roomId = parseIdentifier(value.roomId, `${path}.roomId`, issues);
  const requestedAt = parseTimestamp(value.requestedAt, `${path}.requestedAt`, issues);
  const targetStrategy = parseStrategy(value.targetStrategy, `${path}.targetStrategy`, issues);
  const rollbackTarget = parseStrategy(value.rollbackTarget, `${path}.rollbackTarget`, issues);
  if (!isPositiveSafeInteger(value.expectedPinVersion)) issue(issues, "invalid_input", `${path}.expectedPinVersion`, "must be a positive safe integer");
  if (!isNonNegativeSafeInteger(value.expectedAggregateVersion)) issue(issues, "invalid_input", `${path}.expectedAggregateVersion`, "must be a non-negative safe integer");
  if (
    !upgradeId ||
    !projectId ||
    !roomId ||
    !requestedAt ||
    !targetStrategy ||
    !rollbackTarget ||
    !isPositiveSafeInteger(value.expectedPinVersion) ||
    !isNonNegativeSafeInteger(value.expectedAggregateVersion)
  ) return undefined;
  return {
    upgradeId,
    projectId,
    roomId,
    expectedPinVersion: value.expectedPinVersion,
    expectedAggregateVersion: value.expectedAggregateVersion,
    requestedAt,
    targetStrategy,
    rollbackTarget,
  };
}

function parseTurnBoundary(value: unknown, issues: RoomStrategyVersionPinningIssueV1[]): RoomStrategySettledTurnBoundaryV1 | undefined {
  const path = "$.turnBoundary";
  const keys = ["projectId", "roomId", "aggregateVersion", "activeTurnId", "settledTurnId", "state", "settledAt"];
  if (!isRecord(value) || !hasExactKeys(value, keys)) {
    issue(issues, "turn_boundary_required", path, "upgrade requires an exact settled turn boundary");
    return undefined;
  }
  const projectId = parseIdentifier(value.projectId, `${path}.projectId`, issues);
  const roomId = parseIdentifier(value.roomId, `${path}.roomId`, issues);
  const settledTurnId = parseIdentifier(value.settledTurnId, `${path}.settledTurnId`, issues);
  const settledAt = parseTimestamp(value.settledAt, `${path}.settledAt`, issues);
  if (!isNonNegativeSafeInteger(value.aggregateVersion)) issue(issues, "turn_boundary_required", `${path}.aggregateVersion`, "must be a non-negative safe integer");
  if (value.activeTurnId !== null) issue(issues, "turn_boundary_required", `${path}.activeTurnId`, "a strategy upgrade cannot cross an active turn");
  if (typeof value.state !== "string" || !SETTLED_TURN_STATES.has(value.state as RoomStrategySettledTurnBoundaryV1["state"])) {
    issue(issues, "turn_boundary_required", `${path}.state`, "upgrade requires a completed, cancelled, or uncertain settled turn");
  }
  if (
    !projectId ||
    !roomId ||
    !settledTurnId ||
    !settledAt ||
    !isNonNegativeSafeInteger(value.aggregateVersion) ||
    value.activeTurnId !== null ||
    typeof value.state !== "string" ||
    !SETTLED_TURN_STATES.has(value.state as RoomStrategySettledTurnBoundaryV1["state"])
  ) return undefined;
  return {
    projectId,
    roomId,
    aggregateVersion: value.aggregateVersion,
    activeTurnId: null,
    settledTurnId,
    state: value.state as RoomStrategySettledTurnBoundaryV1["state"],
    settledAt,
  };
}

function parseCompatibility(
  value: unknown,
  issues: RoomStrategyVersionPinningIssueV1[],
): RoomStrategyCompatibilityContractV1 | undefined {
  const path = "$.compatibility";
  const keys = [
    "compatibilityId", "projectId", "roomId", "sourceStrategyVersionId", "sourceImmutableContentHash", "targetStrategyVersionId", "targetImmutableContentHash",
    "state", "evaluatorKind", "evaluatorId", "compatibilityHash", "evidenceHash", "evaluatedAt",
  ];
  if (!isRecord(value) || !hasExactKeys(value, keys)) {
    issue(issues, "invalid_input", path, "compatibility must have the exact immutable v1 contract shape");
    return undefined;
  }
  const compatibilityId = parseIdentifier(value.compatibilityId, `${path}.compatibilityId`, issues);
  const projectId = parseIdentifier(value.projectId, `${path}.projectId`, issues);
  const roomId = parseIdentifier(value.roomId, `${path}.roomId`, issues);
  const sourceStrategyVersionId = parseIdentifier(value.sourceStrategyVersionId, `${path}.sourceStrategyVersionId`, issues);
  const sourceImmutableContentHash = parseHash(value.sourceImmutableContentHash, `${path}.sourceImmutableContentHash`, issues);
  const targetStrategyVersionId = parseIdentifier(value.targetStrategyVersionId, `${path}.targetStrategyVersionId`, issues);
  const targetImmutableContentHash = parseHash(value.targetImmutableContentHash, `${path}.targetImmutableContentHash`, issues);
  const evaluatorId = parseIdentifier(value.evaluatorId, `${path}.evaluatorId`, issues);
  const compatibilityHash = parseHash(value.compatibilityHash, `${path}.compatibilityHash`, issues);
  const evidenceHash = parseHash(value.evidenceHash, `${path}.evidenceHash`, issues);
  const evaluatedAt = parseTimestamp(value.evaluatedAt, `${path}.evaluatedAt`, issues);
  if (typeof value.state !== "string" || !COMPATIBILITY_STATES.has(value.state as RoomStrategyCompatibilityStateV1)) {
    issue(issues, "invalid_input", `${path}.state`, "must name a supported compatibility state");
  }
  if (typeof value.evaluatorKind !== "string" || !COMPATIBILITY_EVALUATORS.has(value.evaluatorKind as RoomStrategyCompatibilityEvaluatorKindV1)) {
    issue(issues, "invalid_input", `${path}.evaluatorKind`, "must name a supported compatibility evaluator kind");
  }
  if (
    !compatibilityId || !projectId || !roomId || !sourceStrategyVersionId || !sourceImmutableContentHash || !targetStrategyVersionId || !targetImmutableContentHash ||
    !evaluatorId || !compatibilityHash || !evidenceHash || !evaluatedAt || typeof value.state !== "string" ||
    !COMPATIBILITY_STATES.has(value.state as RoomStrategyCompatibilityStateV1) || typeof value.evaluatorKind !== "string" ||
    !COMPATIBILITY_EVALUATORS.has(value.evaluatorKind as RoomStrategyCompatibilityEvaluatorKindV1)
  ) return undefined;
  return {
    compatibilityId, projectId, roomId, sourceStrategyVersionId, sourceImmutableContentHash, targetStrategyVersionId, targetImmutableContentHash,
    state: value.state as RoomStrategyCompatibilityStateV1,
    evaluatorKind: value.evaluatorKind as RoomStrategyCompatibilityEvaluatorKindV1,
    evaluatorId, compatibilityHash, evidenceHash, evaluatedAt,
  };
}

function parseAuthorization(
  value: unknown,
  issues: RoomStrategyVersionPinningIssueV1[],
): RoomStrategyUpgradeAuthorizationV1 | undefined {
  const path = "$.authorization";
  const keys = [
    "authorizationId", "projectId", "roomId", "sourceStrategyVersionId", "sourceImmutableContentHash", "targetStrategyVersionId", "targetImmutableContentHash",
    "granted", "authorityKind", "authorityId", "issuedAt", "expiresAt", "evidenceHash",
  ];
  if (!isRecord(value) || !hasExactKeys(value, keys)) {
    issue(issues, "authorization_required", path, "authorization must have the exact v1 shape");
    return undefined;
  }
  const authorizationId = parseIdentifier(value.authorizationId, `${path}.authorizationId`, issues);
  const projectId = parseIdentifier(value.projectId, `${path}.projectId`, issues);
  const roomId = parseIdentifier(value.roomId, `${path}.roomId`, issues);
  const sourceStrategyVersionId = parseIdentifier(value.sourceStrategyVersionId, `${path}.sourceStrategyVersionId`, issues);
  const sourceImmutableContentHash = parseHash(value.sourceImmutableContentHash, `${path}.sourceImmutableContentHash`, issues);
  const targetStrategyVersionId = parseIdentifier(value.targetStrategyVersionId, `${path}.targetStrategyVersionId`, issues);
  const targetImmutableContentHash = parseHash(value.targetImmutableContentHash, `${path}.targetImmutableContentHash`, issues);
  const authorityId = parseIdentifier(value.authorityId, `${path}.authorityId`, issues);
  const issuedAt = parseTimestamp(value.issuedAt, `${path}.issuedAt`, issues);
  const expiresAt = parseTimestamp(value.expiresAt, `${path}.expiresAt`, issues);
  const evidenceHash = parseHash(value.evidenceHash, `${path}.evidenceHash`, issues);
  if (typeof value.granted !== "boolean") issue(issues, "authorization_required", `${path}.granted`, "must be an explicit boolean authorization decision");
  if (typeof value.authorityKind !== "string" || !AUTHORITY_KINDS.has(value.authorityKind as RoomStrategyUpgradeAuthorityKindV1)) {
    issue(issues, "authorization_required", `${path}.authorityKind`, "must name a supported authority kind");
  }
  if (
    !authorizationId || !projectId || !roomId || !sourceStrategyVersionId || !sourceImmutableContentHash || !targetStrategyVersionId ||
    !targetImmutableContentHash || !authorityId || !issuedAt || !expiresAt || !evidenceHash || typeof value.granted !== "boolean" ||
    typeof value.authorityKind !== "string" || !AUTHORITY_KINDS.has(value.authorityKind as RoomStrategyUpgradeAuthorityKindV1)
  ) return undefined;
  return {
    authorizationId, projectId, roomId, sourceStrategyVersionId, sourceImmutableContentHash, targetStrategyVersionId, targetImmutableContentHash,
    granted: value.granted,
    authorityKind: value.authorityKind as RoomStrategyUpgradeAuthorityKindV1,
    authorityId, issuedAt, expiresAt, evidenceHash,
  };
}

function parseEvidenceCollection(
  value: unknown,
  issues: RoomStrategyVersionPinningIssueV1[],
): readonly RoomStrategyUpgradeIndependentEvidenceV1[] | undefined {
  if (!Array.isArray(value)) {
    issue(issues, "invalid_input", "$.independentEvidence", "must be an array");
    return undefined;
  }
  const parsed: RoomStrategyUpgradeIndependentEvidenceV1[] = [];
  for (const [index, entry] of value.entries()) {
    const path = `$.independentEvidence[${index}]`;
    const keys = ["evidenceId", "projectId", "roomId", "strategyVersionId", "kind", "sourceKind", "sourceId", "observedAt", "evidenceHash"];
    if (!isRecord(entry) || !hasExactKeys(entry, keys)) {
      issue(issues, "invalid_input", path, "evidence must have the exact v1 shape");
      continue;
    }
    const evidenceId = parseIdentifier(entry.evidenceId, `${path}.evidenceId`, issues);
    const projectId = parseIdentifier(entry.projectId, `${path}.projectId`, issues);
    const roomId = parseIdentifier(entry.roomId, `${path}.roomId`, issues);
    const strategyVersionId = parseIdentifier(entry.strategyVersionId, `${path}.strategyVersionId`, issues);
    const sourceId = parseIdentifier(entry.sourceId, `${path}.sourceId`, issues);
    const observedAt = parseTimestamp(entry.observedAt, `${path}.observedAt`, issues);
    const evidenceHash = parseHash(entry.evidenceHash, `${path}.evidenceHash`, issues);
    if (typeof entry.kind !== "string" || !EVIDENCE_KINDS.has(entry.kind as RoomStrategyUpgradeEvidenceKindV1)) {
      issue(issues, "invalid_input", `${path}.kind`, "must name a supported strategy upgrade evidence kind");
    }
    if (typeof entry.sourceKind !== "string" || !EVIDENCE_SOURCES.has(entry.sourceKind as RoomStrategyUpgradeEvidenceSourceKindV1)) {
      issue(issues, "invalid_input", `${path}.sourceKind`, "must name a supported strategy upgrade evidence source");
    }
    if (
      !evidenceId || !projectId || !roomId || !strategyVersionId || !sourceId || !observedAt || !evidenceHash || typeof entry.kind !== "string" ||
      !EVIDENCE_KINDS.has(entry.kind as RoomStrategyUpgradeEvidenceKindV1) || typeof entry.sourceKind !== "string" ||
      !EVIDENCE_SOURCES.has(entry.sourceKind as RoomStrategyUpgradeEvidenceSourceKindV1)
    ) continue;
    parsed.push({
      evidenceId, projectId, roomId, strategyVersionId,
      kind: entry.kind as RoomStrategyUpgradeEvidenceKindV1,
      sourceKind: entry.sourceKind as RoomStrategyUpgradeEvidenceSourceKindV1,
      sourceId, observedAt, evidenceHash,
    });
  }
  const ids = parsed.map((entry) => entry.evidenceId).sort(compareText);
  if (new Set(ids).size !== ids.length) issue(issues, "invalid_input", "$.independentEvidence", "evidence identities must be unique");
  return parsed;
}

function validateRoomAndCurrentPin(
  room: RoomStrategyRuntimeSnapshotV1,
  pin: RoomStrategyVersionPinV1,
  request: RoomStrategyUpgradeRequestV1,
  issues: RoomStrategyVersionPinningIssueV1[],
): void {
  if (pin.projectId !== room.projectId || pin.roomId !== room.roomId || pin.strategy.projectId !== room.projectId) {
    issue(issues, "scope_mismatch", "$.currentPin", "the current strategy pin and strategy must belong to the runtime Room project and Room");
  }
  if (request.projectId !== room.projectId || request.roomId !== room.roomId) {
    issue(issues, "scope_mismatch", "$.request", "upgrade request must belong to the runtime Room project and Room");
  }
  if (pin.aggregateVersion !== room.aggregateVersion) {
    issue(issues, "stale_version_conflict", "$.currentPin.aggregateVersion", "current pin aggregate version must match the runtime Room aggregate version");
  }
  if (request.expectedPinVersion !== pin.pinVersion || request.expectedAggregateVersion !== room.aggregateVersion) {
    issue(issues, "stale_version_conflict", "$.request", "request expected pin and aggregate versions must exactly match the live Room pin");
  }
  if (pin.strategy.promotionState !== "promoted" || pin.strategy.promotionDecisionId === null || pin.strategy.promotedAt === null) {
    issue(issues, "current_pin_not_promoted", "$.currentPin.strategy", "a running Room may only retain a promoted immutable strategy pin");
  }
}

function validateTurnBoundary(
  room: RoomStrategyRuntimeSnapshotV1,
  boundary: RoomStrategySettledTurnBoundaryV1,
  asOf: string,
  issues: RoomStrategyVersionPinningIssueV1[],
): void {
  if (room.activeTurnId !== null) issue(issues, "turn_boundary_required", "$.room.activeTurnId", "a strategy upgrade cannot start while the Room has an active turn");
  if (boundary.projectId !== room.projectId || boundary.roomId !== room.roomId) {
    issue(issues, "scope_mismatch", "$.turnBoundary", "turn boundary must belong to the runtime Room project and Room");
  }
  if (boundary.aggregateVersion !== room.aggregateVersion) {
    issue(issues, "stale_version_conflict", "$.turnBoundary.aggregateVersion", "turn boundary aggregate version must match the runtime Room aggregate version");
  }
  if (Date.parse(boundary.settledAt) > Date.parse(asOf)) {
    issue(issues, "turn_boundary_required", "$.turnBoundary.settledAt", "turn boundary cannot be recorded after the upgrade decision time");
  }
}

function validateTargetAndRollback(
  currentPin: RoomStrategyVersionPinV1,
  request: RoomStrategyUpgradeRequestV1,
  issues: RoomStrategyVersionPinningIssueV1[],
): void {
  const current = currentPin.strategy;
  const target = request.targetStrategy;
  if (target.projectId !== currentPin.projectId) issue(issues, "scope_mismatch", "$.request.targetStrategy.projectId", "target strategy must belong to the Room project");
  if (target.promotionState !== "promoted" || target.promotionDecisionId === null || target.promotedAt === null) {
    issue(issues, "target_not_promoted", "$.request.targetStrategy", "upgrade target must be an already promoted immutable strategy");
  }
  if (target.strategyVersionId === current.strategyVersionId || target.immutableContentHash === current.immutableContentHash) {
    issue(issues, "target_identity_conflict", "$.request.targetStrategy", "upgrade target must be a distinct immutable strategy version and content hash");
  }
  const rollback = request.rollbackTarget;
  if (
    rollback.promotionState !== "promoted" ||
    rollback.promotionDecisionId === null ||
    rollback.promotedAt === null ||
    rollback.strategyVersionId !== current.strategyVersionId ||
    rollback.immutableContentHash !== current.immutableContentHash ||
    rollback.promotionDecisionId !== current.promotionDecisionId
  ) {
    issue(issues, "rollback_target_required", "$.request.rollbackTarget", "rollback target must exactly name the current promoted immutable strategy pin");
  }
}

function validateCompatibility(
  room: RoomStrategyRuntimeSnapshotV1,
  currentPin: RoomStrategyVersionPinV1,
  request: RoomStrategyUpgradeRequestV1,
  compatibility: RoomStrategyCompatibilityContractV1,
  issues: RoomStrategyVersionPinningIssueV1[],
): void {
  const current = currentPin.strategy;
  const target = request.targetStrategy;
  if (compatibility.projectId !== room.projectId || compatibility.roomId !== room.roomId) {
    issue(issues, "scope_mismatch", "$.compatibility", "compatibility contract must bind the same project and Room");
  }
  if (
    compatibility.sourceStrategyVersionId !== current.strategyVersionId ||
    compatibility.sourceImmutableContentHash !== current.immutableContentHash ||
    compatibility.targetStrategyVersionId !== target.strategyVersionId ||
    compatibility.targetImmutableContentHash !== target.immutableContentHash
  ) {
    issue(issues, "compatibility_mismatch", "$.compatibility", "compatibility contract must bind both exact immutable source and target strategy versions");
  }
  if (compatibility.state !== "compatible") {
    issue(issues, "incompatible_target", "$.compatibility.state", "target strategy must have an explicit compatible migration contract");
  }
  if (compatibility.evaluatorKind === "model_self_report" || compatibility.evaluatorId === target.producerActorId) {
    issue(issues, "self_authorization_forbidden", "$.compatibility", "candidate producer or model self-report cannot certify target compatibility");
  }
}

function validateAuthorization(
  room: RoomStrategyRuntimeSnapshotV1,
  currentPin: RoomStrategyVersionPinV1,
  request: RoomStrategyUpgradeRequestV1,
  authorization: RoomStrategyUpgradeAuthorizationV1,
  asOf: string,
  issues: RoomStrategyVersionPinningIssueV1[],
): void {
  const current = currentPin.strategy;
  const target = request.targetStrategy;
  if (
    authorization.projectId !== room.projectId || authorization.roomId !== room.roomId ||
    authorization.sourceStrategyVersionId !== current.strategyVersionId || authorization.sourceImmutableContentHash !== current.immutableContentHash ||
    authorization.targetStrategyVersionId !== target.strategyVersionId || authorization.targetImmutableContentHash !== target.immutableContentHash
  ) {
    issue(issues, "scope_mismatch", "$.authorization", "authorization must bind the same project, Room, and exact source and target strategies");
  }
  if (!authorization.granted) issue(issues, "authorization_required", "$.authorization.granted", "upgrade requires an explicit granted authorization");
  if (authorization.authorityKind === "model_self_report" || authorization.authorityId === target.producerActorId || authorization.authorityId === current.producerActorId) {
    issue(issues, "self_authorization_forbidden", "$.authorization", "a producer or model self-report cannot authorize its own strategy upgrade");
  }
  const issuedAt = Date.parse(authorization.issuedAt);
  const expiresAt = Date.parse(authorization.expiresAt);
  const decisionAt = Date.parse(asOf);
  if (issuedAt > decisionAt || expiresAt <= decisionAt || expiresAt <= issuedAt) {
    issue(issues, "authorization_expired", "$.authorization", "authorization must be active at the strategy upgrade decision time");
  }
}

function validateEvidence(
  room: RoomStrategyRuntimeSnapshotV1,
  currentPin: RoomStrategyVersionPinV1,
  request: RoomStrategyUpgradeRequestV1,
  evidence: readonly RoomStrategyUpgradeIndependentEvidenceV1[],
  asOf: string,
  issues: RoomStrategyVersionPinningIssueV1[],
): void {
  const target = request.targetStrategy;
  const current = currentPin.strategy;
  for (const [index, entry] of evidence.entries()) {
    const path = `$.independentEvidence[${index}]`;
    if (entry.projectId !== room.projectId || entry.roomId !== room.roomId) {
      issue(issues, "scope_mismatch", path, "evidence must belong to the same project and Room");
    }
    if (entry.sourceKind === "model_self_report") {
      issue(issues, "untrusted_evidence_source", `${path}.sourceKind`, "model self-report cannot authorize or verify a strategy upgrade");
    }
    if (entry.sourceId === target.producerActorId || entry.sourceId === current.producerActorId) {
      issue(issues, "evidence_not_independent", `${path}.sourceId`, "strategy producer evidence cannot independently verify this upgrade");
    }
    if (Date.parse(entry.observedAt) > Date.parse(asOf)) {
      issue(issues, "missing_independent_evidence", `${path}.observedAt`, "evidence cannot be observed after the strategy upgrade decision time");
    }
  }
  const requirements: readonly {
    readonly kind: RoomStrategyUpgradeEvidenceKindV1;
    readonly strategyVersionId: string;
    readonly allowedSources: readonly Exclude<RoomStrategyUpgradeEvidenceSourceKindV1, "model_self_report">[];
  }[] = [
    { kind: "promotion", strategyVersionId: target.strategyVersionId, allowedSources: ["durable_evolution_ledger"] },
    { kind: "compatibility", strategyVersionId: target.strategyVersionId, allowedSources: ["deterministic_gate", "independent_evaluator"] },
    { kind: "rollback", strategyVersionId: current.strategyVersionId, allowedSources: ["deterministic_gate", "independent_evaluator", "human_operator"] },
  ];
  for (const requirement of requirements) {
    const matches = evidence.some((entry) =>
      entry.kind === requirement.kind &&
      entry.strategyVersionId === requirement.strategyVersionId &&
      requirement.allowedSources.includes(entry.sourceKind as Exclude<RoomStrategyUpgradeEvidenceSourceKindV1, "model_self_report">),
    );
    if (!matches) {
      issue(issues, "missing_independent_evidence", "$.independentEvidence", `missing independent ${requirement.kind} evidence for ${requirement.strategyVersionId}`);
    }
  }
}

function buildRecord(
  asOf: string,
  currentPin: RoomStrategyVersionPinV1,
  request: RoomStrategyUpgradeRequestV1,
  boundary: RoomStrategySettledTurnBoundaryV1,
  compatibility: RoomStrategyCompatibilityContractV1,
  authorization: RoomStrategyUpgradeAuthorizationV1,
  evidence: readonly RoomStrategyUpgradeIndependentEvidenceV1[],
): RoomStrategyVersionUpgradeRecordV1 {
  const evidenceRecords = [...evidence]
    .sort((left, right) => compareText(left.evidenceId, right.evidenceId))
    .map((entry) => ({
      evidenceId: entry.evidenceId,
      strategyVersionId: entry.strategyVersionId,
      kind: entry.kind,
      sourceKind: entry.sourceKind as Exclude<RoomStrategyUpgradeEvidenceSourceKindV1, "model_self_report">,
      sourceId: entry.sourceId,
      observedAt: entry.observedAt,
      evidenceHash: entry.evidenceHash,
    }));
  const evidenceHash = hashRoomValue(evidenceRecords);
  const current = currentPin.strategy;
  const target = request.targetStrategy;
  const body = {
    contractVersion: ROOM_STRATEGY_VERSION_PINNING_CONTRACT_VERSION,
    upgradeId: request.upgradeId,
    projectId: request.projectId,
    roomId: request.roomId,
    sourcePinVersion: currentPin.pinVersion,
    sourceAggregateVersion: currentPin.aggregateVersion,
    sourceStrategyVersionId: current.strategyVersionId,
    sourceImmutableContentHash: current.immutableContentHash,
    targetStrategyVersionId: target.strategyVersionId,
    targetImmutableContentHash: target.immutableContentHash,
    targetPromotionDecisionId: target.promotionDecisionId!,
    expectedPinVersion: request.expectedPinVersion,
    expectedAggregateVersion: request.expectedAggregateVersion,
    activation: {
      kind: "after_settled_turn" as const,
      settledTurnId: boundary.settledTurnId,
      settledTurnState: boundary.state,
      settledAt: boundary.settledAt,
    },
    compatibility: {
      compatibilityId: compatibility.compatibilityId,
      compatibilityHash: compatibility.compatibilityHash,
      evidenceHash: compatibility.evidenceHash,
      evaluatorKind: compatibility.evaluatorKind as "deterministic_migration_gate" | "independent_evaluator",
      evaluatorId: compatibility.evaluatorId,
    },
    authorization: {
      authorizationId: authorization.authorizationId,
      authorityKind: authorization.authorityKind as "human_operator" | "independent_authorizer",
      authorityId: authorization.authorityId,
      evidenceHash: authorization.evidenceHash,
    },
    evidence: evidenceRecords,
    evidenceHash,
    rollbackTarget: {
      strategyVersionId: current.strategyVersionId,
      immutableContentHash: current.immutableContentHash,
      promotionDecisionId: current.promotionDecisionId!,
    },
    requestedAt: request.requestedAt,
    recordedAt: asOf,
  };
  const recordHash = hashRoomValue(body);
  const recordId = `room-strategy-upgrade:${recordHash.slice("sha256:".length, "sha256:".length + 32)}`;
  return deepFreeze({ ...body, recordId, recordHash });
}

function isExactAppendAcknowledgement(
  value: unknown,
  record: RoomStrategyVersionUpgradeRecordV1,
): value is RoomStrategyVersionUpgradeAppendAckV1 {
  return isRecord(value) && hasExactKeys(value, ["status", "recordId", "recordHash"]) &&
    value.status === "recorded" && value.recordId === record.recordId && value.recordHash === record.recordHash;
}
