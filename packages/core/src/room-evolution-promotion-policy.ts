export const ROOM_EVOLUTION_PROMOTION_POLICY_CONTRACT_VERSION = 1 as const;

export type RoomEvolutionRiskSurfaceV1 =
  | "source"
  | "permission"
  | "authentication"
  | "network"
  | "destructive"
  | "evaluator"
  | "data"
  | "runtime";
export type RoomEvolutionRiskSeverityV1 = "low" | "medium" | "high" | "critical";
export type RoomEvolutionGateStatusV1 = "passed" | "failed";

export interface RoomEvolutionHardGateResultV1 {
  readonly gateId: string;
  readonly status: RoomEvolutionGateStatusV1;
  readonly evaluatorBindingIds: readonly string[];
  readonly evidenceHash: string;
}

export interface RoomEvolutionRiskV1 {
  readonly id: string;
  readonly surface: RoomEvolutionRiskSurfaceV1;
  readonly severity: RoomEvolutionRiskSeverityV1;
  readonly mitigated: boolean;
}

export interface RoomEvolutionMetricV1 {
  readonly id: string;
  readonly baseline: number;
  readonly canary: number;
  /** Absolute permitted decline from baseline; all objectives must remain within it. */
  readonly maxDegradation: number;
}

export interface RoomEvolutionCanaryEvidenceV1 {
  readonly source: "durable_room_evolution_canary_ledger";
  readonly canaryId: string;
  readonly candidateHash: string;
  readonly completedAt: string;
  readonly sampleCount: number;
  readonly minimumSampleCount: number;
  readonly qualityScore: number;
  readonly minimumQualityScore: number;
  readonly metrics: readonly RoomEvolutionMetricV1[];
  readonly evaluatorBindingIds: readonly string[];
}

export interface RoomEvolutionProposalV1 {
  readonly id: string;
  readonly candidateHash: string;
  readonly proposerBindingIds: readonly string[];
  readonly requestedAt: string;
}

export interface EvaluateRoomEvolutionPromotionInputV1 {
  readonly contractVersion: 1;
  readonly proposal: RoomEvolutionProposalV1;
  readonly requiredHardGateIds: readonly string[];
  readonly hardGateResults: readonly RoomEvolutionHardGateResultV1[];
  readonly risks: readonly RoomEvolutionRiskV1[];
  readonly canary: RoomEvolutionCanaryEvidenceV1 | null;
  readonly evaluatedAt: string;
}

export type RoomEvolutionPromotionBlockerCodeV1 =
  | "invalid_input"
  | "invalid_timestamp"
  | "duplicate_identifier"
  | "invalid_authoritative_canary_source"
  | "missing_required_hard_gate"
  | "failed_hard_gate"
  | "proposer_only_evaluator_forbidden"
  | "missing_independent_evaluator"
  | "unmitigated_high_risk"
  | "missing_canary"
  | "canary_candidate_mismatch"
  | "canary_after_evaluation"
  | "canary_sample_below_threshold"
  | "canary_quality_below_threshold"
  | "multi_objective_degradation";

export interface RoomEvolutionPromotionBlockerV1 {
  readonly code: RoomEvolutionPromotionBlockerCodeV1;
  readonly path: string;
  readonly message: string;
}

export interface RoomEvolutionPromotionDecisionV1 {
  /** This is advisory only. A durable runtime must independently execute promotion. */
  readonly mayRequestRuntimePromotion: boolean;
  readonly requiredRuntimeAction: "none" | "promote_candidate" | "rollback_candidate";
  readonly evaluationPath: "hard_gate_blocked" | "canary_blocked" | "eligible";
  readonly blockers: readonly RoomEvolutionPromotionBlockerV1[];
}

const RISK_SURFACES = new Set<string>([
  "source", "permission", "authentication", "network", "destructive", "evaluator", "data", "runtime",
]);
const RISK_SEVERITIES = new Set<string>(["low", "medium", "high", "critical"]);

/*
FNXC:RoomEvolutionPromotionPolicy 2026-07-19:
Evolution decisions are a deterministic, fail-closed recommendation over
already-durable evidence. They neither deploy nor promote anything. Hard gates
run first; a proposer cannot be its sole accepting evaluator; source,
permission, authentication, network, destructive, and evaluator risks default
to high impact. Any multi-objective canary degradation requests rollback.
*/
export function evaluateRoomEvolutionPromotion(
  input: EvaluateRoomEvolutionPromotionInputV1,
): RoomEvolutionPromotionDecisionV1 {
  const blockers: RoomEvolutionPromotionBlockerV1[] = [];
  if (!isRecord(input) || !hasOnlyKeys(input, ["contractVersion", "proposal", "requiredHardGateIds", "hardGateResults", "risks", "canary", "evaluatedAt"])) {
    return blocked("hard_gate_blocked", "none", [reason("invalid_input", "input", "input must be the exact v1 evaluation shape")]);
  }
  if (input.contractVersion !== ROOM_EVOLUTION_PROMOTION_POLICY_CONTRACT_VERSION) {
    return blocked("hard_gate_blocked", "none", [reason("invalid_input", "contractVersion", "unsupported evolution promotion contract version")]);
  }
  const proposal = parseProposal(input.proposal, blockers);
  const evaluatedAt = parseTimestamp(input.evaluatedAt, "evaluatedAt", blockers);
  const requiredGateIds = parseUniqueIdentifiers(input.requiredHardGateIds, "requiredHardGateIds", blockers);
  const gateResults = parseGateResults(input.hardGateResults, blockers);
  const risks = parseRisks(input.risks, blockers);

  // Hard gates take precedence: do not accept a canary after its safety proof is invalid.
  if (!proposal || !evaluatedAt || !requiredGateIds || !gateResults || !risks) {
    return blocked("hard_gate_blocked", "none", blockers);
  }
  for (const gateId of requiredGateIds) {
    const matches = gateResults.filter((entry) => entry.gateId === gateId);
    if (matches.length !== 1) {
      blockers.push(reason("missing_required_hard_gate", `hardGateResults.${gateId}`, "each required hard gate needs exactly one authoritative result"));
      continue;
    }
    const gate = matches[0]!;
    if (gate.status !== "passed") blockers.push(reason("failed_hard_gate", `hardGateResults.${gateId}.status`, "required hard gate did not pass"));
    assertIndependent(gate.evaluatorBindingIds, proposal.proposerBindingIds, `hardGateResults.${gateId}.evaluatorBindingIds`, blockers);
  }
  for (const risk of risks) {
    if ((risk.severity === "high" || risk.severity === "critical") && !risk.mitigated) {
      blockers.push(reason("unmitigated_high_risk", `risks.${risk.id}`, `unmitigated ${risk.severity} ${risk.surface} risk blocks promotion`));
    }
  }
  if (blockers.length > 0) return blocked("hard_gate_blocked", "none", blockers);

  const canary = parseCanary(input.canary, proposal.candidateHash, evaluatedAt, proposal.proposerBindingIds, blockers);
  if (!canary || blockers.length > 0) {
    const rollback = blockers.some((entry) => entry.code === "multi_objective_degradation");
    return blocked("canary_blocked", rollback ? "rollback_candidate" : "none", blockers);
  }
  return { mayRequestRuntimePromotion: true, requiredRuntimeAction: "promote_candidate", evaluationPath: "eligible", blockers: [] };
}

function parseProposal(value: unknown, blockers: RoomEvolutionPromotionBlockerV1[]): { id: string; candidateHash: string; proposerBindingIds: readonly string[]; requestedAt: number } | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["id", "candidateHash", "proposerBindingIds", "requestedAt"])) {
    blockers.push(reason("invalid_input", "proposal", "proposal must be the exact v1 shape")); return null;
  }
  const ids = parseUniqueIdentifiers(value.proposerBindingIds, "proposal.proposerBindingIds", blockers);
  const requestedAt = parseTimestamp(value.requestedAt, "proposal.requestedAt", blockers);
  if (!isIdentifier(value.id) || !isHash(value.candidateHash) || !ids || !requestedAt || ids.length === 0) {
    blockers.push(reason("invalid_input", "proposal", "proposal needs canonical id, hash, at least one proposer, and timestamp")); return null;
  }
  return { id: value.id, candidateHash: value.candidateHash, proposerBindingIds: ids, requestedAt };
}

function parseGateResults(value: unknown, blockers: RoomEvolutionPromotionBlockerV1[]): readonly RoomEvolutionHardGateResultV1[] | null {
  if (!Array.isArray(value)) { blockers.push(reason("invalid_input", "hardGateResults", "hard gate results must be an array")); return null; }
  const seen = new Set<string>();
  const parsed: RoomEvolutionHardGateResultV1[] = [];
  for (const [index, entry] of value.entries()) {
    const path = `hardGateResults[${index}]`;
    if (!isRecord(entry) || !hasOnlyKeys(entry, ["gateId", "status", "evaluatorBindingIds", "evidenceHash"]) || !isIdentifier(entry.gateId) || (entry.status !== "passed" && entry.status !== "failed") || !isHash(entry.evidenceHash)) {
      blockers.push(reason("invalid_input", path, "invalid hard gate result")); continue;
    }
    const evaluators = parseUniqueIdentifiers(entry.evaluatorBindingIds, `${path}.evaluatorBindingIds`, blockers);
    if (!evaluators || evaluators.length === 0) { blockers.push(reason("missing_independent_evaluator", `${path}.evaluatorBindingIds`, "hard gate requires an evaluator")); continue; }
    if (seen.has(entry.gateId)) blockers.push(reason("duplicate_identifier", `${path}.gateId`, "hard gate id must be unique"));
    seen.add(entry.gateId); parsed.push({ gateId: entry.gateId, status: entry.status, evaluatorBindingIds: evaluators, evidenceHash: entry.evidenceHash });
  }
  return parsed;
}

function parseRisks(value: unknown, blockers: RoomEvolutionPromotionBlockerV1[]): readonly RoomEvolutionRiskV1[] | null {
  if (!Array.isArray(value)) { blockers.push(reason("invalid_input", "risks", "risks must be an array")); return null; }
  const seen = new Set<string>(); const parsed: RoomEvolutionRiskV1[] = [];
  for (const [index, entry] of value.entries()) {
    const path = `risks[${index}]`;
    if (!isRecord(entry) || !hasOnlyKeys(entry, ["id", "surface", "severity", "mitigated"]) || !isIdentifier(entry.id) || typeof entry.surface !== "string" || !RISK_SURFACES.has(entry.surface) || typeof entry.severity !== "string" || !RISK_SEVERITIES.has(entry.severity) || typeof entry.mitigated !== "boolean") {
      blockers.push(reason("invalid_input", path, "invalid evolution risk")); continue;
    }
    if (seen.has(entry.id)) blockers.push(reason("duplicate_identifier", `${path}.id`, "risk id must be unique"));
    seen.add(entry.id); parsed.push({ id: entry.id, surface: entry.surface as RoomEvolutionRiskSurfaceV1, severity: entry.severity as RoomEvolutionRiskSeverityV1, mitigated: entry.mitigated });
  }
  return parsed;
}

function parseCanary(value: unknown, candidateHash: string, evaluatedAt: number, proposers: readonly string[], blockers: RoomEvolutionPromotionBlockerV1[]): RoomEvolutionCanaryEvidenceV1 | null {
  if (value === null) { blockers.push(reason("missing_canary", "canary", "a durable canary result is required after hard gates pass")); return null; }
  if (!isRecord(value) || !hasOnlyKeys(value, ["source", "canaryId", "candidateHash", "completedAt", "sampleCount", "minimumSampleCount", "qualityScore", "minimumQualityScore", "metrics", "evaluatorBindingIds"])) {
    blockers.push(reason("invalid_input", "canary", "canary must be the exact v1 shape")); return null;
  }
  if (value.source !== "durable_room_evolution_canary_ledger") blockers.push(reason("invalid_authoritative_canary_source", "canary.source", "canary evidence must come from the durable evolution ledger"));
  if (!isIdentifier(value.canaryId) || !isHash(value.candidateHash) || value.candidateHash !== candidateHash) blockers.push(reason("canary_candidate_mismatch", "canary.candidateHash", "canary must bind this exact candidate hash"));
  const completedAt = parseTimestamp(value.completedAt, "canary.completedAt", blockers);
  if (completedAt && completedAt > evaluatedAt) blockers.push(reason("canary_after_evaluation", "canary.completedAt", "canary cannot be recorded after the evaluation time"));
  if (!isFiniteNonNegative(value.sampleCount) || !isFiniteNonNegative(value.minimumSampleCount) || value.sampleCount < value.minimumSampleCount) blockers.push(reason("canary_sample_below_threshold", "canary.sampleCount", "canary sample count is below its declared threshold"));
  if (!isUnitInterval(value.qualityScore) || !isUnitInterval(value.minimumQualityScore) || value.qualityScore < value.minimumQualityScore) blockers.push(reason("canary_quality_below_threshold", "canary.qualityScore", "canary quality is below its declared threshold"));
  const evaluators = parseUniqueIdentifiers(value.evaluatorBindingIds, "canary.evaluatorBindingIds", blockers);
  if (!evaluators || evaluators.length === 0) blockers.push(reason("missing_independent_evaluator", "canary.evaluatorBindingIds", "canary requires an evaluator")); else assertIndependent(evaluators, proposers, "canary.evaluatorBindingIds", blockers);
  const metrics = parseMetrics(value.metrics, blockers);
  if (blockers.length > 0 || !completedAt || !evaluators || !metrics) return null;
  return { source: "durable_room_evolution_canary_ledger", canaryId: value.canaryId as string, candidateHash: value.candidateHash as string, completedAt: value.completedAt as string, sampleCount: value.sampleCount as number, minimumSampleCount: value.minimumSampleCount as number, qualityScore: value.qualityScore as number, minimumQualityScore: value.minimumQualityScore as number, metrics, evaluatorBindingIds: evaluators };
}

function parseMetrics(value: unknown, blockers: RoomEvolutionPromotionBlockerV1[]): readonly RoomEvolutionMetricV1[] | null {
  if (!Array.isArray(value) || value.length === 0) { blockers.push(reason("invalid_input", "canary.metrics", "canary needs at least one objective")); return null; }
  const seen = new Set<string>(); const parsed: RoomEvolutionMetricV1[] = [];
  for (const [index, entry] of value.entries()) {
    const path = `canary.metrics[${index}]`;
    if (!isRecord(entry) || !hasOnlyKeys(entry, ["id", "baseline", "canary", "maxDegradation"]) || !isIdentifier(entry.id) || !isFiniteNumber(entry.baseline) || !isFiniteNumber(entry.canary) || !isFiniteNonNegative(entry.maxDegradation)) {
      blockers.push(reason("invalid_input", path, "invalid canary objective")); continue;
    }
    if (seen.has(entry.id)) blockers.push(reason("duplicate_identifier", `${path}.id`, "objective id must be unique"));
    seen.add(entry.id);
    if (entry.baseline - entry.canary > entry.maxDegradation) blockers.push(reason("multi_objective_degradation", path, "objective degraded beyond its permitted threshold; runtime rollback is required"));
    parsed.push({ id: entry.id, baseline: entry.baseline, canary: entry.canary, maxDegradation: entry.maxDegradation });
  }
  return parsed;
}

function assertIndependent(evaluators: readonly string[], proposers: readonly string[], path: string, blockers: RoomEvolutionPromotionBlockerV1[]): void {
  const independent = evaluators.some((id) => !proposers.includes(id));
  if (!independent) blockers.push(reason("proposer_only_evaluator_forbidden", path, "proposer-only evaluation cannot accept or promote its own candidate"));
}
function parseUniqueIdentifiers(value: unknown, path: string, blockers: RoomEvolutionPromotionBlockerV1[]): readonly string[] | null {
  if (!Array.isArray(value) || value.some((entry) => !isIdentifier(entry))) { blockers.push(reason("invalid_input", path, "must be an array of canonical identifiers")); return null; }
  const sorted = [...value].sort();
  if (new Set(sorted).size !== sorted.length) blockers.push(reason("duplicate_identifier", path, "identifiers must be unique"));
  return sorted;
}
function parseTimestamp(value: unknown, path: string, blockers: RoomEvolutionPromotionBlockerV1[]): number | null { const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN; if (!Number.isFinite(parsed)) { blockers.push(reason("invalid_timestamp", path, "must be an ISO-parseable timestamp")); return null; } return parsed; }
function reason(code: RoomEvolutionPromotionBlockerCodeV1, path: string, message: string): RoomEvolutionPromotionBlockerV1 { return { code, path, message }; }
function blocked(evaluationPath: RoomEvolutionPromotionDecisionV1["evaluationPath"], requiredRuntimeAction: RoomEvolutionPromotionDecisionV1["requiredRuntimeAction"], blockers: readonly RoomEvolutionPromotionBlockerV1[]): RoomEvolutionPromotionDecisionV1 { return { mayRequestRuntimePromotion: false, requiredRuntimeAction, evaluationPath, blockers: [...blockers].sort((a, b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code)) }; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { const allowed = new Set(keys); return Object.keys(value).every((key) => allowed.has(key)) && keys.every((key) => key in value); }
function isIdentifier(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value); }
function isHash(value: unknown): value is string { return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value); }
function isFiniteNumber(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function isFiniteNonNegative(value: unknown): value is number { return isFiniteNumber(value) && value >= 0; }
function isUnitInterval(value: unknown): value is number { return isFiniteNumber(value) && value >= 0 && value <= 1; }
