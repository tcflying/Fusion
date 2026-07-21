import { compareRoomText, hashRoomValue } from "./room-integrity.js";

export const ROOM_DETERMINISTIC_GATE_POLICY_CONTRACT_VERSION = 1 as const;

export type RoomDeterministicGateKindV1 = "rule" | "test" | "source" | "runtime";
export type RoomDeterministicGateVerdictV1 = "passed" | "failed" | "error" | "not_run";

export interface RoomDeterministicGateDefinitionV1 {
  readonly id: string;
  readonly kind: RoomDeterministicGateKindV1;
  readonly hard: true;
  readonly requiredEvidenceKinds: readonly ("rule" | "test" | "source" | "runtime")[];
}

export interface RoomDeterministicGateEvidenceV1 {
  readonly id: string;
  readonly kind: "rule" | "test" | "source" | "runtime";
  readonly reference: string;
  readonly contentHash: string;
  readonly recordedAt: string;
}

/**
 * A gate result must bind the exact canonical input hash made by this policy.
 * The future durable ledger owns persistence and native execution provenance.
 */
export interface RoomDeterministicGateResultV1 {
  readonly gateId: string;
  readonly verdict: RoomDeterministicGateVerdictV1;
  readonly inputHash: string;
  readonly evidenceIds: readonly string[];
  readonly responsibility: string;
  readonly failureReason: string | null;
}

export interface RoomDeterministicGateModelVoteV1 {
  readonly voterBindingId: string;
  readonly decision: "accept" | "reject";
}

export interface RoomDeterministicGateArbiterV1 {
  readonly bindingId: string;
  readonly decision: "accept" | "reject";
  readonly rationale: string;
}

export interface EvaluateRoomDeterministicGatePolicyInputV1 {
  readonly contractVersion: 1;
  readonly subjectId: string;
  readonly subjectHash: string;
  readonly contextHash: string;
  readonly evaluatedAt: string;
  readonly gates: readonly RoomDeterministicGateDefinitionV1[];
  readonly evidence: readonly RoomDeterministicGateEvidenceV1[];
  readonly results: readonly RoomDeterministicGateResultV1[];
  readonly modelVotes: readonly RoomDeterministicGateModelVoteV1[];
  readonly arbiter: RoomDeterministicGateArbiterV1 | null;
}

export type RoomDeterministicGateBlockerCodeV1 =
  | "invalid_input"
  | "invalid_timestamp"
  | "duplicate_identifier"
  | "missing_required_gate_kind"
  | "missing_gate_result"
  | "duplicate_gate_result"
  | "input_hash_mismatch"
  | "missing_evidence"
  | "evidence_kind_mismatch"
  | "failed_hard_gate"
  | "gate_execution_error"
  | "gate_not_run";

export interface RoomDeterministicGateBlockerV1 {
  readonly code: RoomDeterministicGateBlockerCodeV1;
  readonly gateId: string | null;
  readonly evidenceReferences: readonly string[];
  readonly responsibility: string;
  readonly message: string;
}

export interface RoomDeterministicGatePolicyDecisionV1 {
  /** The decision is advisory until an evidence ledger and Engine bind it durably. */
  readonly allHardGatesPassed: boolean;
  readonly inputHash: string | null;
  readonly modelOrArbiterMayOverride: false;
  readonly blockers: readonly RoomDeterministicGateBlockerV1[];
  readonly advisoryModelVotes: readonly RoomDeterministicGateModelVoteV1[];
  readonly advisoryArbiter: RoomDeterministicGateArbiterV1 | null;
}

const HASH = /^sha256:[a-f0-9]{64}$/u;
const GATE_KINDS = ["rule", "test", "source", "runtime"] as const;
const KINDS = new Set<string>(GATE_KINDS);
const VERDICTS = new Set<string>(["passed", "failed", "error", "not_run"]);

/*
FNXC:RoomDeterministicGatePolicy 2026-07-19:
Hard-gate adjudication is a pure, canonical, fail-closed policy. Rule, test,
source, and runtime proof must bind the same immutable subject/context input.
No model vote or arbiter opinion can erase a failed, errored, or unrun hard
gate; they are carried only as visible advisory dissent for a later ledger.
*/
export function evaluateRoomDeterministicGatePolicy(
  input: EvaluateRoomDeterministicGatePolicyInputV1,
): RoomDeterministicGatePolicyDecisionV1 {
  if (!isRecord(input) || !exactKeys(input, ["contractVersion", "subjectId", "subjectHash", "contextHash", "evaluatedAt", "gates", "evidence", "results", "modelVotes", "arbiter"])) {
    return invalid("input must be the exact v1 gate policy shape");
  }
  if (input.contractVersion !== ROOM_DETERMINISTIC_GATE_POLICY_CONTRACT_VERSION || !identifier(input.subjectId) || !hash(input.subjectHash) || !hash(input.contextHash) || !timestamp(input.evaluatedAt) || !Array.isArray(input.gates) || !Array.isArray(input.evidence) || !Array.isArray(input.results) || !Array.isArray(input.modelVotes)) {
    return invalid("input has an invalid contract version, identity, hash, timestamp, or collection");
  }

  const shapeErrors: RoomDeterministicGateBlockerV1[] = [];
  const gates = parseGates(input.gates, shapeErrors);
  const evidence = parseEvidence(input.evidence, shapeErrors);
  const results = parseResults(input.results, shapeErrors);
  const votes = parseVotes(input.modelVotes, shapeErrors);
  const arbiter = parseArbiter(input.arbiter, shapeErrors);
  const inputHash = hashRoomValue({
    contractVersion: input.contractVersion,
    subjectId: input.subjectId,
    subjectHash: input.subjectHash,
    contextHash: input.contextHash,
    gates: gates.map((gate) => ({ ...gate, requiredEvidenceKinds: [...gate.requiredEvidenceKinds].sort(compareRoomText) })).sort((a, b) => compareRoomText(a.id, b.id)),
  });
  if (shapeErrors.length > 0) return decision(inputHash, shapeErrors, votes, arbiter);

  const blockers: RoomDeterministicGateBlockerV1[] = [];
  const gateIds = new Set(gates.map((gate) => gate.id));
  const kinds = new Set(gates.map((gate) => gate.kind));
  for (const kind of GATE_KINDS) {
    if (!kinds.has(kind)) blockers.push(blocker("missing_required_gate_kind", null, [], "policy_owner", `required ${kind} hard gate is missing`));
  }
  for (const result of results) {
    if (!gateIds.has(result.gateId)) blockers.push(blocker("invalid_input", result.gateId, [], result.responsibility, "result references an undeclared hard gate"));
  }
  const evidenceById = new Map(evidence.map((entry) => [entry.id, entry]));
  for (const gate of gates) {
    const matching = results.filter((result) => result.gateId === gate.id);
    if (matching.length !== 1) {
      blockers.push(blocker(matching.length === 0 ? "missing_gate_result" : "duplicate_gate_result", gate.id, [], "gate_executor", "each declared hard gate requires exactly one result"));
      continue;
    }
    const result = matching[0]!;
    if (result.inputHash !== inputHash) blockers.push(blocker("input_hash_mismatch", gate.id, [], result.responsibility, "gate result does not bind this canonical policy input"));
    const referenced = result.evidenceIds.map((id) => evidenceById.get(id)).filter((entry): entry is ParsedEvidence => entry !== undefined);
    if (referenced.length !== result.evidenceIds.length) blockers.push(blocker("missing_evidence", gate.id, result.evidenceIds, result.responsibility, "gate result references missing evidence"));
    for (const requiredKind of gate.requiredEvidenceKinds) {
      if (!referenced.some((entry) => entry.kind === requiredKind)) blockers.push(blocker("evidence_kind_mismatch", gate.id, referenced.map((entry) => entry.reference), result.responsibility, `missing required ${requiredKind} evidence`));
    }
    if (result.verdict === "failed") blockers.push(blocker("failed_hard_gate", gate.id, referenced.map((entry) => entry.reference), result.responsibility, result.failureReason!));
    if (result.verdict === "error") blockers.push(blocker("gate_execution_error", gate.id, referenced.map((entry) => entry.reference), result.responsibility, result.failureReason!));
    if (result.verdict === "not_run") blockers.push(blocker("gate_not_run", gate.id, referenced.map((entry) => entry.reference), result.responsibility, result.failureReason!));
  }
  return decision(inputHash, blockers, votes, arbiter);
}

interface ParsedGate { readonly id: string; readonly kind: RoomDeterministicGateKindV1; readonly hard: true; readonly requiredEvidenceKinds: readonly RoomDeterministicGateKindV1[]; }
interface ParsedEvidence { readonly id: string; readonly kind: RoomDeterministicGateKindV1; readonly reference: string; readonly contentHash: string; readonly recordedAt: string; }
interface ParsedResult { readonly gateId: string; readonly verdict: RoomDeterministicGateVerdictV1; readonly inputHash: string; readonly evidenceIds: readonly string[]; readonly responsibility: string; readonly failureReason: string | null; }

function parseGates(value: readonly RoomDeterministicGateDefinitionV1[], blockers: RoomDeterministicGateBlockerV1[]): ParsedGate[] {
  const seen = new Set<string>(); const parsed: ParsedGate[] = [];
  value.forEach((entry, index) => {
    if (!isRecord(entry) || !exactKeys(entry, ["id", "kind", "hard", "requiredEvidenceKinds"]) || !identifier(entry.id) || !KINDS.has(entry.kind) || entry.hard !== true || !uniqueIdentifiers(entry.requiredEvidenceKinds) || entry.requiredEvidenceKinds.length === 0) {
      blockers.push(blocker("invalid_input", null, [], "policy_owner", `invalid gate at gates[${index}]`)); return;
    }
    if (seen.has(entry.id)) blockers.push(blocker("duplicate_identifier", entry.id, [], "policy_owner", "hard gate id must be unique"));
    seen.add(entry.id); parsed.push({ id: entry.id, kind: entry.kind as RoomDeterministicGateKindV1, hard: true, requiredEvidenceKinds: [...entry.requiredEvidenceKinds] as RoomDeterministicGateKindV1[] });
  });
  return parsed;
}

function parseEvidence(value: readonly RoomDeterministicGateEvidenceV1[], blockers: RoomDeterministicGateBlockerV1[]): ParsedEvidence[] {
  const seen = new Set<string>(); const parsed: ParsedEvidence[] = [];
  value.forEach((entry, index) => {
    if (!isRecord(entry) || !exactKeys(entry, ["id", "kind", "reference", "contentHash", "recordedAt"]) || !identifier(entry.id) || !KINDS.has(entry.kind) || !identifier(entry.reference) || !hash(entry.contentHash) || !timestamp(entry.recordedAt)) {
      blockers.push(blocker("invalid_input", null, [], "evidence_collector", `invalid evidence at evidence[${index}]`)); return;
    }
    if (seen.has(entry.id)) blockers.push(blocker("duplicate_identifier", null, [entry.reference], "evidence_collector", "evidence id must be unique"));
    seen.add(entry.id); parsed.push(entry as ParsedEvidence);
  });
  return parsed;
}

function parseResults(value: readonly RoomDeterministicGateResultV1[], blockers: RoomDeterministicGateBlockerV1[]): ParsedResult[] {
  const parsed: ParsedResult[] = [];
  value.forEach((entry, index) => {
    const reasonValid = entry.verdict === "passed" ? entry.failureReason === null : text(entry.failureReason);
    if (!isRecord(entry) || !exactKeys(entry, ["gateId", "verdict", "inputHash", "evidenceIds", "responsibility", "failureReason"]) || !identifier(entry.gateId) || !VERDICTS.has(entry.verdict) || !hash(entry.inputHash) || !uniqueIdentifiers(entry.evidenceIds) || !identifier(entry.responsibility) || !reasonValid) {
      blockers.push(blocker("invalid_input", null, [], "gate_executor", `invalid result at results[${index}]`)); return;
    }
    parsed.push(entry as ParsedResult);
  });
  return parsed;
}

function parseVotes(value: readonly RoomDeterministicGateModelVoteV1[], blockers: RoomDeterministicGateBlockerV1[]): RoomDeterministicGateModelVoteV1[] {
  const seen = new Set<string>(); const parsed: RoomDeterministicGateModelVoteV1[] = [];
  value.forEach((entry, index) => {
    if (!isRecord(entry) || !exactKeys(entry, ["voterBindingId", "decision"]) || !identifier(entry.voterBindingId) || (entry.decision !== "accept" && entry.decision !== "reject")) {
      blockers.push(blocker("invalid_input", null, [], "model_vote", `invalid vote at modelVotes[${index}]`)); return;
    }
    if (seen.has(entry.voterBindingId)) blockers.push(blocker("duplicate_identifier", null, [], "model_vote", "model voter id must be unique"));
    seen.add(entry.voterBindingId); parsed.push(entry as RoomDeterministicGateModelVoteV1);
  });
  return parsed.sort((a, b) => compareRoomText(a.voterBindingId, b.voterBindingId));
}

function parseArbiter(value: RoomDeterministicGateArbiterV1 | null, blockers: RoomDeterministicGateBlockerV1[]): RoomDeterministicGateArbiterV1 | null {
  if (value === null) return null;
  if (!isRecord(value) || !exactKeys(value, ["bindingId", "decision", "rationale"]) || !identifier(value.bindingId) || (value.decision !== "accept" && value.decision !== "reject") || !text(value.rationale)) {
    blockers.push(blocker("invalid_input", null, [], "arbiter", "invalid arbiter opinion")); return null;
  }
  return value as RoomDeterministicGateArbiterV1;
}

function decision(inputHash: string, blockers: readonly RoomDeterministicGateBlockerV1[], votes: readonly RoomDeterministicGateModelVoteV1[], arbiter: RoomDeterministicGateArbiterV1 | null): RoomDeterministicGatePolicyDecisionV1 {
  return { allHardGatesPassed: blockers.length === 0, inputHash, modelOrArbiterMayOverride: false, blockers: [...blockers].sort((a, b) => compareRoomText(`${a.code}:${a.gateId ?? ""}:${a.message}`, `${b.code}:${b.gateId ?? ""}:${b.message}`)), advisoryModelVotes: votes, advisoryArbiter: arbiter };
}

function invalid(message: string): RoomDeterministicGatePolicyDecisionV1 { return decision(null as unknown as string, [blocker("invalid_input", null, [], "policy_owner", message)], [], null); }
function blocker(code: RoomDeterministicGateBlockerCodeV1, gateId: string | null, evidenceReferences: readonly string[], responsibility: string, message: string): RoomDeterministicGateBlockerV1 { return { code, gateId, evidenceReferences: [...evidenceReferences].sort(compareRoomText), responsibility, message }; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { const actual = Object.keys(value).sort(compareRoomText); const expected = [...keys].sort(compareRoomText); return actual.length === expected.length && actual.every((key, index) => key === expected[index]); }
function identifier(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value); }
function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function hash(value: unknown): value is string { return typeof value === "string" && HASH.test(value); }
function timestamp(value: unknown): value is string { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value; }
function uniqueIdentifiers(value: unknown): value is readonly string[] { return Array.isArray(value) && value.every(identifier) && new Set(value).size === value.length; }
