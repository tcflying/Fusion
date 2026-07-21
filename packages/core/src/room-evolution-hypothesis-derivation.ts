import {
  ROOM_EVOLUTION_OUTCOME_SIGNAL_CONTRACT_VERSION,
  type RoomEvolutionOutcomeObservationV1,
  type RoomEvolutionOutcomeSignalKindV1,
  type RoomEvolutionOutcomeSignalSetV1,
} from "./room-evolution-outcome-signals.js";

export const ROOM_EVOLUTION_HYPOTHESIS_DERIVATION_CONTRACT_VERSION = 1 as const;

export type RoomEvolutionHypothesisScopeKindV1 = "project" | "room";
export type RoomEvolutionHypothesisRiskClassV1 = "low" | "moderate" | "high" | "critical";

export interface RoomEvolutionHypothesisTemplateV1 {
  readonly contractVersion: typeof ROOM_EVOLUTION_HYPOTHESIS_DERIVATION_CONTRACT_VERSION;
  readonly id: string;
  readonly scopeKind: RoomEvolutionHypothesisScopeKindV1;
  readonly revision: number;
  readonly triggerSignalKinds: readonly RoomEvolutionOutcomeSignalKindV1[];
  readonly minimumObservationCount: number;
  readonly declaredScope: readonly string[];
  readonly riskClass: RoomEvolutionHypothesisRiskClassV1;
  readonly expectedMechanism: string;
  readonly affectedDomains: readonly string[];
  readonly createdByActorId: string;
}

export interface RoomEvolutionHypothesisEvidenceReferenceV1 {
  readonly observationId: string;
  readonly kind: RoomEvolutionOutcomeSignalKindV1;
  readonly sourceRef: string;
  readonly evidenceHash: string;
  readonly observedAt: string;
}

export interface DerivedRoomEvolutionHypothesisV1 {
  readonly contractVersion: typeof ROOM_EVOLUTION_HYPOTHESIS_DERIVATION_CONTRACT_VERSION;
  readonly id: string;
  readonly templateId: string;
  readonly projectId: string;
  readonly roomId: string | null;
  readonly scopeKind: RoomEvolutionHypothesisScopeKindV1;
  readonly scopeKey: string;
  readonly revision: number;
  readonly state: "proposed";
  readonly sourceSignalKinds: readonly RoomEvolutionOutcomeSignalKindV1[];
  readonly declaredScope: readonly string[];
  readonly riskClass: RoomEvolutionHypothesisRiskClassV1;
  readonly expectedMechanism: string;
  readonly affectedDomains: readonly string[];
  readonly createdByActorId: string;
  readonly evidence: readonly RoomEvolutionHypothesisEvidenceReferenceV1[];
  readonly modelSelfReportExcluded: true;
}

export interface DeriveAuthorizedRoomEvolutionHypothesesInputV1 {
  readonly contractVersion: typeof ROOM_EVOLUTION_HYPOTHESIS_DERIVATION_CONTRACT_VERSION;
  readonly signals: RoomEvolutionOutcomeSignalSetV1;
  readonly templates: readonly RoomEvolutionHypothesisTemplateV1[];
}

export type RoomEvolutionHypothesisDerivationIssueCodeV1 =
  | "invalid_input"
  | "invalid_template"
  | "duplicate_template";

export interface RoomEvolutionHypothesisDerivationIssueV1 {
  readonly code: RoomEvolutionHypothesisDerivationIssueCodeV1;
  readonly path: string;
  readonly message: string;
}

export type DeriveAuthorizedRoomEvolutionHypothesesResultV1 =
  | { readonly ok: true; readonly value: readonly DerivedRoomEvolutionHypothesisV1[] }
  | { readonly ok: false; readonly issues: readonly RoomEvolutionHypothesisDerivationIssueV1[] };

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_EVIDENCE_REFS = 16;
const SIGNAL_KINDS = new Set<RoomEvolutionOutcomeSignalKindV1>([
  "failure",
  "correction",
  "confidence",
  "retry",
  "dissent",
  "quality",
  "stability",
  "utilization",
  "latency",
]);
const RISK_CLASSES = new Set<RoomEvolutionHypothesisRiskClassV1>([
  "low",
  "moderate",
  "high",
  "critical",
]);

export function deriveAuthorizedRoomEvolutionHypotheses(
  input: DeriveAuthorizedRoomEvolutionHypothesesInputV1,
): DeriveAuthorizedRoomEvolutionHypothesesResultV1 {
  const issues: RoomEvolutionHypothesisDerivationIssueV1[] = [];
  if (!isRecord(input) || !hasExactKeys(input, ["contractVersion", "signals", "templates"])) {
    return failure([issue("invalid_input", "input", "Hypothesis derivation input must have the exact v1 shape")]);
  }
  if (input.contractVersion !== ROOM_EVOLUTION_HYPOTHESIS_DERIVATION_CONTRACT_VERSION) {
    issues.push(issue("invalid_input", "contractVersion", "Hypothesis derivation contract version is unsupported"));
  }
  if (!isOutcomeSignalSet(input.signals)) {
    issues.push(issue("invalid_input", "signals", "Signals must be an authorized v1 outcome signal set"));
  }
  if (!Array.isArray(input.templates)) {
    issues.push(issue("invalid_input", "templates", "Templates must be an array"));
  }
  if (issues.length > 0 || !isOutcomeSignalSet(input.signals) || !Array.isArray(input.templates)) {
    return failure(issues);
  }

  const templateIds = new Set<string>();
  const templates: RoomEvolutionHypothesisTemplateV1[] = [];
  for (const [index, value] of input.templates.entries()) {
    const template = parseTemplate(value, `templates[${index}]`, templateIds, issues);
    if (template) templates.push(template);
  }
  if (issues.length > 0) return failure(issues);

  const derived = templates.flatMap((template) => deriveTemplate(input.signals, template));
  return success(derived.sort((left, right) => left.id.localeCompare(right.id)));
}

function deriveTemplate(
  signals: RoomEvolutionOutcomeSignalSetV1,
  template: RoomEvolutionHypothesisTemplateV1,
): readonly DerivedRoomEvolutionHypothesisV1[] {
  const scopedObservations = template.scopeKind === "project"
    ? [[`project:${signals.projectId}`, null, signals.observations] as const]
    : groupRoomObservations(signals.observations);

  return scopedObservations.flatMap(([scopeKey, roomId, observations]) => {
    const evidence = observations
      .filter((observation) => template.triggerSignalKinds.includes(observation.kind))
      .sort((left, right) => left.id.localeCompare(right.id))
      .slice(0, MAX_EVIDENCE_REFS);
    const observedKinds = new Set(evidence.map((observation) => observation.kind));
    if (
      evidence.length < template.minimumObservationCount
      || template.triggerSignalKinds.some((kind) => !observedKinds.has(kind))
    ) {
      return [];
    }

    const canonicalEvidence = evidence.map(toEvidenceReference);
    const id = `hypothesis:${template.id}:${scopeKey}:v${template.revision}`;
    return [Object.freeze({
      contractVersion: ROOM_EVOLUTION_HYPOTHESIS_DERIVATION_CONTRACT_VERSION,
      id,
      templateId: template.id,
      projectId: signals.projectId,
      roomId,
      scopeKind: template.scopeKind,
      scopeKey,
      revision: template.revision,
      state: "proposed" as const,
      sourceSignalKinds: Object.freeze([...template.triggerSignalKinds]),
      declaredScope: Object.freeze([...template.declaredScope]),
      riskClass: template.riskClass,
      expectedMechanism: template.expectedMechanism,
      affectedDomains: Object.freeze([...template.affectedDomains]),
      createdByActorId: template.createdByActorId,
      evidence: Object.freeze(canonicalEvidence),
      modelSelfReportExcluded: true as const,
    })];
  });
}

function groupRoomObservations(
  observations: readonly RoomEvolutionOutcomeObservationV1[],
): readonly (readonly [string, string, readonly RoomEvolutionOutcomeObservationV1[]])[] {
  const byRoom = new Map<string, RoomEvolutionOutcomeObservationV1[]>();
  for (const observation of observations) {
    const group = byRoom.get(observation.roomId) ?? [];
    group.push(observation);
    byRoom.set(observation.roomId, group);
  }
  return [...byRoom.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([roomId, roomObservations]) => [
      `room:${roomId}`,
      roomId,
      roomObservations,
    ] as const);
}

function toEvidenceReference(
  observation: RoomEvolutionOutcomeObservationV1,
): RoomEvolutionHypothesisEvidenceReferenceV1 {
  return Object.freeze({
    observationId: observation.id,
    kind: observation.kind,
    sourceRef: observation.sourceRef,
    evidenceHash: observation.evidenceHash,
    observedAt: observation.observedAt,
  });
}

function parseTemplate(
  value: unknown,
  path: string,
  identifiers: Set<string>,
  issues: RoomEvolutionHypothesisDerivationIssueV1[],
): RoomEvolutionHypothesisTemplateV1 | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "contractVersion",
    "id",
    "scopeKind",
    "revision",
    "triggerSignalKinds",
    "minimumObservationCount",
    "declaredScope",
    "riskClass",
    "expectedMechanism",
    "affectedDomains",
    "createdByActorId",
  ])) {
    issues.push(issue("invalid_template", path, "Template must have the exact v1 shape"));
    return null;
  }
  if (value.contractVersion !== ROOM_EVOLUTION_HYPOTHESIS_DERIVATION_CONTRACT_VERSION) {
    issues.push(issue("invalid_template", `${path}.contractVersion`, "Template contract version is unsupported"));
  }
  if (!isIdentifier(value.id)) {
    issues.push(issue("invalid_template", `${path}.id`, "Template id must be a canonical identifier"));
  } else if (identifiers.has(value.id)) {
    issues.push(issue("duplicate_template", `${path}.id`, "Template ids must be unique"));
  } else {
    identifiers.add(value.id);
  }
  if (value.scopeKind !== "project" && value.scopeKind !== "room") {
    issues.push(issue("invalid_template", `${path}.scopeKind`, "Scope kind must be project or room"));
  }
  if (!isPositiveSafeInteger(value.revision)) {
    issues.push(issue("invalid_template", `${path}.revision`, "Revision must be a positive safe integer"));
  }
  if (!isCanonicalSignalKinds(value.triggerSignalKinds)) {
    issues.push(issue("invalid_template", `${path}.triggerSignalKinds`, "Triggers must be a non-empty unique canonical signal-kind list"));
  }
  if (!isPositiveSafeInteger(value.minimumObservationCount) || value.minimumObservationCount > MAX_EVIDENCE_REFS) {
    issues.push(issue("invalid_template", `${path}.minimumObservationCount`, `Minimum observation count must be between 1 and ${MAX_EVIDENCE_REFS}`));
  }
  if (!isCanonicalIdentifierList(value.declaredScope)) {
    issues.push(issue("invalid_template", `${path}.declaredScope`, "Declared scope must be a non-empty unique canonical identifier list"));
  }
  if (typeof value.riskClass !== "string" || !RISK_CLASSES.has(value.riskClass as RoomEvolutionHypothesisRiskClassV1)) {
    issues.push(issue("invalid_template", `${path}.riskClass`, "Risk class is unsupported"));
  }
  if (typeof value.expectedMechanism !== "string" || value.expectedMechanism.trim().length === 0 || value.expectedMechanism.length > 1000) {
    issues.push(issue("invalid_template", `${path}.expectedMechanism`, "Expected mechanism must be a bounded non-empty string"));
  }
  if (!isCanonicalIdentifierList(value.affectedDomains)) {
    issues.push(issue("invalid_template", `${path}.affectedDomains`, "Affected domains must be a non-empty unique canonical identifier list"));
  }
  if (!isIdentifier(value.createdByActorId)) {
    issues.push(issue("invalid_template", `${path}.createdByActorId`, "Creator actor id must be a canonical identifier"));
  }
  if (issues.some((entry) => entry.path === path || entry.path.startsWith(`${path}.`))) return null;
  const template = value as unknown as RoomEvolutionHypothesisTemplateV1;
  return Object.freeze({
    contractVersion: template.contractVersion,
    id: template.id,
    scopeKind: template.scopeKind,
    revision: template.revision,
    triggerSignalKinds: Object.freeze([...template.triggerSignalKinds]),
    minimumObservationCount: template.minimumObservationCount,
    declaredScope: Object.freeze([...template.declaredScope]),
    riskClass: template.riskClass,
    expectedMechanism: template.expectedMechanism,
    affectedDomains: Object.freeze([...template.affectedDomains]),
    createdByActorId: template.createdByActorId,
  });
}

function isOutcomeSignalSet(value: unknown): value is RoomEvolutionOutcomeSignalSetV1 {
  return isRecord(value)
    && value.contractVersion === ROOM_EVOLUTION_OUTCOME_SIGNAL_CONTRACT_VERSION
    && typeof value.projectId === "string"
    && typeof value.asOf === "string"
    && Array.isArray(value.observations)
    && value.modelSelfReportExcluded === true;
}

function isCanonicalSignalKinds(value: unknown): value is readonly RoomEvolutionOutcomeSignalKindV1[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((entry) => typeof entry === "string" && SIGNAL_KINDS.has(entry as RoomEvolutionOutcomeSignalKindV1))
    && new Set(value).size === value.length;
}

function isCanonicalIdentifierList(value: unknown): value is readonly string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((entry) => typeof entry === "string" && isIdentifier(entry))
    && new Set(value).size === value.length;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function issue(
  code: RoomEvolutionHypothesisDerivationIssueCodeV1,
  path: string,
  message: string,
): RoomEvolutionHypothesisDerivationIssueV1 {
  return Object.freeze({ code, path, message });
}

function success(value: readonly DerivedRoomEvolutionHypothesisV1[]): DeriveAuthorizedRoomEvolutionHypothesesResultV1 {
  return Object.freeze({ ok: true as const, value: Object.freeze([...value]) });
}

function failure(issues: readonly RoomEvolutionHypothesisDerivationIssueV1[]): DeriveAuthorizedRoomEvolutionHypothesesResultV1 {
  return Object.freeze({ ok: false as const, issues: Object.freeze([...issues]) });
}
