import {
  compareRoomText,
  RoomDeterministicGatePolicy,
  type AppendRoomPromotionInputV1,
  type RoomEvidenceLedgerAppendResult,
  type RoomEvidenceLedgerScope,
  type RoomPromotionRecordV1,
} from "@fusion/core";

export const ROOM_DETERMINISTIC_GATE_PROMOTION_COORDINATOR_CONTRACT_VERSION = 1 as const;

type GatePolicyInputV1 = RoomDeterministicGatePolicy.EvaluateRoomDeterministicGatePolicyInputV1;
type GatePolicyDecisionV1 = RoomDeterministicGatePolicy.RoomDeterministicGatePolicyDecisionV1;
type GatePolicyModelVoteV1 = RoomDeterministicGatePolicy.RoomDeterministicGateModelVoteV1;
type GatePolicyArbiterV1 = RoomDeterministicGatePolicy.RoomDeterministicGateArbiterV1;

export interface RoomDeterministicGatePromotionCommandIdentityV1 {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

export interface RoomDeterministicGatePromotionIntentV1 {
  readonly id: AppendRoomPromotionInputV1["id"];
  readonly decisionActorType: AppendRoomPromotionInputV1["decisionActorType"];
  readonly decisionActorId: AppendRoomPromotionInputV1["decisionActorId"];
  readonly reviewIds: AppendRoomPromotionInputV1["reviewIds"];
  readonly unresolvedDissentIds: AppendRoomPromotionInputV1["unresolvedDissentIds"];
  readonly rationale: AppendRoomPromotionInputV1["rationale"];
  readonly decidedAt: AppendRoomPromotionInputV1["decidedAt"];
}

/**
 * The caller can request a promotion, but cannot inject hard-gate or evidence
 * references. Those references are reconstructed solely from the trusted reader.
 */
export interface RequestRoomDeterministicGatePromotionV1 {
  readonly contractVersion: typeof ROOM_DETERMINISTIC_GATE_PROMOTION_COORDINATOR_CONTRACT_VERSION;
  readonly scope: RoomEvidenceLedgerScope;
  readonly candidateId: AppendRoomPromotionInputV1["candidateId"];
  readonly nodeId: AppendRoomPromotionInputV1["nodeId"];
  readonly expectedPolicyInputHash: string;
  readonly promotion: RoomDeterministicGatePromotionIntentV1;
  readonly command: RoomDeterministicGatePromotionCommandIdentityV1;
}

export interface ReadRoomDeterministicGatePromotionPolicyInputV1 {
  readonly contractVersion: typeof ROOM_DETERMINISTIC_GATE_PROMOTION_COORDINATOR_CONTRACT_VERSION;
  readonly scope: RoomEvidenceLedgerScope;
  readonly candidateId: AppendRoomPromotionInputV1["candidateId"];
  readonly nodeId: AppendRoomPromotionInputV1["nodeId"];
  readonly expectedPolicyInputHash: string;
  readonly command: RoomDeterministicGatePromotionCommandIdentityV1;
}

export interface RoomDeterministicGateLedgerEvidenceRefV1 {
  readonly policyEvidenceId: string;
  readonly evidenceId: AppendRoomPromotionInputV1["evidenceIds"][number];
}

export interface RoomDeterministicGateLedgerGateRefV1 {
  readonly policyGateId: string;
  readonly gateResultId: AppendRoomPromotionInputV1["hardGateResultIds"][number];
}

/**
 * A trusted executor/ledger adapter returns both the immutable policy input and
 * the durable references that correspond to its policy-local identifiers.
 */
export interface RoomDeterministicGatePromotionPolicySnapshotV1 {
  readonly contractVersion: typeof ROOM_DETERMINISTIC_GATE_PROMOTION_COORDINATOR_CONTRACT_VERSION;
  readonly scope: RoomEvidenceLedgerScope;
  readonly candidateId: AppendRoomPromotionInputV1["candidateId"];
  readonly nodeId: AppendRoomPromotionInputV1["nodeId"];
  readonly policyInputHash: string;
  readonly policyInput: GatePolicyInputV1;
  readonly evidenceRefs: readonly RoomDeterministicGateLedgerEvidenceRefV1[];
  readonly hardGateRefs: readonly RoomDeterministicGateLedgerGateRefV1[];
}

export interface RoomDeterministicGatePromotionPolicyReaderPortV1 {
  readDeterministicGatePromotionPolicy(
    input: ReadRoomDeterministicGatePromotionPolicyInputV1,
  ): Promise<RoomDeterministicGatePromotionPolicySnapshotV1 | null>;
}

/**
 * This envelope retains command identity outside Core's immutable record shape.
 * An adapter must delegate `promotion` to AsyncRoomEvidenceLedger rather than
 * manufacturing a promotion record in Engine.
 */
export interface AppendRoomDeterministicGatePromotionInputV1 {
  readonly command: RoomDeterministicGatePromotionCommandIdentityV1;
  readonly promotion: AppendRoomPromotionInputV1;
}

export interface RoomDeterministicGatePromotionAppendPortV1 {
  appendPromotion(
    input: AppendRoomDeterministicGatePromotionInputV1,
  ): Promise<RoomEvidenceLedgerAppendResult<"room_promotions", RoomPromotionRecordV1>>;
}

export interface RoomDeterministicGatePromotionCoordinatorDependenciesV1 {
  readonly policyReader: RoomDeterministicGatePromotionPolicyReaderPortV1;
  readonly promotionPort: RoomDeterministicGatePromotionAppendPortV1;
}

export interface RoomDeterministicGatePromotionAuditV1 {
  readonly policyInputHash: string | null;
  readonly modelOrArbiterMayOverride: false;
  readonly advisoryModelVotes: readonly GatePolicyModelVoteV1[];
  readonly advisoryArbiter: GatePolicyArbiterV1 | null;
}

export type RoomDeterministicGatePromotionWithheldCodeV1 =
  | "invalid_request"
  | "policy_reader_invalid"
  | "promotion_port_invalid"
  | "policy_snapshot_missing"
  | "policy_snapshot_invalid"
  | "policy_snapshot_drift"
  | "invalid_policy_input"
  | "input_hash_drift"
  | "evidence_reference_drift"
  | "hard_gate_withheld";

export interface RoomDeterministicGatePromotionWithheldResultV1 {
  readonly status: "withheld";
  readonly reason: {
    readonly code: RoomDeterministicGatePromotionWithheldCodeV1;
    readonly message: string;
  };
  readonly decision: GatePolicyDecisionV1 | null;
  readonly audit: RoomDeterministicGatePromotionAuditV1;
}

export interface RoomDeterministicGatePromotionSucceededResultV1 {
  readonly status: "promoted";
  readonly decision: GatePolicyDecisionV1;
  readonly audit: RoomDeterministicGatePromotionAuditV1;
  readonly request: AppendRoomDeterministicGatePromotionInputV1;
  readonly appended: RoomEvidenceLedgerAppendResult<"room_promotions", RoomPromotionRecordV1>;
}

export interface RoomDeterministicGatePromotionAppendFailedResultV1 {
  readonly status: "append_failed";
  readonly decision: GatePolicyDecisionV1;
  readonly audit: RoomDeterministicGatePromotionAuditV1;
  readonly request: AppendRoomDeterministicGatePromotionInputV1;
  readonly message: string;
}

export type RoomDeterministicGatePromotionResultV1 =
  | RoomDeterministicGatePromotionWithheldResultV1
  | RoomDeterministicGatePromotionSucceededResultV1
  | RoomDeterministicGatePromotionAppendFailedResultV1;

/*
FNXC:RoomDeterministicGatePromotionCoordinator 2026-07-18-13:40:
OpenSpec 7.3 requires deterministic rule, test, source, and runtime gates to
outrank model consensus and arbiter preference. This Engine seam receives only
trusted reader output, reruns Core's canonical policy, and can append a promotion
only when every hard gate remains green and every policy-local reference maps to
the same immutable ledger scope.

FNXC:RoomDeterministicGatePromotionCoordinator 2026-07-18-13:40:
The coordinator never executes tests, probes a provider, or invents evidence.
It preserves command/idempotency identity in a typed envelope for a future ledger
adapter, while model votes and arbiter opinion remain audit-only return data.
*/
export class RoomDeterministicGatePromotionCoordinator {
  constructor(private readonly dependencies: RoomDeterministicGatePromotionCoordinatorDependenciesV1) {}

  async promote(rawInput: RequestRoomDeterministicGatePromotionV1): Promise<RoomDeterministicGatePromotionResultV1> {
    const requestIssue = validateRequest(rawInput);
    if (requestIssue !== null) return withheld("invalid_request", requestIssue);
    if (!isPolicyReader(this.dependencies?.policyReader)) {
      return withheld("policy_reader_invalid", "A trusted deterministic-gate policy reader is required");
    }
    if (!isPromotionPort(this.dependencies?.promotionPort)) {
      return withheld("promotion_port_invalid", "A typed immutable promotion append port is required");
    }

    const input = rawInput as RequestRoomDeterministicGatePromotionV1;
    const readerInput = toReaderInput(input);
    let snapshot: RoomDeterministicGatePromotionPolicySnapshotV1 | null;
    try {
      snapshot = await this.dependencies.policyReader.readDeterministicGatePromotionPolicy(readerInput);
    } catch {
      return withheld("policy_snapshot_missing", "The trusted reader did not return a deterministic-gate policy snapshot");
    }
    if (snapshot === null) {
      return withheld("policy_snapshot_missing", "No deterministic-gate policy snapshot exists for this candidate");
    }

    const snapshotIssue = validateSnapshot(snapshot, input);
    if (snapshotIssue !== null) {
      return withheld(snapshotIssue.code, snapshotIssue.message);
    }
    const trustedSnapshot = snapshot as RoomDeterministicGatePromotionPolicySnapshotV1;
    const decision = RoomDeterministicGatePolicy.evaluateRoomDeterministicGatePolicy(trustedSnapshot.policyInput);
    const audit = toAudit(decision);
    if (decision.inputHash === null) {
      return withheld("invalid_policy_input", "The trusted snapshot did not contain a valid canonical policy input", decision, audit);
    }
    if (
      decision.inputHash !== input.expectedPolicyInputHash
      || decision.inputHash !== trustedSnapshot.policyInputHash
    ) {
      return withheld("input_hash_drift", "The request, trusted snapshot, and recomputed policy input hash must match", decision, audit);
    }
    if (decision.blockers.some((blocker) => blocker.code === "input_hash_mismatch")) {
      return withheld("input_hash_drift", "A deterministic gate result does not bind the recomputed policy input hash", decision, audit);
    }
    if (!decision.allHardGatesPassed) {
      return withheld("hard_gate_withheld", "At least one deterministic hard gate is failed, errored, unrun, or insufficiently evidenced", decision, audit);
    }

    const references = alignPolicyReferences(trustedSnapshot);
    if (!references.ok) {
      return withheld("evidence_reference_drift", references.message, decision, audit);
    }

    const appendRequest = toAppendRequest(input, references);
    try {
      const appended = await this.dependencies.promotionPort.appendPromotion(appendRequest);
      if (!matchesPromotionAppend(appended, appendRequest.promotion)) {
        return {
          status: "append_failed",
          decision,
          audit,
          request: appendRequest,
          message: "The immutable promotion append port did not acknowledge the requested promotion record",
        };
      }
      return {
        status: "promoted",
        decision,
        audit,
        request: appendRequest,
        appended,
      };
    } catch {
      return {
        status: "append_failed",
        decision,
        audit,
        request: appendRequest,
        message: "The immutable promotion append port did not confirm a durable append",
      };
    }
  }
}

function validateRequest(value: unknown): string | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "contractVersion",
    "scope",
    "candidateId",
    "nodeId",
    "expectedPolicyInputHash",
    "promotion",
    "command",
  ])) {
    return "Promotion requests must use the exact v1 coordinator shape";
  }
  if (value.contractVersion !== ROOM_DETERMINISTIC_GATE_PROMOTION_COORDINATOR_CONTRACT_VERSION) {
    return "Promotion requests must use the supported contract version";
  }
  if (!isLedgerScope(value.scope) || !isCanonicalReference(value.candidateId) || !isCanonicalReference(value.nodeId)) {
    return "Promotion requests require canonical scope, candidate, and node identities";
  }
  if (!isCanonicalHash(value.expectedPolicyInputHash)) {
    return "Promotion requests require a canonical expected policy input hash";
  }
  if (!isPromotionIntent(value.promotion)) {
    return "Promotion intent must preserve the immutable evidence-ledger promotion shape";
  }
  if (!isCommandIdentity(value.command)) {
    return "Promotion requests require canonical command and idempotency identities";
  }
  return null;
}

function validateSnapshot(
  value: unknown,
  input: RequestRoomDeterministicGatePromotionV1,
): { readonly code: "policy_snapshot_invalid" | "policy_snapshot_drift"; readonly message: string } | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "contractVersion",
    "scope",
    "candidateId",
    "nodeId",
    "policyInputHash",
    "policyInput",
    "evidenceRefs",
    "hardGateRefs",
  ])) {
    return { code: "policy_snapshot_invalid", message: "The trusted reader returned an invalid policy snapshot shape" };
  }
  if (
    value.contractVersion !== ROOM_DETERMINISTIC_GATE_PROMOTION_COORDINATOR_CONTRACT_VERSION
    || !isLedgerScope(value.scope)
    || !isCanonicalReference(value.candidateId)
    || !isCanonicalReference(value.nodeId)
    || !isCanonicalHash(value.policyInputHash)
    || !isRecord(value.policyInput)
    || !isEvidenceRefs(value.evidenceRefs)
    || !isGateRefs(value.hardGateRefs)
  ) {
    return { code: "policy_snapshot_invalid", message: "The trusted reader returned malformed policy or ledger references" };
  }
  if (
    value.scope.projectId !== input.scope.projectId
    || value.scope.roomId !== input.scope.roomId
    || value.candidateId !== input.candidateId
    || value.nodeId !== input.nodeId
    || value.policyInput.subjectId !== input.candidateId
  ) {
    return { code: "policy_snapshot_drift", message: "The trusted policy snapshot is not bound to this promotion request" };
  }
  return null;
}

function alignPolicyReferences(
  snapshot: RoomDeterministicGatePromotionPolicySnapshotV1,
): { readonly ok: true; readonly hardGateResultIds: readonly string[]; readonly evidenceIds: readonly string[] } | { readonly ok: false; readonly message: string } {
  const policyGateIds = snapshot.policyInput.gates.map((gate) => gate.id);
  const policyEvidenceIds = snapshot.policyInput.evidence.map((evidence) => evidence.id);
  if (!sameIdentifierSet(policyGateIds, snapshot.hardGateRefs.map((reference) => reference.policyGateId))) {
    return { ok: false, message: "Trusted hard-gate references do not cover exactly the canonical policy gates" };
  }
  if (!sameIdentifierSet(policyEvidenceIds, snapshot.evidenceRefs.map((reference) => reference.policyEvidenceId))) {
    return { ok: false, message: "Trusted evidence references do not cover exactly the canonical policy evidence" };
  }
  const hardGateResultIds = canonicalReferences(snapshot.hardGateRefs.map((reference) => reference.gateResultId));
  const evidenceIds = canonicalReferences(snapshot.evidenceRefs.map((reference) => reference.evidenceId));
  if (hardGateResultIds === null || evidenceIds === null) {
    return { ok: false, message: "Trusted ledger references must be canonical, unique, and sorted" };
  }
  return { ok: true, hardGateResultIds, evidenceIds };
}

function toReaderInput(input: RequestRoomDeterministicGatePromotionV1): ReadRoomDeterministicGatePromotionPolicyInputV1 {
  return {
    contractVersion: ROOM_DETERMINISTIC_GATE_PROMOTION_COORDINATOR_CONTRACT_VERSION,
    scope: copyScope(input.scope),
    candidateId: input.candidateId,
    nodeId: input.nodeId,
    expectedPolicyInputHash: input.expectedPolicyInputHash,
    command: copyCommand(input.command),
  };
}

function toAppendRequest(
  input: RequestRoomDeterministicGatePromotionV1,
  references: { readonly hardGateResultIds: readonly string[]; readonly evidenceIds: readonly string[] },
): AppendRoomDeterministicGatePromotionInputV1 {
  return {
    command: copyCommand(input.command),
    promotion: {
      scope: copyScope(input.scope),
      id: input.promotion.id,
      nodeId: input.nodeId,
      candidateId: input.candidateId,
      decision: "promoted",
      decisionActorType: input.promotion.decisionActorType,
      decisionActorId: input.promotion.decisionActorId,
      hardGateResultIds: [...references.hardGateResultIds] as AppendRoomPromotionInputV1["hardGateResultIds"],
      reviewIds: [...input.promotion.reviewIds],
      unresolvedDissentIds: [...input.promotion.unresolvedDissentIds],
      evidenceIds: [...references.evidenceIds] as AppendRoomPromotionInputV1["evidenceIds"],
      rationale: input.promotion.rationale,
      decidedAt: input.promotion.decidedAt,
    },
  };
}

function matchesPromotionAppend(
  value: unknown,
  promotion: AppendRoomPromotionInputV1,
): value is RoomEvidenceLedgerAppendResult<"room_promotions", RoomPromotionRecordV1> {
  if (!isRecord(value) || value.table !== "room_promotions" || !isRecord(value.record)) return false;
  return (
    value.record.id === promotion.id
    && value.record.roomId === promotion.scope.roomId
    && value.record.nodeId === promotion.nodeId
    && value.record.candidateId === promotion.candidateId
    && value.record.decision === "promoted"
  );
}

function toAudit(decision: GatePolicyDecisionV1 | null): RoomDeterministicGatePromotionAuditV1 {
  return {
    policyInputHash: decision?.inputHash ?? null,
    modelOrArbiterMayOverride: false,
    advisoryModelVotes: decision === null
      ? []
      : decision.advisoryModelVotes.map((vote) => ({ ...vote })),
    advisoryArbiter: decision?.advisoryArbiter === null || decision === null
      ? null
      : { ...decision.advisoryArbiter },
  };
}

function withheld(
  code: RoomDeterministicGatePromotionWithheldCodeV1,
  message: string,
  decision: GatePolicyDecisionV1 | null = null,
  audit: RoomDeterministicGatePromotionAuditV1 = toAudit(decision),
): RoomDeterministicGatePromotionWithheldResultV1 {
  return { status: "withheld", reason: { code, message }, decision, audit };
}

function isPolicyReader(value: unknown): value is RoomDeterministicGatePromotionPolicyReaderPortV1 {
  return isRecord(value) && typeof value.readDeterministicGatePromotionPolicy === "function";
}

function isPromotionPort(value: unknown): value is RoomDeterministicGatePromotionAppendPortV1 {
  return isRecord(value) && typeof value.appendPromotion === "function";
}

function isPromotionIntent(value: unknown): value is RoomDeterministicGatePromotionIntentV1 {
  return isRecord(value)
    && hasExactKeys(value, ["id", "decisionActorType", "decisionActorId", "reviewIds", "unresolvedDissentIds", "rationale", "decidedAt"])
    && isCanonicalReference(value.id)
    && (value.decisionActorType === "controller" || value.decisionActorType === "independent_arbiter" || value.decisionActorType === "human_operator")
    && isCanonicalReference(value.decisionActorId)
    && isCanonicalReferenceList(value.reviewIds)
    && isCanonicalReferenceList(value.unresolvedDissentIds)
    && isCanonicalText(value.rationale)
    && isCanonicalTimestamp(value.decidedAt);
}

function isCommandIdentity(value: unknown): value is RoomDeterministicGatePromotionCommandIdentityV1 {
  return isRecord(value)
    && hasExactKeys(value, ["commandId", "idempotencyKey", "correlationId", "causationId"])
    && isCanonicalReference(value.commandId)
    && isCanonicalReference(value.idempotencyKey)
    && isCanonicalReference(value.correlationId)
    && (value.causationId === null || isCanonicalReference(value.causationId));
}

function isLedgerScope(value: unknown): value is RoomEvidenceLedgerScope {
  return isRecord(value)
    && hasExactKeys(value, ["projectId", "roomId"])
    && isCanonicalReference(value.projectId)
    && isCanonicalReference(value.roomId);
}

function isEvidenceRefs(value: unknown): value is readonly RoomDeterministicGateLedgerEvidenceRefV1[] {
  if (!Array.isArray(value)) return false;
  const policyIds = new Set<string>();
  const ledgerIds = new Set<string>();
  return value.every((reference) => {
    if (!isRecord(reference) || !hasExactKeys(reference, ["policyEvidenceId", "evidenceId"])) return false;
    if (!isCanonicalReference(reference.policyEvidenceId) || !isCanonicalReference(reference.evidenceId)) return false;
    if (policyIds.has(reference.policyEvidenceId) || ledgerIds.has(reference.evidenceId)) return false;
    policyIds.add(reference.policyEvidenceId);
    ledgerIds.add(reference.evidenceId);
    return true;
  });
}

function isGateRefs(value: unknown): value is readonly RoomDeterministicGateLedgerGateRefV1[] {
  if (!Array.isArray(value)) return false;
  const policyIds = new Set<string>();
  const ledgerIds = new Set<string>();
  return value.every((reference) => {
    if (!isRecord(reference) || !hasExactKeys(reference, ["policyGateId", "gateResultId"])) return false;
    if (!isCanonicalReference(reference.policyGateId) || !isCanonicalReference(reference.gateResultId)) return false;
    if (policyIds.has(reference.policyGateId) || ledgerIds.has(reference.gateResultId)) return false;
    policyIds.add(reference.policyGateId);
    ledgerIds.add(reference.gateResultId);
    return true;
  });
}

function sameIdentifierSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && new Set(left).size === left.length
    && new Set(right).size === right.length
    && left.every((identifier) => right.includes(identifier));
}

function canonicalReferences(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || !value.every(isCanonicalReference)) return null;
  const sorted = [...value].sort(compareRoomText);
  return sorted.some((reference, index) => index > 0 && sorted[index - 1] === reference)
    ? null
    : sorted;
}

function isCanonicalReferenceList(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || !value.every(isCanonicalReference)) return false;
  return value.every((reference, index) => index === 0 || compareRoomText(value[index - 1]!, reference) < 0);
}

function copyScope(scope: RoomEvidenceLedgerScope): RoomEvidenceLedgerScope {
  return { projectId: scope.projectId, roomId: scope.roomId };
}

function copyCommand(
  command: RoomDeterministicGatePromotionCommandIdentityV1,
): RoomDeterministicGatePromotionCommandIdentityV1 {
  return {
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    correlationId: command.correlationId,
    causationId: command.causationId,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareRoomText);
  const sortedExpected = [...expected].sort(compareRoomText);
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function isCanonicalReference(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value);
}

function isCanonicalHash(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && Number.isFinite(Date.parse(value))
    && new Date(Date.parse(value)).toISOString() === value;
}

function isCanonicalText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim() === value;
}
