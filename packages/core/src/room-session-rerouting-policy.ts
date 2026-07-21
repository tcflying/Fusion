import {
  evaluateRoomBindingCapability,
  type RoomBindingCapabilitySnapshotV1,
  type RoomCapabilityRoutingPolicyV1,
} from "./room-capability-registry.js";
import type { ProjectId, RoomBindingId, RoomId, RoomSeatId, RoomTurnId } from "./room-contracts/ids.js";
import { hashRoomValue } from "./room-integrity.js";

export const ROOM_SESSION_REROUTING_POLICY_CONTRACT_VERSION = 1 as const;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const HASH = /^sha256:[a-f0-9]{64}$/u;
const AUTHORITY_KINDS = new Set(["human_operator", "independent_authorizer"]);
const EVIDENCE_KINDS = new Set(["causation", "capability", "health", "quality"]);
const EVIDENCE_SOURCE_KINDS = new Set([
  "connector_probe",
  "deterministic_gate",
  "independent_evaluator",
  "human_operator",
]);
const RESERVATION_STATES = new Set(["pending", "active", "released", "rolled_back"]);

export interface RoomSessionRerouteBindingV1 {
  readonly bindingId: RoomBindingId;
  readonly bindingGeneration: number;
  readonly providerId: string;
  readonly accountId: string;
  readonly modelId: string;
  readonly connectorId: string;
  readonly nativeSessionId: string;
  readonly hostId: string;
}

export interface RoomSessionRerouteCausationV1 {
  readonly incidentId: string;
  readonly reason: string;
  readonly evidenceId: string;
  readonly observedAt: string;
}

export interface RoomSessionRerouteTurnBoundaryV1 {
  readonly settledTurnId: RoomTurnId;
  readonly state: "settled";
  readonly settledAt: string;
  readonly activeTurnId: null;
}

export interface RoomSessionRerouteRequestV1 {
  readonly rerouteId: string;
  readonly projectId: ProjectId;
  readonly roomId: RoomId;
  readonly seatId: RoomSeatId;
  readonly requestedAt: string;
  readonly source: RoomSessionRerouteBindingV1;
  readonly replacement: RoomSessionRerouteBindingV1;
  readonly turnBoundary: RoomSessionRerouteTurnBoundaryV1;
  readonly causation: RoomSessionRerouteCausationV1;
}

export interface RoomSessionRerouteAuthorizationV1 {
  readonly authorizationId: string;
  readonly projectId: ProjectId;
  readonly roomId: RoomId;
  readonly sourceBindingId: RoomBindingId;
  readonly replacementBindingId: RoomBindingId;
  readonly granted: true;
  readonly authorityKind: "human_operator" | "independent_authorizer";
  readonly authorityId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly evidenceHash: string;
}

export type RoomSessionRerouteEvidenceKindV1 = "causation" | "capability" | "health" | "quality";
export type RoomSessionRerouteEvidenceSourceKindV1 =
  | "connector_probe"
  | "deterministic_gate"
  | "independent_evaluator"
  | "human_operator";

export interface RoomSessionRerouteIndependentEvidenceV1 {
  readonly evidenceId: string;
  readonly projectId: ProjectId;
  readonly roomId: RoomId;
  readonly subjectBindingId: RoomBindingId;
  readonly kind: RoomSessionRerouteEvidenceKindV1;
  readonly sourceKind: RoomSessionRerouteEvidenceSourceKindV1;
  readonly sourceId: string;
  readonly observedAt: string;
  readonly evidenceHash: string;
}

export interface RoomSessionRerouteEvidenceFreshnessV1 {
  readonly maximumAgeMs: number;
  readonly maximumFutureSkewMs: number;
}

export interface RoomSessionRerouteReservationV1 {
  readonly reservationId: string;
  readonly projectId: ProjectId;
  readonly roomId: RoomId;
  readonly replacementBindingId: RoomBindingId;
  readonly providerId: string;
  readonly nativeSessionId: string;
  readonly state: "pending" | "active" | "released" | "rolled_back";
}

export interface EvaluateRoomSessionReroutingPolicyInputV1 {
  readonly contractVersion: typeof ROOM_SESSION_REROUTING_POLICY_CONTRACT_VERSION;
  readonly asOf: string;
  readonly request: RoomSessionRerouteRequestV1;
  readonly authorization: RoomSessionRerouteAuthorizationV1;
  readonly replacementSnapshot: RoomBindingCapabilitySnapshotV1;
  readonly replacementRoutingPolicy: RoomCapabilityRoutingPolicyV1;
  readonly independentEvidence: readonly RoomSessionRerouteIndependentEvidenceV1[];
  readonly evidenceFreshness: RoomSessionRerouteEvidenceFreshnessV1;
  readonly reservations: readonly RoomSessionRerouteReservationV1[];
}

export type RoomSessionReroutingPolicyIssueCodeV1 =
  | "invalid_input"
  | "scope_mismatch"
  | "authorization_required"
  | "authorization_expired"
  | "authorization_not_independent"
  | "native_session_identity_immutable"
  | "replacement_identity_conflict"
  | "turn_boundary_required"
  | "causation_evidence_missing"
  | "untrusted_evidence_source"
  | "evidence_not_independent"
  | "evidence_stale"
  | "missing_independent_evidence"
  | "replacement_snapshot_mismatch"
  | "replacement_capability_ineligible"
  | "replacement_concurrent";

export interface RoomSessionReroutingPolicyIssueV1 {
  readonly code: RoomSessionReroutingPolicyIssueCodeV1;
  readonly path: string;
  readonly message: string;
}

export interface RoomSessionRerouteLineageV1 {
  readonly lineageId: string;
  readonly lineageHash: string;
  readonly sourceBindingId: RoomBindingId;
  readonly replacementBindingId: RoomBindingId;
  readonly sourceIdentityHash: string;
  readonly replacementIdentityHash: string;
  readonly authorizationId: string;
  readonly causation: RoomSessionRerouteCausationV1;
  readonly evidenceIds: readonly string[];
  readonly evidenceHash: string;
  readonly rollbackTarget: RoomSessionRerouteBindingV1;
  readonly activation: {
    readonly kind: "after_settled_turn";
    readonly settledTurnId: RoomTurnId;
    readonly settledAt: string;
  };
  readonly reservation: {
    readonly reservationId: string;
    readonly replacementBindingId: RoomBindingId;
    readonly providerId: string;
    readonly nativeSessionId: string;
  };
}

export interface RoomSessionReroutePlanV1 {
  readonly rerouteId: string;
  readonly projectId: ProjectId;
  readonly roomId: RoomId;
  readonly seatId: RoomSeatId;
  readonly replacement: RoomSessionRerouteBindingV1;
  readonly lineage: RoomSessionRerouteLineageV1;
}

export type RoomSessionReroutingPolicyResultV1 =
  | { readonly ok: true; readonly value: RoomSessionReroutePlanV1 }
  | { readonly ok: false; readonly issues: readonly RoomSessionReroutingPolicyIssueV1[] };

type RuntimeRecord = Record<string, unknown>;

function isRecord(value: unknown): value is RuntimeRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: RuntimeRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((entry, index) => entry === expected[index]);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function issue(
  issues: RoomSessionReroutingPolicyIssueV1[],
  code: RoomSessionReroutingPolicyIssueCodeV1,
  path: string,
  message: string,
): void {
  issues.push({ code, path, message });
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fail(issues: readonly RoomSessionReroutingPolicyIssueV1[]): RoomSessionReroutingPolicyResultV1 {
  return deepFreeze({
    ok: false,
    issues: [...issues].sort((left, right) => {
      const path = compareText(left.path, right.path);
      return path !== 0 ? path : compareText(left.code, right.code);
    }),
  });
}

function succeed(value: RoomSessionReroutePlanV1): RoomSessionReroutingPolicyResultV1 {
  return deepFreeze({ ok: true, value });
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

function parseIdentifier(
  value: unknown,
  path: string,
  issues: RoomSessionReroutingPolicyIssueV1[],
): string | undefined {
  if (!isIdentifier(value)) {
    issue(issues, "invalid_input", path, "must be a canonical non-empty identifier");
    return undefined;
  }
  return value;
}

function parseTimestamp(
  value: unknown,
  path: string,
  issues: RoomSessionReroutingPolicyIssueV1[],
): string | undefined {
  if (!isCanonicalTimestamp(value)) {
    issue(issues, "invalid_input", path, "must be a canonical UTC timestamp");
    return undefined;
  }
  return value;
}

function parseBinding(
  value: unknown,
  path: string,
  issues: RoomSessionReroutingPolicyIssueV1[],
): RoomSessionRerouteBindingV1 | undefined {
  const keys = [
    "bindingId",
    "bindingGeneration",
    "providerId",
    "accountId",
    "modelId",
    "connectorId",
    "nativeSessionId",
    "hostId",
  ];
  if (!isRecord(value) || !hasExactKeys(value, keys)) {
    issue(issues, "invalid_input", path, "binding must have the exact v1 identity shape");
    return undefined;
  }
  const bindingId = parseIdentifier(value.bindingId, `${path}.bindingId`, issues);
  const providerId = parseIdentifier(value.providerId, `${path}.providerId`, issues);
  const accountId = parseIdentifier(value.accountId, `${path}.accountId`, issues);
  const modelId = parseIdentifier(value.modelId, `${path}.modelId`, issues);
  const connectorId = parseIdentifier(value.connectorId, `${path}.connectorId`, issues);
  const nativeSessionId = parseIdentifier(value.nativeSessionId, `${path}.nativeSessionId`, issues);
  const hostId = parseIdentifier(value.hostId, `${path}.hostId`, issues);
  if (!isPositiveSafeInteger(value.bindingGeneration)) {
    issue(issues, "invalid_input", `${path}.bindingGeneration`, "must be a positive safe integer");
  }
  if (
    !bindingId ||
    !providerId ||
    !accountId ||
    !modelId ||
    !connectorId ||
    !nativeSessionId ||
    !hostId ||
    !isPositiveSafeInteger(value.bindingGeneration)
  ) {
    return undefined;
  }
  return {
    bindingId,
    bindingGeneration: value.bindingGeneration,
    providerId,
    accountId,
    modelId,
    connectorId,
    nativeSessionId,
    hostId,
  };
}

function parseRequest(
  value: unknown,
  issues: RoomSessionReroutingPolicyIssueV1[],
): RoomSessionRerouteRequestV1 | undefined {
  const keys = [
    "rerouteId",
    "projectId",
    "roomId",
    "seatId",
    "requestedAt",
    "source",
    "replacement",
    "turnBoundary",
    "causation",
  ];
  if (!isRecord(value) || !hasExactKeys(value, keys)) {
    issue(issues, "invalid_input", "$.request", "request must have the exact v1 shape");
    return undefined;
  }
  const rerouteId = parseIdentifier(value.rerouteId, "$.request.rerouteId", issues);
  const projectId = parseIdentifier(value.projectId, "$.request.projectId", issues);
  const roomId = parseIdentifier(value.roomId, "$.request.roomId", issues);
  const seatId = parseIdentifier(value.seatId, "$.request.seatId", issues);
  const requestedAt = parseTimestamp(value.requestedAt, "$.request.requestedAt", issues);
  const source = parseBinding(value.source, "$.request.source", issues);
  const replacement = parseBinding(value.replacement, "$.request.replacement", issues);
  const turnBoundary = parseTurnBoundary(value.turnBoundary, issues);
  const causation = parseCausation(value.causation, issues);
  if (!rerouteId || !projectId || !roomId || !seatId || !requestedAt || !source || !replacement || !turnBoundary || !causation) {
    return undefined;
  }
  return {
    rerouteId,
    projectId,
    roomId,
    seatId,
    requestedAt,
    source,
    replacement,
    turnBoundary,
    causation,
  };
}

function parseTurnBoundary(
  value: unknown,
  issues: RoomSessionReroutingPolicyIssueV1[],
): RoomSessionRerouteTurnBoundaryV1 | undefined {
  const keys = ["settledTurnId", "state", "settledAt", "activeTurnId"];
  if (!isRecord(value) || !hasExactKeys(value, keys)) {
    issue(issues, "turn_boundary_required", "$.request.turnBoundary", "rerouting must name a settled turn boundary");
    return undefined;
  }
  const settledTurnId = parseIdentifier(value.settledTurnId, "$.request.turnBoundary.settledTurnId", issues);
  const settledAt = parseTimestamp(value.settledAt, "$.request.turnBoundary.settledAt", issues);
  if (value.state !== "settled") {
    issue(issues, "turn_boundary_required", "$.request.turnBoundary.state", "rerouting is permitted only after a settled turn");
  }
  if (value.activeTurnId !== null) {
    issue(issues, "turn_boundary_required", "$.request.turnBoundary.activeTurnId", "rerouting cannot cross an active turn");
  }
  if (!settledTurnId || !settledAt || value.state !== "settled" || value.activeTurnId !== null) return undefined;
  return { settledTurnId, state: "settled", settledAt, activeTurnId: null };
}

function parseCausation(
  value: unknown,
  issues: RoomSessionReroutingPolicyIssueV1[],
): RoomSessionRerouteCausationV1 | undefined {
  const keys = ["incidentId", "reason", "evidenceId", "observedAt"];
  if (!isRecord(value) || !hasExactKeys(value, keys)) {
    issue(issues, "invalid_input", "$.request.causation", "causation must have the exact v1 shape");
    return undefined;
  }
  const incidentId = parseIdentifier(value.incidentId, "$.request.causation.incidentId", issues);
  const reason = parseIdentifier(value.reason, "$.request.causation.reason", issues);
  const evidenceId = parseIdentifier(value.evidenceId, "$.request.causation.evidenceId", issues);
  const observedAt = parseTimestamp(value.observedAt, "$.request.causation.observedAt", issues);
  if (!incidentId || !reason || !evidenceId || !observedAt) return undefined;
  return { incidentId, reason, evidenceId, observedAt };
}

function parseAuthorization(
  value: unknown,
  issues: RoomSessionReroutingPolicyIssueV1[],
): RoomSessionRerouteAuthorizationV1 | undefined {
  const keys = [
    "authorizationId",
    "projectId",
    "roomId",
    "sourceBindingId",
    "replacementBindingId",
    "granted",
    "authorityKind",
    "authorityId",
    "issuedAt",
    "expiresAt",
    "evidenceHash",
  ];
  if (!isRecord(value) || !hasExactKeys(value, keys)) {
    issue(issues, "authorization_required", "$.authorization", "authorization must have the exact v1 shape");
    return undefined;
  }
  const authorizationId = parseIdentifier(value.authorizationId, "$.authorization.authorizationId", issues);
  const projectId = parseIdentifier(value.projectId, "$.authorization.projectId", issues);
  const roomId = parseIdentifier(value.roomId, "$.authorization.roomId", issues);
  const sourceBindingId = parseIdentifier(value.sourceBindingId, "$.authorization.sourceBindingId", issues);
  const replacementBindingId = parseIdentifier(value.replacementBindingId, "$.authorization.replacementBindingId", issues);
  const authorityId = parseIdentifier(value.authorityId, "$.authorization.authorityId", issues);
  const issuedAt = parseTimestamp(value.issuedAt, "$.authorization.issuedAt", issues);
  const expiresAt = parseTimestamp(value.expiresAt, "$.authorization.expiresAt", issues);
  if (value.granted !== true) {
    issue(issues, "authorization_required", "$.authorization.granted", "rerouting requires an explicit granted authorization");
  }
  if (typeof value.authorityKind !== "string" || !AUTHORITY_KINDS.has(value.authorityKind)) {
    issue(issues, "authorization_not_independent", "$.authorization.authorityKind", "provider and model identities cannot authorize rerouting");
  }
  if (typeof value.evidenceHash !== "string" || !HASH.test(value.evidenceHash)) {
    issue(issues, "authorization_required", "$.authorization.evidenceHash", "authorization requires a canonical evidence hash");
  }
  if (
    !authorizationId ||
    !projectId ||
    !roomId ||
    !sourceBindingId ||
    !replacementBindingId ||
    !authorityId ||
    !issuedAt ||
    !expiresAt ||
    value.granted !== true ||
    typeof value.authorityKind !== "string" ||
    !AUTHORITY_KINDS.has(value.authorityKind) ||
    typeof value.evidenceHash !== "string" ||
    !HASH.test(value.evidenceHash)
  ) {
    return undefined;
  }
  return {
    authorizationId,
    projectId,
    roomId,
    sourceBindingId,
    replacementBindingId,
    granted: true,
    authorityKind: value.authorityKind as RoomSessionRerouteAuthorizationV1["authorityKind"],
    authorityId,
    issuedAt,
    expiresAt,
    evidenceHash: value.evidenceHash,
  };
}

function parseEvidenceFreshness(
  value: unknown,
  issues: RoomSessionReroutingPolicyIssueV1[],
): RoomSessionRerouteEvidenceFreshnessV1 | undefined {
  const keys = ["maximumAgeMs", "maximumFutureSkewMs"];
  if (!isRecord(value) || !hasExactKeys(value, keys)) {
    issue(issues, "invalid_input", "$.evidenceFreshness", "evidence freshness must have the exact v1 shape");
    return undefined;
  }
  if (!isPositiveSafeInteger(value.maximumAgeMs)) {
    issue(issues, "invalid_input", "$.evidenceFreshness.maximumAgeMs", "must be a positive safe integer");
  }
  if (!isNonNegativeSafeInteger(value.maximumFutureSkewMs)) {
    issue(issues, "invalid_input", "$.evidenceFreshness.maximumFutureSkewMs", "must be a non-negative safe integer");
  }
  if (!isPositiveSafeInteger(value.maximumAgeMs) || !isNonNegativeSafeInteger(value.maximumFutureSkewMs)) {
    return undefined;
  }
  return { maximumAgeMs: value.maximumAgeMs, maximumFutureSkewMs: value.maximumFutureSkewMs };
}

function parseEvidence(
  value: unknown,
  index: number,
  issues: RoomSessionReroutingPolicyIssueV1[],
): RoomSessionRerouteIndependentEvidenceV1 | undefined {
  const path = `$.independentEvidence[${index}]`;
  const keys = [
    "evidenceId",
    "projectId",
    "roomId",
    "subjectBindingId",
    "kind",
    "sourceKind",
    "sourceId",
    "observedAt",
    "evidenceHash",
  ];
  if (!isRecord(value) || !hasExactKeys(value, keys)) {
    issue(issues, "invalid_input", path, "independent evidence must have the exact v1 shape");
    return undefined;
  }
  const evidenceId = parseIdentifier(value.evidenceId, `${path}.evidenceId`, issues);
  const projectId = parseIdentifier(value.projectId, `${path}.projectId`, issues);
  const roomId = parseIdentifier(value.roomId, `${path}.roomId`, issues);
  const subjectBindingId = parseIdentifier(value.subjectBindingId, `${path}.subjectBindingId`, issues);
  const sourceId = parseIdentifier(value.sourceId, `${path}.sourceId`, issues);
  const observedAt = parseTimestamp(value.observedAt, `${path}.observedAt`, issues);
  if (typeof value.kind !== "string" || !EVIDENCE_KINDS.has(value.kind)) {
    issue(issues, "invalid_input", `${path}.kind`, "must name a supported rerouting evidence kind");
  }
  if (typeof value.sourceKind !== "string" || !EVIDENCE_SOURCE_KINDS.has(value.sourceKind)) {
    issue(issues, "untrusted_evidence_source", `${path}.sourceKind`, "provider or model self-report is not independent evidence");
  }
  if (typeof value.evidenceHash !== "string" || !HASH.test(value.evidenceHash)) {
    issue(issues, "invalid_input", `${path}.evidenceHash`, "must be a canonical SHA-256 hash");
  }
  if (
    !evidenceId ||
    !projectId ||
    !roomId ||
    !subjectBindingId ||
    !sourceId ||
    !observedAt ||
    typeof value.kind !== "string" ||
    !EVIDENCE_KINDS.has(value.kind) ||
    typeof value.sourceKind !== "string" ||
    !EVIDENCE_SOURCE_KINDS.has(value.sourceKind) ||
    typeof value.evidenceHash !== "string" ||
    !HASH.test(value.evidenceHash)
  ) {
    return undefined;
  }
  return {
    evidenceId,
    projectId,
    roomId,
    subjectBindingId,
    kind: value.kind as RoomSessionRerouteEvidenceKindV1,
    sourceKind: value.sourceKind as RoomSessionRerouteEvidenceSourceKindV1,
    sourceId,
    observedAt,
    evidenceHash: value.evidenceHash,
  };
}

function parseReservations(
  value: unknown,
  issues: RoomSessionReroutingPolicyIssueV1[],
): readonly RoomSessionRerouteReservationV1[] | undefined {
  if (!Array.isArray(value)) {
    issue(issues, "invalid_input", "$.reservations", "reservations must be an array");
    return undefined;
  }
  const parsed: RoomSessionRerouteReservationV1[] = [];
  for (const [index, entry] of value.entries()) {
    const path = `$.reservations[${index}]`;
    const keys = [
      "reservationId",
      "projectId",
      "roomId",
      "replacementBindingId",
      "providerId",
      "nativeSessionId",
      "state",
    ];
    if (!isRecord(entry) || !hasExactKeys(entry, keys)) {
      issue(issues, "invalid_input", path, "reservation must have the exact v1 shape");
      continue;
    }
    const reservationId = parseIdentifier(entry.reservationId, `${path}.reservationId`, issues);
    const projectId = parseIdentifier(entry.projectId, `${path}.projectId`, issues);
    const roomId = parseIdentifier(entry.roomId, `${path}.roomId`, issues);
    const replacementBindingId = parseIdentifier(entry.replacementBindingId, `${path}.replacementBindingId`, issues);
    const providerId = parseIdentifier(entry.providerId, `${path}.providerId`, issues);
    const nativeSessionId = parseIdentifier(entry.nativeSessionId, `${path}.nativeSessionId`, issues);
    if (typeof entry.state !== "string" || !RESERVATION_STATES.has(entry.state)) {
      issue(issues, "invalid_input", `${path}.state`, "must name a supported reservation state");
    }
    if (
      !reservationId ||
      !projectId ||
      !roomId ||
      !replacementBindingId ||
      !providerId ||
      !nativeSessionId ||
      typeof entry.state !== "string" ||
      !RESERVATION_STATES.has(entry.state)
    ) {
      continue;
    }
    parsed.push({
      reservationId,
      projectId,
      roomId,
      replacementBindingId,
      providerId,
      nativeSessionId,
      state: entry.state as RoomSessionRerouteReservationV1["state"],
    });
  }
  const ids = parsed.map((entry) => entry.reservationId).sort(compareText);
  if (new Set(ids).size !== ids.length) {
    issue(issues, "invalid_input", "$.reservations", "reservation identities must be unique");
  }
  return parsed;
}

function matchesBindingSnapshot(
  replacement: RoomSessionRerouteBindingV1,
  snapshot: RoomBindingCapabilitySnapshotV1,
): boolean {
  const lineage = snapshot.lineage;
  return (
    lineage.bindingId === replacement.bindingId &&
    lineage.bindingGeneration === replacement.bindingGeneration &&
    lineage.providerId === replacement.providerId &&
    lineage.accountId === replacement.accountId &&
    lineage.modelId === replacement.modelId &&
    lineage.connectorId === replacement.connectorId &&
    lineage.nativeSessionId === replacement.nativeSessionId &&
    lineage.hostId === replacement.hostId
  );
}

function isEvidenceFresh(
  evidence: RoomSessionRerouteIndependentEvidenceV1,
  asOf: string,
  freshness: RoomSessionRerouteEvidenceFreshnessV1,
): boolean {
  const observedAt = Date.parse(evidence.observedAt);
  const decisionAt = Date.parse(asOf);
  return observedAt <= decisionAt + freshness.maximumFutureSkewMs && decisionAt - observedAt <= freshness.maximumAgeMs;
}

function validateAuthorization(
  request: RoomSessionRerouteRequestV1,
  authorization: RoomSessionRerouteAuthorizationV1,
  asOf: string,
  issues: RoomSessionReroutingPolicyIssueV1[],
): void {
  if (
    authorization.projectId !== request.projectId ||
    authorization.roomId !== request.roomId ||
    authorization.sourceBindingId !== request.source.bindingId ||
    authorization.replacementBindingId !== request.replacement.bindingId
  ) {
    issue(issues, "scope_mismatch", "$.authorization", "authorization must bind this project, Room, source, and replacement");
  }
  if (authorization.authorityId === request.source.bindingId || authorization.authorityId === request.replacement.bindingId) {
    issue(issues, "authorization_not_independent", "$.authorization.authorityId", "a source or replacement binding cannot authorize itself");
  }
  const issuedAt = Date.parse(authorization.issuedAt);
  const expiresAt = Date.parse(authorization.expiresAt);
  const decisionAt = Date.parse(asOf);
  if (issuedAt > decisionAt || expiresAt <= decisionAt || expiresAt <= issuedAt) {
    issue(issues, "authorization_expired", "$.authorization", "authorization must be active at the decision time");
  }
}

function validateEvidence(
  request: RoomSessionRerouteRequestV1,
  evidence: readonly RoomSessionRerouteIndependentEvidenceV1[],
  asOf: string,
  freshness: RoomSessionRerouteEvidenceFreshnessV1,
  issues: RoomSessionReroutingPolicyIssueV1[],
): void {
  const ids = evidence.map((entry) => entry.evidenceId).sort(compareText);
  if (new Set(ids).size !== ids.length) {
    issue(issues, "invalid_input", "$.independentEvidence", "evidence identities must be unique");
  }
  for (const [index, entry] of evidence.entries()) {
    const path = `$.independentEvidence[${index}]`;
    if (entry.projectId !== request.projectId || entry.roomId !== request.roomId) {
      issue(issues, "scope_mismatch", path, "evidence must belong to the reroute project and Room");
    }
    if (entry.sourceId === request.source.bindingId || entry.sourceId === request.replacement.bindingId) {
      issue(issues, "evidence_not_independent", `${path}.sourceId`, "a source or replacement binding cannot certify itself");
    }
    if (!isEvidenceFresh(entry, asOf, freshness)) {
      issue(issues, "evidence_stale", `${path}.observedAt`, "evidence must be fresh at the decision time");
    }
  }
  const cause = evidence.find((entry) => entry.evidenceId === request.causation.evidenceId);
  if (!cause || cause.kind !== "causation" || cause.subjectBindingId !== request.source.bindingId) {
    issue(issues, "causation_evidence_missing", "$.request.causation.evidenceId", "causation must cite independent evidence about the source binding");
  }
  const required: Readonly<Record<"capability" | "health" | "quality", readonly RoomSessionRerouteEvidenceSourceKindV1[]>> = {
    capability: ["connector_probe", "deterministic_gate"],
    health: ["connector_probe", "deterministic_gate"],
    quality: ["independent_evaluator", "deterministic_gate"],
  };
  for (const [kind, allowedSources] of Object.entries(required) as readonly [keyof typeof required, readonly RoomSessionRerouteEvidenceSourceKindV1[]][]) {
    const matching = evidence.some((entry) =>
      entry.kind === kind &&
      entry.subjectBindingId === request.replacement.bindingId &&
      allowedSources.includes(entry.sourceKind),
    );
    if (!matching) {
      issue(issues, "missing_independent_evidence", "$.independentEvidence", `replacement requires independent ${kind} evidence`);
    }
  }
}

function validateReplacementIdentity(
  request: RoomSessionRerouteRequestV1,
  issues: RoomSessionReroutingPolicyIssueV1[],
): void {
  if (request.source.bindingId === request.replacement.bindingId) {
    issue(issues, "replacement_identity_conflict", "$.request.replacement.bindingId", "replacement binding must have a new identity");
  }
  if (request.source.nativeSessionId === request.replacement.nativeSessionId) {
    issue(
      issues,
      "native_session_identity_immutable",
      "$.request.replacement.nativeSessionId",
      "a host-bound native Session cannot be rerouted or relabeled as its own replacement",
    );
  }
}

function validateReservations(
  request: RoomSessionRerouteRequestV1,
  reservations: readonly RoomSessionRerouteReservationV1[],
  issues: RoomSessionReroutingPolicyIssueV1[],
): void {
  for (const reservation of reservations) {
    if (reservation.state === "released" || reservation.state === "rolled_back") continue;
    const sameBinding = reservation.replacementBindingId === request.replacement.bindingId;
    const sameNativeSession =
      reservation.providerId === request.replacement.providerId &&
      reservation.nativeSessionId === request.replacement.nativeSessionId;
    if (sameBinding || sameNativeSession) {
      issue(
        issues,
        "replacement_concurrent",
        "$.reservations",
        "the replacement binding or native Session is already reserved by another non-terminal reroute",
      );
    }
  }
}

function buildPlan(
  request: RoomSessionRerouteRequestV1,
  authorization: RoomSessionRerouteAuthorizationV1,
  evidence: readonly RoomSessionRerouteIndependentEvidenceV1[],
): RoomSessionReroutePlanV1 {
  const evidenceEntries = [...evidence]
    .sort((left, right) => compareText(left.evidenceId, right.evidenceId))
    .map((entry) => ({ evidenceId: entry.evidenceId, evidenceHash: entry.evidenceHash }));
  const evidenceIds = evidenceEntries.map((entry) => entry.evidenceId);
  const evidenceHash = hashRoomValue(evidenceEntries);
  const sourceIdentityHash = hashRoomValue(request.source);
  const replacementIdentityHash = hashRoomValue(request.replacement);
  const lineageHash = hashRoomValue({
    rerouteId: request.rerouteId,
    projectId: request.projectId,
    roomId: request.roomId,
    seatId: request.seatId,
    sourceIdentityHash,
    replacementIdentityHash,
    authorizationId: authorization.authorizationId,
    authorizationEvidenceHash: authorization.evidenceHash,
    causation: request.causation,
    evidenceHash,
    activation: request.turnBoundary,
  });
  const lineageId = `room-reroute:${lineageHash.slice("sha256:".length, "sha256:".length + 32)}`;
  const reservationId = `room-reroute-reservation:${lineageHash.slice("sha256:".length, "sha256:".length + 24)}`;
  return {
    rerouteId: request.rerouteId,
    projectId: request.projectId,
    roomId: request.roomId,
    seatId: request.seatId,
    replacement: { ...request.replacement },
    lineage: {
      lineageId,
      lineageHash,
      sourceBindingId: request.source.bindingId,
      replacementBindingId: request.replacement.bindingId,
      sourceIdentityHash,
      replacementIdentityHash,
      authorizationId: authorization.authorizationId,
      causation: { ...request.causation },
      evidenceIds,
      evidenceHash,
      rollbackTarget: { ...request.source },
      activation: {
        kind: "after_settled_turn",
        settledTurnId: request.turnBoundary.settledTurnId,
        settledAt: request.turnBoundary.settledAt,
      },
      reservation: {
        reservationId,
        replacementBindingId: request.replacement.bindingId,
        providerId: request.replacement.providerId,
        nativeSessionId: request.replacement.nativeSessionId,
      },
    },
  };
}

export function evaluateRoomSessionReroutingPolicy(
  input: EvaluateRoomSessionReroutingPolicyInputV1,
): RoomSessionReroutingPolicyResultV1 {
  const issues: RoomSessionReroutingPolicyIssueV1[] = [];
  const candidate = input as unknown;
  const topLevelKeys = [
    "contractVersion",
    "asOf",
    "request",
    "authorization",
    "replacementSnapshot",
    "replacementRoutingPolicy",
    "independentEvidence",
    "evidenceFreshness",
    "reservations",
  ];
  if (!isRecord(candidate) || !hasExactKeys(candidate, topLevelKeys)) {
    return fail([{ code: "invalid_input", path: "$", message: "input must have the exact v1 shape" }]);
  }
  if (candidate.contractVersion !== ROOM_SESSION_REROUTING_POLICY_CONTRACT_VERSION) {
    issue(issues, "invalid_input", "$.contractVersion", "must equal the supported contract version");
  }
  const asOf = parseTimestamp(candidate.asOf, "$.asOf", issues);
  const request = parseRequest(candidate.request, issues);
  const authorization = parseAuthorization(candidate.authorization, issues);
  const freshness = parseEvidenceFreshness(candidate.evidenceFreshness, issues);
  const evidence = Array.isArray(candidate.independentEvidence)
    ? candidate.independentEvidence.map((entry, index) => parseEvidence(entry, index, issues)).filter(
      (entry): entry is RoomSessionRerouteIndependentEvidenceV1 => entry !== undefined,
    )
    : (() => {
      issue(issues, "invalid_input", "$.independentEvidence", "must be an array");
      return undefined;
    })();
  const reservations = parseReservations(candidate.reservations, issues);
  if (!isRecord(candidate.replacementSnapshot)) {
    issue(issues, "replacement_snapshot_mismatch", "$.replacementSnapshot", "must be an inspectable capability snapshot");
  }
  if (!isRecord(candidate.replacementRoutingPolicy)) {
    issue(issues, "replacement_capability_ineligible", "$.replacementRoutingPolicy", "must be an inspectable routing policy");
  }
  if (
    candidate.contractVersion !== ROOM_SESSION_REROUTING_POLICY_CONTRACT_VERSION ||
    !asOf ||
    !request ||
    !authorization ||
    !freshness ||
    !evidence ||
    !reservations ||
    !isRecord(candidate.replacementSnapshot) ||
    !isRecord(candidate.replacementRoutingPolicy)
  ) {
    return fail(issues);
  }

  validateAuthorization(request, authorization, asOf, issues);
  validateReplacementIdentity(request, issues);
  validateEvidence(request, evidence, asOf, freshness, issues);
  validateReservations(request, reservations, issues);

  const replacementSnapshot = candidate.replacementSnapshot as unknown as RoomBindingCapabilitySnapshotV1;
  const replacementPolicy = candidate.replacementRoutingPolicy as unknown as RoomCapabilityRoutingPolicyV1;
  if (!matchesBindingSnapshot(request.replacement, replacementSnapshot)) {
    issue(issues, "replacement_snapshot_mismatch", "$.replacementSnapshot.lineage", "snapshot lineage must exactly match the replacement binding");
  }
  const eligibility = evaluateRoomBindingCapability({
    snapshot: replacementSnapshot,
    asOf,
    policy: replacementPolicy,
  });
  if (!eligibility.ok || !eligibility.value.eligible) {
    issue(
      issues,
      "replacement_capability_ineligible",
      "$.replacementSnapshot",
      "replacement must pass certified capability, health, capacity, quality, and calibration checks",
    );
  }
  if (issues.length > 0) return fail(issues);
  return succeed(buildPlan(request, authorization, evidence));
}
