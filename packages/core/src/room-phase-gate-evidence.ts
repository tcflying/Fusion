import type { RoomProtocolGateKind } from "./room-contracts/protocol.js";

export const ROOM_PHASE_GATE_EVIDENCE_CONTRACT_VERSION = 1 as const;

export type RoomPhaseGateEvidenceHashV1 = string;
export type RoomPhaseGateEvidenceVerdictV1 = "passed" | "failed";

export interface RoomPhaseGateEvidencePhaseV1 {
  readonly id: string;
  readonly entryGateIds: readonly string[];
  readonly exitGateIds: readonly string[];
}

export interface RoomPhaseGateEvidenceGateV1 {
  readonly id: string;
  readonly kind: RoomProtocolGateKind;
  readonly hard: boolean;
}

export interface RoomPhaseGateEvidenceTransitionV1 {
  readonly fromPhaseId: string;
  readonly toPhaseId: string;
  readonly whenGateId: string;
}

/** The minimal, versioned protocol projection required by this pure policy. */
export interface RoomPhaseGateEvidenceProtocolV1 {
  readonly contractVersion: 1;
  readonly id: string;
  readonly version: number;
  readonly definitionHash: RoomPhaseGateEvidenceHashV1;
  readonly phases: readonly RoomPhaseGateEvidencePhaseV1[];
  readonly gates: readonly RoomPhaseGateEvidenceGateV1[];
  readonly transitions: readonly RoomPhaseGateEvidenceTransitionV1[];
}

/**
 * The transition declaration is supplied by the controller's durable turn state.
 * It intentionally contains no caller-provided gate-id claim: the exact gate is
 * derived from the versioned protocol transition.
 */
export interface RoomPhaseGateEvidenceTransitionDeclarationV1 {
  readonly protocolId: string;
  readonly protocolVersion: number;
  readonly protocolHash: RoomPhaseGateEvidenceHashV1;
  readonly fromPhaseId: string;
  readonly toPhaseId: string;
  readonly turnId: string;
  readonly candidateId: string;
  readonly candidateHash: RoomPhaseGateEvidenceHashV1;
  readonly evidenceNotBefore: string;
  readonly evaluatedAt: string;
}

export interface RoomPhaseGateEvidenceSourceV1 {
  readonly recordId: string;
  readonly sourceHash: RoomPhaseGateEvidenceHashV1;
  readonly recordedAt: string;
}

export interface RoomPhaseGateOperatorApprovalAuthorityV1 {
  readonly authorityRecordId: string;
  readonly authoritySourceHash: RoomPhaseGateEvidenceHashV1;
  readonly grantedByActorId: string;
  readonly scope: "approve_phase_gate";
  readonly protocolId: string;
  readonly protocolVersion: number;
  readonly protocolHash: RoomPhaseGateEvidenceHashV1;
  readonly gateId: string;
  readonly phaseId: string;
  readonly turnId: string;
  readonly candidateId: string;
  readonly candidateHash: RoomPhaseGateEvidenceHashV1;
  readonly grantedAt: string;
  readonly expiresAt: string | null;
}

export interface RoomPhaseGateOperatorApprovalV1 {
  readonly operatorId: string;
  readonly authority: RoomPhaseGateOperatorApprovalAuthorityV1;
}

/*
FNXC:RoomPhaseGateEvidence 2026-07-19-08:05:
Phase advancement consumes already-durable, versioned evidence instead of a
caller-supplied passed-gate list. Every record binds the exact protocol hash,
gate, phase, turn, candidate hash, source hash, evaluator binding, and producer
lineage so stale, copied, or self-validating proof cannot advance a Room.

This pure policy validates source records supplied by a durable ledger; it does
not persist, authenticate, manufacture, or repair any evidence or authority.
*/
export interface RoomPhaseGateEvidenceRecordV1 {
  readonly contractVersion: 1;
  readonly id: string;
  readonly protocolId: string;
  readonly protocolVersion: number;
  readonly protocolHash: RoomPhaseGateEvidenceHashV1;
  readonly gateId: string;
  readonly phaseId: string;
  readonly turnId: string;
  readonly candidateId: string;
  readonly candidateHash: RoomPhaseGateEvidenceHashV1;
  readonly source: RoomPhaseGateEvidenceSourceV1;
  readonly verdict: RoomPhaseGateEvidenceVerdictV1;
  readonly evaluatorBindingId: string | null;
  readonly producerBindingIds: readonly string[];
  readonly operatorApproval: RoomPhaseGateOperatorApprovalV1 | null;
}

/** A scoped read from the durable Room evidence ledger; this policy never writes it. */
export interface RoomPhaseGateEvidenceLedgerV1 {
  readonly source: "durable_room_phase_gate_ledger";
  readonly records: readonly RoomPhaseGateEvidenceRecordV1[];
}

/**
 * Producer lineage comes from a separate durable record so evidence cannot
 * replace its producer identities with a self-serving local claim.
 */
export interface RoomPhaseGateProducerLineageV1 {
  readonly source: "durable_room_producer_lineage_ledger";
  readonly sourceRecordId: string;
  readonly sourceHash: RoomPhaseGateEvidenceHashV1;
  readonly protocolId: string;
  readonly protocolVersion: number;
  readonly protocolHash: RoomPhaseGateEvidenceHashV1;
  readonly turnId: string;
  readonly candidateId: string;
  readonly candidateHash: RoomPhaseGateEvidenceHashV1;
  readonly producerBindingIds: readonly string[];
}

export interface EvaluateRoomPhaseTransitionGateEvidenceInputV1 {
  readonly contractVersion: 1;
  readonly protocol: RoomPhaseGateEvidenceProtocolV1;
  readonly transition: RoomPhaseGateEvidenceTransitionDeclarationV1;
  readonly evidenceLedger: RoomPhaseGateEvidenceLedgerV1;
  readonly producerLineage: RoomPhaseGateProducerLineageV1;
}

export type RoomPhaseGateEvidenceUnmetReasonCodeV1 =
  | "invalid_evaluation_input"
  | "unexpected_input_property"
  | "invalid_protocol"
  | "duplicate_protocol_phase"
  | "duplicate_protocol_gate"
  | "invalid_protocol_transition"
  | "invalid_transition_declaration"
  | "transition_protocol_mismatch"
  | "transition_not_declared"
  | "ambiguous_transition"
  | "invalid_evidence_ledger"
  | "invalid_producer_lineage"
  | "malformed_evidence"
  | "duplicate_evidence_id"
  | "duplicate_evidence_source_record"
  | "evidence_protocol_mismatch"
  | "evidence_gate_mismatch"
  | "evidence_phase_mismatch"
  | "evidence_turn_mismatch"
  | "evidence_candidate_mismatch"
  | "stale_evidence"
  | "evidence_after_evaluation"
  | "producer_lineage_mismatch"
  | "evaluator_binding_required"
  | "independent_evaluator_required"
  | "operator_authority_required"
  | "operator_self_authority_forbidden"
  | "operator_authority_mismatch"
  | "operator_authority_expired"
  | "exact_gate_not_passed"
  | "missing_exact_gate_evidence"
  | "duplicate_exact_gate_evidence";

export interface RoomPhaseGateEvidenceUnmetReasonV1 {
  readonly code: RoomPhaseGateEvidenceUnmetReasonCodeV1;
  readonly path: string;
  readonly message: string;
}

export interface RoomPhaseGateEvidenceDecisionV1 {
  readonly transitionAllowed: boolean;
  readonly exactGateId: string | null;
  readonly acceptedEvidenceId: string | null;
  readonly unmetReasons: readonly RoomPhaseGateEvidenceUnmetReasonV1[];
}

interface ParsedPhase {
  readonly id: string;
  readonly entryGateIds: readonly string[];
  readonly exitGateIds: readonly string[];
}

interface ParsedGate {
  readonly id: string;
  readonly kind: RoomProtocolGateKind;
  readonly hard: boolean;
}

interface ParsedProtocolTransition {
  readonly fromPhaseId: string;
  readonly toPhaseId: string;
  readonly whenGateId: string;
}

interface ParsedProtocol {
  readonly id: string;
  readonly version: number;
  readonly definitionHash: string;
  readonly phasesById: ReadonlyMap<string, ParsedPhase>;
  readonly gatesById: ReadonlyMap<string, ParsedGate>;
  readonly transitions: readonly ParsedProtocolTransition[];
}

interface ParsedTransitionDeclaration {
  readonly protocolId: string;
  readonly protocolVersion: number;
  readonly protocolHash: string;
  readonly fromPhaseId: string;
  readonly toPhaseId: string;
  readonly turnId: string;
  readonly candidateId: string;
  readonly candidateHash: string;
  readonly evidenceNotBefore: string;
  readonly evaluatedAt: string;
}

interface ParsedProducerLineage {
  readonly producerBindingIds: readonly string[];
}

interface ParsedOperatorAuthority {
  readonly operatorId: string;
  readonly authority: RoomPhaseGateOperatorApprovalAuthorityV1;
}

interface ParsedEvidence {
  readonly id: string;
  readonly protocolId: string;
  readonly protocolVersion: number;
  readonly protocolHash: string;
  readonly gateId: string;
  readonly phaseId: string;
  readonly turnId: string;
  readonly candidateId: string;
  readonly candidateHash: string;
  readonly source: RoomPhaseGateEvidenceSourceV1;
  readonly verdict: RoomPhaseGateEvidenceVerdictV1;
  readonly evaluatorBindingId: string | null;
  readonly producerBindingIds: readonly string[];
  readonly operatorApproval: ParsedOperatorAuthority | null;
}

const GATE_KINDS = new Set<string>([
  "deterministic",
  "evidence",
  "model_review",
  "operator_approval",
]);
const VERDICTS = new Set<string>(["passed", "failed"]);
const SHA_256_HASH = /^sha256:[a-f0-9]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && SHA_256_HASH.test(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isUniqueStringArray(value: unknown, allowEmpty = true): value is readonly string[] {
  return Array.isArray(value)
    && (allowEmpty || value.length > 0)
    && value.every(isNonEmptyString)
    && new Set(value).size === value.length;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function addReason(
  reasons: RoomPhaseGateEvidenceUnmetReasonV1[],
  code: RoomPhaseGateEvidenceUnmetReasonCodeV1,
  path: string,
  message: string,
): void {
  reasons.push({ code, path, message });
}

function rejectUnexpectedKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  path: string,
  code: RoomPhaseGateEvidenceUnmetReasonCodeV1,
  reasons: RoomPhaseGateEvidenceUnmetReasonV1[],
): boolean {
  const allowed = new Set(allowedKeys);
  let valid = true;
  for (const key of Object.keys(value).sort()) {
    if (allowed.has(key)) continue;
    valid = false;
    addReason(reasons, code, `${path}.${key}`, `Unexpected property '${key}' is not authoritative`);
  }
  return valid;
}

function parseProtocol(
  value: unknown,
  reasons: RoomPhaseGateEvidenceUnmetReasonV1[],
): ParsedProtocol | undefined {
  if (!isRecord(value)) {
    addReason(reasons, "invalid_protocol", "$.protocol", "Protocol must be an inspectable object");
    return undefined;
  }

  let valid = rejectUnexpectedKeys(
    value,
    ["contractVersion", "id", "version", "definitionHash", "phases", "gates", "transitions"],
    "$.protocol",
    "invalid_protocol",
    reasons,
  );
  if (
    value.contractVersion !== ROOM_PHASE_GATE_EVIDENCE_CONTRACT_VERSION
    || !isNonEmptyString(value.id)
    || !isPositiveSafeInteger(value.version)
    || !isHash(value.definitionHash)
    || !Array.isArray(value.phases)
    || !Array.isArray(value.gates)
    || !Array.isArray(value.transitions)
  ) {
    valid = false;
    addReason(
      reasons,
      "invalid_protocol",
      "$.protocol",
      "Protocol requires a v1 identity, hash, phases, gates, and transitions",
    );
  }

  const phasesById = new Map<string, ParsedPhase>();
  if (Array.isArray(value.phases)) {
    value.phases.forEach((phase, index) => {
      const path = `$.protocol.phases[${index}]`;
      if (!isRecord(phase)) {
        valid = false;
        addReason(reasons, "invalid_protocol", path, "Protocol phase must be an object");
        return;
      }
      let phaseValid = rejectUnexpectedKeys(
        phase,
        ["id", "entryGateIds", "exitGateIds"],
        path,
        "invalid_protocol",
        reasons,
      );
      if (
        !isNonEmptyString(phase.id)
        || !isUniqueStringArray(phase.entryGateIds)
        || !isUniqueStringArray(phase.exitGateIds)
      ) {
        phaseValid = false;
        addReason(
          reasons,
          "invalid_protocol",
          path,
          "Protocol phase requires unique non-empty gate identifiers",
        );
      }
      if (!phaseValid) {
        valid = false;
        return;
      }
      const phaseId = phase.id as string;
      const entryGateIds = phase.entryGateIds as readonly string[];
      const exitGateIds = phase.exitGateIds as readonly string[];
      if (phasesById.has(phaseId)) {
        valid = false;
        addReason(reasons, "duplicate_protocol_phase", `${path}.id`, `Duplicate phase '${phaseId}'`);
        return;
      }
      phasesById.set(phaseId, {
        id: phaseId,
        entryGateIds: [...entryGateIds],
        exitGateIds: [...exitGateIds],
      });
    });
  }

  const gatesById = new Map<string, ParsedGate>();
  if (Array.isArray(value.gates)) {
    value.gates.forEach((gate, index) => {
      const path = `$.protocol.gates[${index}]`;
      if (!isRecord(gate)) {
        valid = false;
        addReason(reasons, "invalid_protocol", path, "Protocol gate must be an object");
        return;
      }
      let gateValid = rejectUnexpectedKeys(
        gate,
        ["id", "kind", "hard"],
        path,
        "invalid_protocol",
        reasons,
      );
      if (
        !isNonEmptyString(gate.id)
        || typeof gate.kind !== "string"
        || !GATE_KINDS.has(gate.kind)
        || typeof gate.hard !== "boolean"
      ) {
        gateValid = false;
        addReason(
          reasons,
          "invalid_protocol",
          path,
          "Protocol gate requires an id, declared kind, and hard flag",
        );
      }
      if (!gateValid) {
        valid = false;
        return;
      }
      const gateId = gate.id as string;
      if (gatesById.has(gateId)) {
        valid = false;
        addReason(reasons, "duplicate_protocol_gate", `${path}.id`, `Duplicate gate '${gateId}'`);
        return;
      }
      gatesById.set(gateId, {
        id: gateId,
        kind: gate.kind as RoomProtocolGateKind,
        hard: gate.hard as boolean,
      });
    });
  }

  for (const phase of phasesById.values()) {
    for (const gateId of [...phase.entryGateIds, ...phase.exitGateIds]) {
      if (gatesById.has(gateId)) continue;
      valid = false;
      addReason(
        reasons,
        "invalid_protocol",
        `$.protocol.phases.${phase.id}`,
        `Phase '${phase.id}' references undeclared gate '${gateId}'`,
      );
    }
  }

  const transitions: ParsedProtocolTransition[] = [];
  if (Array.isArray(value.transitions)) {
    value.transitions.forEach((transition, index) => {
      const path = `$.protocol.transitions[${index}]`;
      if (!isRecord(transition)) {
        valid = false;
        addReason(reasons, "invalid_protocol_transition", path, "Protocol transition must be an object");
        return;
      }
      let transitionValid = rejectUnexpectedKeys(
        transition,
        ["fromPhaseId", "toPhaseId", "whenGateId"],
        path,
        "invalid_protocol_transition",
        reasons,
      );
      if (
        !isNonEmptyString(transition.fromPhaseId)
        || !isNonEmptyString(transition.toPhaseId)
        || !isNonEmptyString(transition.whenGateId)
      ) {
        transitionValid = false;
      }
      const fromPhaseId = transition.fromPhaseId as string;
      const toPhaseId = transition.toPhaseId as string;
      const whenGateId = transition.whenGateId as string;
      const source = transitionValid ? phasesById.get(fromPhaseId) : undefined;
      const target = transitionValid ? phasesById.get(toPhaseId) : undefined;
      const gate = transitionValid ? gatesById.get(whenGateId) : undefined;
      if (
        !source
        || !target
        || !gate
        || !source.exitGateIds.includes(whenGateId)
        || !target.entryGateIds.includes(whenGateId)
      ) {
        transitionValid = false;
      }
      if (!transitionValid) {
        valid = false;
        addReason(
          reasons,
          "invalid_protocol_transition",
          path,
          "Protocol transition must bind one declared source exit gate to the target entry gate",
        );
        return;
      }
      transitions.push({
        fromPhaseId,
        toPhaseId,
        whenGateId,
      });
    });
  }

  if (!valid) return undefined;
  return {
    id: value.id as string,
    version: value.version as number,
    definitionHash: value.definitionHash as string,
    phasesById,
    gatesById,
    transitions,
  };
}

function parseTransitionDeclaration(
  value: unknown,
  reasons: RoomPhaseGateEvidenceUnmetReasonV1[],
): ParsedTransitionDeclaration | undefined {
  if (!isRecord(value)) {
    addReason(
      reasons,
      "invalid_transition_declaration",
      "$.transition",
      "Transition declaration must be an object",
    );
    return undefined;
  }
  let valid = rejectUnexpectedKeys(
    value,
    [
      "protocolId",
      "protocolVersion",
      "protocolHash",
      "fromPhaseId",
      "toPhaseId",
      "turnId",
      "candidateId",
      "candidateHash",
      "evidenceNotBefore",
      "evaluatedAt",
    ],
    "$.transition",
    "invalid_transition_declaration",
    reasons,
  );
  const stringFields = [
    value.protocolId,
    value.fromPhaseId,
    value.toPhaseId,
    value.turnId,
    value.candidateId,
  ];
  if (
    stringFields.some((field) => !isNonEmptyString(field))
    || !isPositiveSafeInteger(value.protocolVersion)
    || !isHash(value.protocolHash)
    || !isHash(value.candidateHash)
    || !isCanonicalTimestamp(value.evidenceNotBefore)
    || !isCanonicalTimestamp(value.evaluatedAt)
  ) {
    valid = false;
  }
  if (
    isCanonicalTimestamp(value.evidenceNotBefore)
    && isCanonicalTimestamp(value.evaluatedAt)
    && value.evidenceNotBefore > value.evaluatedAt
  ) {
    valid = false;
  }
  if (!valid) {
    addReason(
      reasons,
      "invalid_transition_declaration",
      "$.transition",
      "Transition declaration requires canonical identity, hashes, and a valid evidence window",
    );
    return undefined;
  }
  return {
    protocolId: value.protocolId as string,
    protocolVersion: value.protocolVersion as number,
    protocolHash: value.protocolHash as string,
    fromPhaseId: value.fromPhaseId as string,
    toPhaseId: value.toPhaseId as string,
    turnId: value.turnId as string,
    candidateId: value.candidateId as string,
    candidateHash: value.candidateHash as string,
    evidenceNotBefore: value.evidenceNotBefore as string,
    evaluatedAt: value.evaluatedAt as string,
  };
}

function parseProducerLineage(
  value: unknown,
  transition: ParsedTransitionDeclaration | undefined,
  reasons: RoomPhaseGateEvidenceUnmetReasonV1[],
): ParsedProducerLineage | undefined {
  if (!isRecord(value)) {
    addReason(reasons, "invalid_producer_lineage", "$.producerLineage", "Producer lineage must be an object");
    return undefined;
  }
  let valid = rejectUnexpectedKeys(
    value,
    [
      "source",
      "sourceRecordId",
      "sourceHash",
      "protocolId",
      "protocolVersion",
      "protocolHash",
      "turnId",
      "candidateId",
      "candidateHash",
      "producerBindingIds",
    ],
    "$.producerLineage",
    "invalid_producer_lineage",
    reasons,
  );
  if (
    value.source !== "durable_room_producer_lineage_ledger"
    || !isNonEmptyString(value.sourceRecordId)
    || !isHash(value.sourceHash)
    || !isNonEmptyString(value.protocolId)
    || !isPositiveSafeInteger(value.protocolVersion)
    || !isHash(value.protocolHash)
    || !isNonEmptyString(value.turnId)
    || !isNonEmptyString(value.candidateId)
    || !isHash(value.candidateHash)
    || !isUniqueStringArray(value.producerBindingIds, false)
  ) {
    valid = false;
  }
  if (
    valid
    && transition
    && (
      value.protocolId !== transition.protocolId
      || value.protocolVersion !== transition.protocolVersion
      || value.protocolHash !== transition.protocolHash
      || value.turnId !== transition.turnId
      || value.candidateId !== transition.candidateId
      || value.candidateHash !== transition.candidateHash
    )
  ) {
    valid = false;
  }
  if (!valid) {
    addReason(
      reasons,
      "invalid_producer_lineage",
      "$.producerLineage",
      "Producer lineage must be a durable record for the exact declared transition candidate",
    );
    return undefined;
  }
  return { producerBindingIds: [...(value.producerBindingIds as readonly string[])] };
}

function parseOperatorApproval(
  value: unknown,
  path: string,
  reasons: RoomPhaseGateEvidenceUnmetReasonV1[],
): ParsedOperatorAuthority | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) {
    addReason(reasons, "malformed_evidence", path, "Operator approval must be null or an object");
    return undefined;
  }
  let valid = rejectUnexpectedKeys(
    value,
    ["operatorId", "authority"],
    path,
    "malformed_evidence",
    reasons,
  );
  if (!isNonEmptyString(value.operatorId) || !isRecord(value.authority)) {
    valid = false;
  }
  const authority = isRecord(value.authority) ? value.authority : undefined;
  if (authority) {
    valid = rejectUnexpectedKeys(
      authority,
      [
        "authorityRecordId",
        "authoritySourceHash",
        "grantedByActorId",
        "scope",
        "protocolId",
        "protocolVersion",
        "protocolHash",
        "gateId",
        "phaseId",
        "turnId",
        "candidateId",
        "candidateHash",
        "grantedAt",
        "expiresAt",
      ],
      `${path}.authority`,
      "malformed_evidence",
      reasons,
    ) && valid;
    const stringFields = [
      authority.authorityRecordId,
      authority.grantedByActorId,
      authority.protocolId,
      authority.gateId,
      authority.phaseId,
      authority.turnId,
      authority.candidateId,
    ];
    if (
      stringFields.some((field) => !isNonEmptyString(field))
      || !isHash(authority.authoritySourceHash)
      || authority.scope !== "approve_phase_gate"
      || !isPositiveSafeInteger(authority.protocolVersion)
      || !isHash(authority.protocolHash)
      || !isHash(authority.candidateHash)
      || !isCanonicalTimestamp(authority.grantedAt)
      || (authority.expiresAt !== null && !isCanonicalTimestamp(authority.expiresAt))
    ) {
      valid = false;
    }
  }
  if (!valid || !authority) {
    addReason(
      reasons,
      "malformed_evidence",
      path,
      "Operator approval requires an explicit, hashed phase-gate authority record",
    );
    return undefined;
  }
  return {
    operatorId: value.operatorId as string,
    authority: {
      authorityRecordId: authority.authorityRecordId as string,
      authoritySourceHash: authority.authoritySourceHash as string,
      grantedByActorId: authority.grantedByActorId as string,
      scope: "approve_phase_gate",
      protocolId: authority.protocolId as string,
      protocolVersion: authority.protocolVersion as number,
      protocolHash: authority.protocolHash as string,
      gateId: authority.gateId as string,
      phaseId: authority.phaseId as string,
      turnId: authority.turnId as string,
      candidateId: authority.candidateId as string,
      candidateHash: authority.candidateHash as string,
      grantedAt: authority.grantedAt as string,
      expiresAt: authority.expiresAt as string | null,
    },
  };
}

function parseEvidence(
  value: unknown,
  path: string,
  reasons: RoomPhaseGateEvidenceUnmetReasonV1[],
): ParsedEvidence | undefined {
  if (!isRecord(value)) {
    addReason(reasons, "malformed_evidence", path, "Evidence record must be an object");
    return undefined;
  }
  let valid = rejectUnexpectedKeys(
    value,
    [
      "contractVersion",
      "id",
      "protocolId",
      "protocolVersion",
      "protocolHash",
      "gateId",
      "phaseId",
      "turnId",
      "candidateId",
      "candidateHash",
      "source",
      "verdict",
      "evaluatorBindingId",
      "producerBindingIds",
      "operatorApproval",
    ],
    path,
    "malformed_evidence",
    reasons,
  );
  const source = isRecord(value.source) ? value.source : undefined;
  if (source) {
    valid = rejectUnexpectedKeys(
      source,
      ["recordId", "sourceHash", "recordedAt"],
      `${path}.source`,
      "malformed_evidence",
      reasons,
    ) && valid;
  }
  const stringFields = [
    value.id,
    value.protocolId,
    value.gateId,
    value.phaseId,
    value.turnId,
    value.candidateId,
  ];
  if (
    value.contractVersion !== ROOM_PHASE_GATE_EVIDENCE_CONTRACT_VERSION
    || stringFields.some((field) => !isNonEmptyString(field))
    || !isPositiveSafeInteger(value.protocolVersion)
    || !isHash(value.protocolHash)
    || !isHash(value.candidateHash)
    || !source
    || !isNonEmptyString(source.recordId)
    || !isHash(source.sourceHash)
    || !isCanonicalTimestamp(source.recordedAt)
    || typeof value.verdict !== "string"
    || !VERDICTS.has(value.verdict)
    || (value.evaluatorBindingId !== null && !isNonEmptyString(value.evaluatorBindingId))
    || !isUniqueStringArray(value.producerBindingIds, false)
  ) {
    valid = false;
  }
  const operatorApproval = parseOperatorApproval(value.operatorApproval, `${path}.operatorApproval`, reasons);
  if (operatorApproval === undefined) valid = false;
  if (!valid || !source || operatorApproval === undefined) {
    addReason(
      reasons,
      "malformed_evidence",
      path,
      "Evidence must be a complete v1 durable record with canonical hashes, source, lineage, and evaluator",
    );
    return undefined;
  }
  return {
    id: value.id as string,
    protocolId: value.protocolId as string,
    protocolVersion: value.protocolVersion as number,
    protocolHash: value.protocolHash as string,
    gateId: value.gateId as string,
    phaseId: value.phaseId as string,
    turnId: value.turnId as string,
    candidateId: value.candidateId as string,
    candidateHash: value.candidateHash as string,
    source: {
      recordId: source.recordId as string,
      sourceHash: source.sourceHash as string,
      recordedAt: source.recordedAt as string,
    },
    verdict: value.verdict as RoomPhaseGateEvidenceVerdictV1,
    evaluatorBindingId: value.evaluatorBindingId as string | null,
    producerBindingIds: [...(value.producerBindingIds as readonly string[])],
    operatorApproval,
  };
}

function validateOperatorAuthority(
  evidence: ParsedEvidence,
  transition: ParsedTransitionDeclaration,
  exactGateId: string,
  recordReasons: (code: RoomPhaseGateEvidenceUnmetReasonCodeV1, path: string, message: string) => void,
): void {
  const approval = evidence.operatorApproval;
  if (!approval) {
    recordReasons(
      "operator_authority_required",
      "$.evidenceLedger.records.operatorApproval",
      "Operator-approval gates require an explicit durable authority record",
    );
    return;
  }
  const authority = approval.authority;
  if (authority.grantedByActorId === approval.operatorId) {
    recordReasons(
      "operator_self_authority_forbidden",
      "$.evidenceLedger.records.operatorApproval.authority.grantedByActorId",
      "An operator cannot grant its own phase-gate approval authority",
    );
  }
  if (
    authority.protocolId !== transition.protocolId
    || authority.protocolVersion !== transition.protocolVersion
    || authority.protocolHash !== transition.protocolHash
    || authority.gateId !== exactGateId
    || authority.phaseId !== transition.fromPhaseId
    || authority.turnId !== transition.turnId
    || authority.candidateId !== transition.candidateId
    || authority.candidateHash !== transition.candidateHash
  ) {
    recordReasons(
      "operator_authority_mismatch",
      "$.evidenceLedger.records.operatorApproval.authority",
      "Operator authority must bind the exact protocol, gate, phase, turn, and candidate",
    );
  }
  if (
    authority.grantedAt > evidence.source.recordedAt
    || (authority.expiresAt !== null && authority.expiresAt <= evidence.source.recordedAt)
  ) {
    recordReasons(
      "operator_authority_expired",
      "$.evidenceLedger.records.operatorApproval.authority",
      "Operator authority must be active when the durable evidence record is committed",
    );
  }
}

function freezeDecision(
  transitionAllowed: boolean,
  exactGateId: string | null,
  acceptedEvidenceId: string | null,
  reasons: readonly RoomPhaseGateEvidenceUnmetReasonV1[],
): RoomPhaseGateEvidenceDecisionV1 {
  return Object.freeze({
    transitionAllowed,
    exactGateId,
    acceptedEvidenceId,
    unmetReasons: Object.freeze(reasons.map((reason) => Object.freeze({ ...reason }))),
  });
}

/**
 * Deterministically decides whether a declared phase transition has one exact,
 * durable, fresh, and authority-valid passing gate record. It is deliberately
 * read-only: callers must persist and authenticate evidence before invoking it.
 */
export function evaluateRoomPhaseTransitionGateEvidence(
  input: EvaluateRoomPhaseTransitionGateEvidenceInputV1,
): RoomPhaseGateEvidenceDecisionV1 {
  const reasons: RoomPhaseGateEvidenceUnmetReasonV1[] = [];
  const root = input as unknown;
  if (!isRecord(root)) {
    addReason(reasons, "invalid_evaluation_input", "$", "Evaluation input must be an object");
    return freezeDecision(false, null, null, reasons);
  }
  if (root.contractVersion !== ROOM_PHASE_GATE_EVIDENCE_CONTRACT_VERSION) {
    addReason(
      reasons,
      "invalid_evaluation_input",
      "$.contractVersion",
      "Evaluation input requires contractVersion 1",
    );
  }
  rejectUnexpectedKeys(
    root,
    ["contractVersion", "protocol", "transition", "evidenceLedger", "producerLineage"],
    "$",
    "unexpected_input_property",
    reasons,
  );

  const protocol = parseProtocol(root.protocol, reasons);
  const transition = parseTransitionDeclaration(root.transition, reasons);
  const producerLineage = parseProducerLineage(root.producerLineage, transition, reasons);

  let exactGateId: string | null = null;
  let exactGate: ParsedGate | undefined;
  if (protocol && transition) {
    if (
      protocol.id !== transition.protocolId
      || protocol.version !== transition.protocolVersion
      || protocol.definitionHash !== transition.protocolHash
    ) {
      addReason(
        reasons,
        "transition_protocol_mismatch",
        "$.transition",
        "Transition must identify the exact declared protocol version and hash",
      );
    } else {
      const declaredTransitions = protocol.transitions.filter(
        (candidate) =>
          candidate.fromPhaseId === transition.fromPhaseId
          && candidate.toPhaseId === transition.toPhaseId,
      );
      if (declaredTransitions.length === 0) {
        addReason(
          reasons,
          "transition_not_declared",
          "$.transition",
          "No protocol transition is declared for the requested phase change",
        );
      } else if (declaredTransitions.length > 1) {
        addReason(
          reasons,
          "ambiguous_transition",
          "$.protocol.transitions",
          "The requested phase change has more than one declared transition gate",
        );
      } else {
        const declaredTransition = declaredTransitions[0]!;
        exactGateId = declaredTransition.whenGateId;
        exactGate = protocol.gatesById.get(declaredTransition.whenGateId);
      }
    }
  }

  const ledger = root.evidenceLedger;
  if (!isRecord(ledger) || ledger.source !== "durable_room_phase_gate_ledger" || !Array.isArray(ledger.records)) {
    addReason(
      reasons,
      "invalid_evidence_ledger",
      "$.evidenceLedger",
      "Policy requires a scoped read from the durable Room phase-gate evidence ledger",
    );
    return freezeDecision(false, exactGateId, null, reasons);
  }
  rejectUnexpectedKeys(
    ledger,
    ["source", "records"],
    "$.evidenceLedger",
    "invalid_evidence_ledger",
    reasons,
  );

  const evidenceIds = new Set<string>();
  const sourceRecordIds = new Set<string>();
  let exactEvidenceCount = 0;
  let acceptedEvidence: ParsedEvidence | undefined;

  ledger.records.forEach((rawEvidence, index) => {
    const path = `$.evidenceLedger.records[${index}]`;
    const evidence = parseEvidence(rawEvidence, path, reasons);
    if (!evidence) return;

    if (evidenceIds.has(evidence.id)) {
      addReason(reasons, "duplicate_evidence_id", `${path}.id`, `Evidence id '${evidence.id}' is duplicated`);
    }
    evidenceIds.add(evidence.id);
    if (sourceRecordIds.has(evidence.source.recordId)) {
      addReason(
        reasons,
        "duplicate_evidence_source_record",
        `${path}.source.recordId`,
        `Durable source record '${evidence.source.recordId}' is duplicated`,
      );
    }
    sourceRecordIds.add(evidence.source.recordId);

    if (!transition || !protocol || !exactGateId || !exactGate) return;

    let recordValid = true;
    const recordReason = (
      code: RoomPhaseGateEvidenceUnmetReasonCodeV1,
      reasonPath: string,
      message: string,
    ): void => {
      recordValid = false;
      addReason(reasons, code, reasonPath, message);
    };

    if (
      evidence.protocolId !== transition.protocolId
      || evidence.protocolVersion !== transition.protocolVersion
      || evidence.protocolHash !== transition.protocolHash
    ) {
      recordReason(
        "evidence_protocol_mismatch",
        path,
        "Evidence must bind the exact declared protocol version and hash",
      );
    }
    if (evidence.gateId !== exactGateId) {
      recordReason(
        "evidence_gate_mismatch",
        `${path}.gateId`,
        `Evidence gate '${evidence.gateId}' is not the transition gate '${exactGateId}'`,
      );
    }
    if (evidence.phaseId !== transition.fromPhaseId) {
      recordReason(
        "evidence_phase_mismatch",
        `${path}.phaseId`,
        "Evidence must be recorded for the transition source phase",
      );
    }
    if (evidence.turnId !== transition.turnId) {
      recordReason(
        "evidence_turn_mismatch",
        `${path}.turnId`,
        "Evidence must be recorded for the declared turn",
      );
    }
    if (
      evidence.candidateId !== transition.candidateId
      || evidence.candidateHash !== transition.candidateHash
    ) {
      recordReason(
        "evidence_candidate_mismatch",
        path,
        "Evidence must bind the exact candidate identity and content hash",
      );
    }
    if (evidence.gateId === exactGateId) exactEvidenceCount += 1;
    if (evidence.source.recordedAt < transition.evidenceNotBefore) {
      recordReason(
        "stale_evidence",
        `${path}.source.recordedAt`,
        "Evidence predates the declared transition evidence window",
      );
    }
    if (evidence.source.recordedAt > transition.evaluatedAt) {
      recordReason(
        "evidence_after_evaluation",
        `${path}.source.recordedAt`,
        "Evidence was recorded after the declared deterministic evaluation time",
      );
    }
    if (producerLineage && !sameStringSet(evidence.producerBindingIds, producerLineage.producerBindingIds)) {
      recordReason(
        "producer_lineage_mismatch",
        `${path}.producerBindingIds`,
        "Evidence producer lineage differs from the separate durable lineage record",
      );
    }
    if (!producerLineage) {
      recordValid = false;
    }
    if (evidence.verdict !== "passed") {
      recordReason(
        "exact_gate_not_passed",
        `${path}.verdict`,
        "The exact transition gate evidence is not passed",
      );
    }

    if (exactGate.kind === "operator_approval") {
      validateOperatorAuthority(evidence, transition, exactGateId, recordReason);
      if (
        exactGate.hard
        && evidence.evaluatorBindingId !== null
        && producerLineage?.producerBindingIds.includes(evidence.evaluatorBindingId)
      ) {
        recordReason(
          "independent_evaluator_required",
          `${path}.evaluatorBindingId`,
          "A hard operator approval cannot use a producer's binding as its evaluator binding",
        );
      }
    } else {
      if (evidence.operatorApproval !== null) {
        recordReason(
          "malformed_evidence",
          `${path}.operatorApproval`,
          "Only an operator-approval gate may carry operator authority",
        );
      }
      if (evidence.evaluatorBindingId === null) {
        recordReason(
          "evaluator_binding_required",
          `${path}.evaluatorBindingId`,
          "Non-operator gates require a concrete evaluator binding",
        );
      } else if (
        (exactGate.hard || exactGate.kind === "model_review")
        && producerLineage?.producerBindingIds.includes(evidence.evaluatorBindingId)
      ) {
        recordReason(
          "independent_evaluator_required",
          `${path}.evaluatorBindingId`,
          "Hard and model-review gates require an evaluator independent of producer lineage",
        );
      }
    }

    if (recordValid) acceptedEvidence = evidence;
  });

  if (exactGateId !== null && exactEvidenceCount === 0) {
    addReason(
      reasons,
      "missing_exact_gate_evidence",
      "$.evidenceLedger.records",
      `No durable evidence record exists for transition gate '${exactGateId}'`,
    );
  }
  if (exactEvidenceCount > 1) {
    addReason(
      reasons,
      "duplicate_exact_gate_evidence",
      "$.evidenceLedger.records",
      `More than one evidence record claims transition gate '${exactGateId}'`,
    );
  }

  if (reasons.length > 0 || !acceptedEvidence || exactGateId === null) {
    return freezeDecision(false, exactGateId, null, reasons);
  }
  return freezeDecision(true, exactGateId, acceptedEvidence.id, reasons);
}
