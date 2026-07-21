import {
  ROOM_PROTOCOL_TERMINALIZATION_ARTIFACT_REQUIREMENT_PREFIX_V1,
  ROOM_PROTOCOL_TERMINALIZATION_DELIVERY_REQUIREMENT_PREFIX_V1,
  type RoomProtocolExitConditionV1,
  type RoomProtocolGateV1,
} from "./room-contracts/protocol.js";

export const ROOM_TERMINALIZATION_OUTCOMES = [
  "completed",
  "completed_with_risks",
  "partial",
  "blocked",
  "cancelled",
  "failed",
] as const;

export type RoomTerminalizationOutcomeV1 = (typeof ROOM_TERMINALIZATION_OUTCOMES)[number];

export const ROOM_TERMINALIZATION_RISK_SEVERITIES = [
  "low",
  "medium",
  "high",
  "critical",
] as const;

export type RoomTerminalizationRiskSeverityV1 =
  (typeof ROOM_TERMINALIZATION_RISK_SEVERITIES)[number];

export type RoomTerminalizationGateStatusV1 = "passed" | "failed" | "pending";
export type RoomTerminalizationDeliveryStatusV1 =
  | "confirmed"
  | "delivery_uncertain"
  | "failed";

export type RoomTerminalizationProtocolGateV1 = Pick<RoomProtocolGateV1, "id"> &
  Partial<Pick<RoomProtocolGateV1, "hard" | "evidenceRequirements">>;

/** The protocol fragment required by this pure terminalization policy. */
export interface RoomTerminalizationProtocolV1 {
  readonly id: string;
  readonly version: number;
  readonly gates: readonly RoomTerminalizationProtocolGateV1[];
  readonly exitConditions: readonly RoomProtocolExitConditionV1[];
}

/**
 * A recorded gate result from the authoritative Room gate ledger.
 * It intentionally does not accept a caller-provided `passedGateIds` assertion.
 */
export interface RoomAuthoritativeGateEvidenceV1 {
  readonly gateId: string;
  readonly status: RoomTerminalizationGateStatusV1;
  readonly evidenceRef: string;
  readonly evaluatorBindingIds: readonly string[];
}

export interface RoomAuthoritativeArtifactEvidenceV1 {
  readonly gateId: string;
  readonly artifactId: string;
  readonly artifactRef: string;
}

export interface RoomAuthoritativeDeliveryEvidenceV1 {
  readonly gateId: string;
  readonly deliveryId: string;
  readonly status: RoomTerminalizationDeliveryStatusV1;
  readonly evidenceRef: string;
}

export interface RoomUnresolvedRiskV1 {
  readonly id: string;
  readonly severity: RoomTerminalizationRiskSeverityV1;
  readonly evidenceRef: string;
  readonly acceptedByBindingId?: string;
  readonly acceptanceEvidenceRef?: string;
}

export interface RoomUnresolvedDissentV1 {
  readonly id: string;
  readonly severity: RoomTerminalizationRiskSeverityV1;
  readonly evidenceRef: string;
  readonly acceptedByBindingId?: string;
  readonly acceptanceEvidenceRef?: string;
}

/**
 * This is an already-authoritative evidence set supplied by the Room ledger layer.
 * Authenticating or persisting the ledger is intentionally outside this pure policy.
 */
export interface RoomAuthoritativeGateEvidenceSetV1 {
  readonly source: "room_gate_ledger";
  readonly evidenceSetId: string;
  readonly protocolId: string;
  readonly protocolVersion: number;
  readonly producerBindingIds: readonly string[];
  readonly gateResults: readonly RoomAuthoritativeGateEvidenceV1[];
  readonly artifactEvidence?: readonly RoomAuthoritativeArtifactEvidenceV1[];
  readonly deliveryEvidence?: readonly RoomAuthoritativeDeliveryEvidenceV1[];
  readonly unresolvedRisks: readonly RoomUnresolvedRiskV1[];
  readonly unresolvedDissents?: readonly RoomUnresolvedDissentV1[];
}

export interface EvaluateRoomTerminalizationInputV1 {
  readonly requestedOutcome: RoomTerminalizationOutcomeV1;
  readonly protocol: RoomTerminalizationProtocolV1;
  readonly evidence: RoomAuthoritativeGateEvidenceSetV1;
}

export type RoomTerminalizationUnmetReasonCodeV1 =
  | "invalid_terminalization_input"
  | "invalid_protocol_identity"
  | "invalid_protocol_gates"
  | "invalid_protocol_gate_semantics"
  | "duplicate_protocol_gate_id"
  | "invalid_terminal_evidence_requirement"
  | "duplicate_terminal_evidence_requirement"
  | "invalid_exit_condition"
  | "duplicate_exit_condition"
  | "missing_declared_exit_condition"
  | "undeclared_required_gate"
  | "invalid_authoritative_gate_evidence_set"
  | "protocol_evidence_mismatch"
  | "invalid_gate_evidence"
  | "duplicate_gate_evidence"
  | "undeclared_gate_evidence"
  | "missing_required_gate_evidence"
  | "required_gate_not_passed"
  | "hard_gate_failed"
  | "missing_producer_binding_identities"
  | "independent_verifier_required"
  | "invalid_artifact_evidence"
  | "duplicate_artifact_evidence"
  | "undeclared_artifact_evidence"
  | "missing_required_artifact_evidence"
  | "invalid_delivery_evidence"
  | "duplicate_delivery_evidence"
  | "undeclared_delivery_evidence"
  | "missing_required_delivery_evidence"
  | "required_delivery_not_confirmed"
  | "invalid_unresolved_risk"
  | "duplicate_unresolved_risk"
  | "critical_unresolved_risk"
  | "unresolved_risk_not_allowed"
  | "unresolved_risk_acceptance_required"
  | "unresolved_risk_self_accepted"
  | "invalid_unresolved_dissent"
  | "duplicate_unresolved_dissent"
  | "critical_dissent_unresolved"
  | "unresolved_dissent_not_allowed"
  | "unresolved_dissent_acceptance_required"
  | "unresolved_dissent_self_accepted"
  | "completed_with_risks_requires_unresolved_risk";

export interface RoomTerminalizationUnmetReasonV1 {
  readonly code: RoomTerminalizationUnmetReasonCodeV1;
  readonly path: string;
  readonly message: string;
}

export interface RoomTerminalizationDecisionV1 {
  readonly canTerminalize: boolean;
  readonly outcome: RoomTerminalizationOutcomeV1 | null;
  readonly unmetReasons: readonly RoomTerminalizationUnmetReasonV1[];
}

interface ParsedExitCondition {
  readonly outcome: RoomTerminalizationOutcomeV1 | null;
  readonly requiredGateIds: readonly string[];
  readonly requireIndependentVerifier: boolean;
  readonly allowedUnresolvedRiskSeverities: readonly ("low" | "medium")[];
  readonly valid: boolean;
}

interface ParsedProtocolGate {
  readonly id: string;
  readonly hard: boolean;
  readonly requiredArtifactIds: readonly string[];
  readonly requiredDeliveryIds: readonly string[];
  readonly requiresDissentLedger: boolean;
  readonly valid: boolean;
}

interface ParsedGateEvidence {
  readonly gateId: string;
  readonly status: RoomTerminalizationGateStatusV1;
  readonly evaluatorBindingIds: readonly string[];
}

interface ParsedArtifactEvidence {
  readonly gateId: string;
  readonly artifactId: string;
}

interface ParsedDeliveryEvidence {
  readonly gateId: string;
  readonly deliveryId: string;
  readonly status: RoomTerminalizationDeliveryStatusV1;
}

interface ParsedResidualEvidence {
  readonly id: string;
  readonly severity: RoomTerminalizationRiskSeverityV1;
  readonly acceptedByBindingId: string | null;
  readonly acceptanceEvidenceRef: string | null;
}

const TERMINAL_OUTCOME_SET = new Set<string>(ROOM_TERMINALIZATION_OUTCOMES);
const RISK_SEVERITY_SET = new Set<string>(ROOM_TERMINALIZATION_RISK_SEVERITIES);
const GATE_STATUS_SET = new Set<string>(["passed", "failed", "pending"]);
const DELIVERY_STATUS_SET = new Set<string>(["confirmed", "delivery_uncertain", "failed"]);
const EXIT_RISK_SEVERITY_SET = new Set<string>(["low", "medium"]);
const ACCEPTANCE_OUTCOME_SET = new Set<RoomTerminalizationOutcomeV1>([
  "completed",
  "completed_with_risks",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isTerminalizationOutcome(value: unknown): value is RoomTerminalizationOutcomeV1 {
  return typeof value === "string" && TERMINAL_OUTCOME_SET.has(value);
}

function isRiskSeverity(value: unknown): value is RoomTerminalizationRiskSeverityV1 {
  return typeof value === "string" && RISK_SEVERITY_SET.has(value);
}

function isGateStatus(value: unknown): value is RoomTerminalizationGateStatusV1 {
  return typeof value === "string" && GATE_STATUS_SET.has(value);
}

function isDeliveryStatus(value: unknown): value is RoomTerminalizationDeliveryStatusV1 {
  return typeof value === "string" && DELIVERY_STATUS_SET.has(value);
}

function addReason(
  reasons: RoomTerminalizationUnmetReasonV1[],
  code: RoomTerminalizationUnmetReasonCodeV1,
  path: string,
  message: string,
): void {
  reasons.push({ code, path, message });
}

function requirementKey(gateId: string, requirementId: string): string {
  return `${gateId}\u0000${requirementId}`;
}

function isAcceptanceOutcome(outcome: RoomTerminalizationOutcomeV1): boolean {
  return ACCEPTANCE_OUTCOME_SET.has(outcome);
}

function parseExitCondition(
  value: unknown,
  path: string,
  reasons: RoomTerminalizationUnmetReasonV1[],
): ParsedExitCondition {
  if (!isRecord(value)) {
    addReason(reasons, "invalid_exit_condition", path, "A protocol exit condition must be an object");
    return {
      outcome: null,
      requiredGateIds: [],
      requireIndependentVerifier: false,
      allowedUnresolvedRiskSeverities: [],
      valid: false,
    };
  }

  let valid = true;
  const outcome = isTerminalizationOutcome(value.outcome) ? value.outcome : null;
  if (!outcome) {
    addReason(
      reasons,
      "invalid_exit_condition",
      `${path}.outcome`,
      "An exit condition must declare one supported terminal outcome",
    );
    valid = false;
  }

  const requiredGateIds: string[] = [];
  const rawRequiredGateIds = value.requiredGateIds;
  if (!Array.isArray(rawRequiredGateIds) || rawRequiredGateIds.length === 0) {
    addReason(
      reasons,
      "invalid_exit_condition",
      `${path}.requiredGateIds`,
      "An exit condition must declare at least one required gate identity",
    );
    valid = false;
  } else {
    const seenGateIds = new Set<string>();
    rawRequiredGateIds.forEach((gateId, index) => {
      if (!isNonEmptyString(gateId)) {
        addReason(
          reasons,
          "invalid_exit_condition",
          `${path}.requiredGateIds[${index}]`,
          "A required gate identity must be a non-empty string",
        );
        valid = false;
        return;
      }
      if (seenGateIds.has(gateId)) {
        addReason(
          reasons,
          "invalid_exit_condition",
          `${path}.requiredGateIds[${index}]`,
          `Required gate ${gateId} is declared more than once`,
        );
        valid = false;
        return;
      }
      seenGateIds.add(gateId);
      requiredGateIds.push(gateId);
    });
  }

  const requireIndependentVerifier = value.requireIndependentVerifier;
  if (typeof requireIndependentVerifier !== "boolean") {
    addReason(
      reasons,
      "invalid_exit_condition",
      `${path}.requireIndependentVerifier`,
      "An exit condition must explicitly declare whether an independent verifier is required",
    );
    valid = false;
  }

  const allowedUnresolvedRiskSeverities: ("low" | "medium")[] = [];
  if (value.allowUnresolvedRiskSeverities !== undefined) {
    if (!Array.isArray(value.allowUnresolvedRiskSeverities)) {
      addReason(
        reasons,
        "invalid_exit_condition",
        `${path}.allowUnresolvedRiskSeverities`,
        "Allowed unresolved risk severities must be an array when declared",
      );
      valid = false;
    } else {
      const seenSeverities = new Set<string>();
      value.allowUnresolvedRiskSeverities.forEach((severity, index) => {
        if (typeof severity !== "string" || !EXIT_RISK_SEVERITY_SET.has(severity)) {
          addReason(
            reasons,
            "invalid_exit_condition",
            `${path}.allowUnresolvedRiskSeverities[${index}]`,
            "Only low or medium unresolved risks may be allowed by an exit condition",
          );
          valid = false;
          return;
        }
        if (seenSeverities.has(severity)) {
          addReason(
            reasons,
            "invalid_exit_condition",
            `${path}.allowUnresolvedRiskSeverities[${index}]`,
            `Allowed unresolved risk severity ${severity} is declared more than once`,
          );
          valid = false;
          return;
        }
        seenSeverities.add(severity);
        allowedUnresolvedRiskSeverities.push(severity as "low" | "medium");
      });
    }
  }

  return {
    outcome,
    requiredGateIds,
    requireIndependentVerifier: requireIndependentVerifier === true,
    allowedUnresolvedRiskSeverities,
    valid,
  };
}

function parseProtocolGate(
  value: unknown,
  path: string,
  reasons: RoomTerminalizationUnmetReasonV1[],
): ParsedProtocolGate | null {
  if (!isRecord(value) || !isNonEmptyString(value.id)) {
    addReason(
      reasons,
      "invalid_protocol_gates",
      path + ".id",
      "Every declared protocol gate requires a non-empty id",
    );
    return null;
  }

  let valid = true;
  if (value.hard !== undefined && typeof value.hard !== "boolean") {
    addReason(
      reasons,
      "invalid_protocol_gate_semantics",
      path + ".hard",
      "A declared hard-gate value must be boolean",
    );
    valid = false;
  }

  const requiredArtifactIds: string[] = [];
  const requiredDeliveryIds: string[] = [];
  let requiresDissentLedger = false;
  if (value.evidenceRequirements !== undefined) {
    if (!Array.isArray(value.evidenceRequirements)) {
      addReason(
        reasons,
        "invalid_protocol_gate_semantics",
        path + ".evidenceRequirements",
        "Gate evidence requirements must be an array when declared",
      );
      valid = false;
    } else {
      const seenArtifactIds = new Set<string>();
      const seenDeliveryIds = new Set<string>();
      value.evidenceRequirements.forEach((requirement, index) => {
        const requirementPath = path + ".evidenceRequirements[" + index + "]";
        if (!isNonEmptyString(requirement)) {
          addReason(
            reasons,
            "invalid_protocol_gate_semantics",
            requirementPath,
            "A gate evidence requirement must be a non-empty string",
          );
          valid = false;
          return;
        }
        if (requirement === "resolved_dissent" || requirement === "accepted_residual_risk") {
          requiresDissentLedger = true;
        }
        if (
          requirement.startsWith(
            ROOM_PROTOCOL_TERMINALIZATION_ARTIFACT_REQUIREMENT_PREFIX_V1,
          )
        ) {
          const artifactId = requirement
            .slice(ROOM_PROTOCOL_TERMINALIZATION_ARTIFACT_REQUIREMENT_PREFIX_V1.length)
            .trim();
          if (!artifactId) {
            addReason(
              reasons,
              "invalid_terminal_evidence_requirement",
              requirementPath,
              "An artifact terminalization requirement must name an artifact id",
            );
            valid = false;
            return;
          }
          if (seenArtifactIds.has(artifactId)) {
            addReason(
              reasons,
              "duplicate_terminal_evidence_requirement",
              requirementPath,
              "Artifact terminalization requirement " + artifactId + " is declared more than once",
            );
            valid = false;
            return;
          }
          seenArtifactIds.add(artifactId);
          requiredArtifactIds.push(artifactId);
          return;
        }
        if (
          requirement.startsWith(
            ROOM_PROTOCOL_TERMINALIZATION_DELIVERY_REQUIREMENT_PREFIX_V1,
          )
        ) {
          const deliveryId = requirement
            .slice(ROOM_PROTOCOL_TERMINALIZATION_DELIVERY_REQUIREMENT_PREFIX_V1.length)
            .trim();
          if (!deliveryId) {
            addReason(
              reasons,
              "invalid_terminal_evidence_requirement",
              requirementPath,
              "A delivery terminalization requirement must name a delivery id",
            );
            valid = false;
            return;
          }
          if (seenDeliveryIds.has(deliveryId)) {
            addReason(
              reasons,
              "duplicate_terminal_evidence_requirement",
              requirementPath,
              "Delivery terminalization requirement " + deliveryId + " is declared more than once",
            );
            valid = false;
            return;
          }
          seenDeliveryIds.add(deliveryId);
          requiredDeliveryIds.push(deliveryId);
        }
      });
    }
  }

  return {
    id: value.id,
    hard: value.hard === true,
    requiredArtifactIds,
    requiredDeliveryIds,
    requiresDissentLedger,
    valid,
  };
}

function parseArtifactEvidence(
  rawArtifactEvidence: unknown,
  declaredGatesById: ReadonlyMap<string, ParsedProtocolGate>,
  reasons: RoomTerminalizationUnmetReasonV1[],
): ReadonlyMap<string, ParsedArtifactEvidence> {
  const artifactEvidenceByRequirement = new Map<string, ParsedArtifactEvidence>();
  if (rawArtifactEvidence === undefined) return artifactEvidenceByRequirement;
  if (!Array.isArray(rawArtifactEvidence)) {
    addReason(
      reasons,
      "invalid_authoritative_gate_evidence_set",
      "$.evidence.artifactEvidence",
      "Evidence must provide artifact evidence as an array",
    );
    return artifactEvidenceByRequirement;
  }
  rawArtifactEvidence.forEach((artifactEvidence, index) => {
    const path = "$.evidence.artifactEvidence[" + index + "]";
    if (!isRecord(artifactEvidence)) {
      addReason(
        reasons,
        "invalid_artifact_evidence",
        path,
        "Artifact evidence must be an object",
      );
      return;
    }
    const gateId = artifactEvidence.gateId;
    const artifactId = artifactEvidence.artifactId;
    if (
      !isNonEmptyString(gateId) ||
      !isNonEmptyString(artifactId) ||
      !isNonEmptyString(artifactEvidence.artifactRef)
    ) {
      addReason(
        reasons,
        "invalid_artifact_evidence",
        path,
        "Artifact evidence requires non-empty gateId, artifactId, and artifactRef",
      );
      return;
    }
    const declaredGate = declaredGatesById.get(gateId);
    if (!declaredGate || !declaredGate.requiredArtifactIds.includes(artifactId)) {
      addReason(
        reasons,
        "undeclared_artifact_evidence",
        path,
        "Artifact evidence " + artifactId + " is not required by declared gate " + gateId,
      );
      return;
    }
    const key = requirementKey(gateId, artifactId);
    if (artifactEvidenceByRequirement.has(key)) {
      addReason(
        reasons,
        "duplicate_artifact_evidence",
        path,
        "Artifact evidence " + artifactId + " for gate " + gateId + " is recorded more than once",
      );
      return;
    }
    artifactEvidenceByRequirement.set(key, { gateId, artifactId });
  });
  return artifactEvidenceByRequirement;
}

function parseDeliveryEvidence(
  rawDeliveryEvidence: unknown,
  declaredGatesById: ReadonlyMap<string, ParsedProtocolGate>,
  reasons: RoomTerminalizationUnmetReasonV1[],
): ReadonlyMap<string, ParsedDeliveryEvidence> {
  const deliveryEvidenceByRequirement = new Map<string, ParsedDeliveryEvidence>();
  if (rawDeliveryEvidence === undefined) return deliveryEvidenceByRequirement;
  if (!Array.isArray(rawDeliveryEvidence)) {
    addReason(
      reasons,
      "invalid_authoritative_gate_evidence_set",
      "$.evidence.deliveryEvidence",
      "Evidence must provide delivery evidence as an array",
    );
    return deliveryEvidenceByRequirement;
  }
  rawDeliveryEvidence.forEach((deliveryEvidence, index) => {
    const path = "$.evidence.deliveryEvidence[" + index + "]";
    if (!isRecord(deliveryEvidence)) {
      addReason(
        reasons,
        "invalid_delivery_evidence",
        path,
        "Delivery evidence must be an object",
      );
      return;
    }
    const gateId = deliveryEvidence.gateId;
    const deliveryId = deliveryEvidence.deliveryId;
    if (
      !isNonEmptyString(gateId) ||
      !isNonEmptyString(deliveryId) ||
      !isDeliveryStatus(deliveryEvidence.status) ||
      !isNonEmptyString(deliveryEvidence.evidenceRef)
    ) {
      addReason(
        reasons,
        "invalid_delivery_evidence",
        path,
        "Delivery evidence requires non-empty gateId, deliveryId, evidenceRef, and a supported status",
      );
      return;
    }
    const declaredGate = declaredGatesById.get(gateId);
    if (!declaredGate || !declaredGate.requiredDeliveryIds.includes(deliveryId)) {
      addReason(
        reasons,
        "undeclared_delivery_evidence",
        path,
        "Delivery evidence " + deliveryId + " is not required by declared gate " + gateId,
      );
      return;
    }
    const key = requirementKey(gateId, deliveryId);
    if (deliveryEvidenceByRequirement.has(key)) {
      addReason(
        reasons,
        "duplicate_delivery_evidence",
        path,
        "Delivery evidence " + deliveryId + " for gate " + gateId + " is recorded more than once",
      );
      return;
    }
    deliveryEvidenceByRequirement.set(key, {
      gateId,
      deliveryId,
      status: deliveryEvidence.status,
    });
  });
  return deliveryEvidenceByRequirement;
}

function parseResidualEvidence(
  rawResidualEvidence: unknown,
  path: string,
  kind: "risk" | "dissent",
  required: boolean,
  reasons: RoomTerminalizationUnmetReasonV1[],
): readonly ParsedResidualEvidence[] {
  if (rawResidualEvidence === undefined && !required) return [];
  if (!Array.isArray(rawResidualEvidence)) {
    addReason(
      reasons,
      "invalid_authoritative_gate_evidence_set",
      path,
      "Evidence must provide unresolved " + kind + "s as an array",
    );
    return [];
  }

  const parsed: ParsedResidualEvidence[] = [];
  const seenIds = new Set<string>();
  rawResidualEvidence.forEach((residual, index) => {
    const residualPath = path + "[" + index + "]";
    const invalidCode =
      kind === "risk" ? "invalid_unresolved_risk" : "invalid_unresolved_dissent";
    const duplicateCode =
      kind === "risk" ? "duplicate_unresolved_risk" : "duplicate_unresolved_dissent";
    if (
      !isRecord(residual) ||
      !isNonEmptyString(residual.id) ||
      !isRiskSeverity(residual.severity) ||
      !isNonEmptyString(residual.evidenceRef)
    ) {
      addReason(
        reasons,
        invalidCode,
        residualPath,
        "An unresolved " + kind + " requires a non-empty id, evidence reference, and supported severity",
      );
      return;
    }
    if (seenIds.has(residual.id)) {
      addReason(
        reasons,
        duplicateCode,
        residualPath + ".id",
        "Unresolved " + kind + " " + residual.id + " is recorded more than once",
      );
      return;
    }

    const acceptedByBindingId = isNonEmptyString(residual.acceptedByBindingId)
      ? residual.acceptedByBindingId
      : null;
    const acceptanceEvidenceRef = isNonEmptyString(residual.acceptanceEvidenceRef)
      ? residual.acceptanceEvidenceRef
      : null;
    if (
      (residual.acceptedByBindingId !== undefined ||
        residual.acceptanceEvidenceRef !== undefined) &&
      (!acceptedByBindingId || !acceptanceEvidenceRef)
    ) {
      addReason(
        reasons,
        invalidCode,
        residualPath,
        "An unresolved " + kind + " acceptance must provide both a binding identity and evidence reference",
      );
      return;
    }

    seenIds.add(residual.id);
    parsed.push({
      id: residual.id,
      severity: residual.severity,
      acceptedByBindingId,
      acceptanceEvidenceRef,
    });
  });
  return parsed;
}

function validateResidualAcceptance(
  residual: ParsedResidualEvidence,
  path: string,
  kind: "risk" | "dissent",
  producerBindings: ReadonlySet<string>,
  reasons: RoomTerminalizationUnmetReasonV1[],
): void {
  const missingCode =
    kind === "risk"
      ? "unresolved_risk_acceptance_required"
      : "unresolved_dissent_acceptance_required";
  const selfAcceptedCode =
    kind === "risk" ? "unresolved_risk_self_accepted" : "unresolved_dissent_self_accepted";
  if (!residual.acceptedByBindingId || !residual.acceptanceEvidenceRef) {
    addReason(
      reasons,
      missingCode,
      path,
      "completed_with_risks requires authoritative non-producer acceptance for unresolved " +
        kind +
        " " +
        residual.id,
    );
    return;
  }
  if (producerBindings.has(residual.acceptedByBindingId)) {
    addReason(
      reasons,
      selfAcceptedCode,
      path + ".acceptedByBindingId",
      "A producer binding cannot self-accept unresolved " + kind + " " + residual.id,
    );
  }
}

/*
FNXC:RoomTerminalization 2026-07-18-00:15:
Task 5.10 permits terminalization only from a protocol-version-matched Room
ledger. Required gates plus declared artifact, delivery, and dissent proof are
checked here so a caller assertion cannot become acceptance.

FNXC:RoomTerminalization 2026-07-18-00:16:
Hard-gate failure blocks successful completion even if an unrelated acceptance
gate passed. Independent verification remains conditional on the declared exit
rule, while residual-risk acceptance is always outside producer bindings. A
failed non-selected terminal discriminator only proves that other outcome did
not occur; it is not treated as a failed acceptance hard gate.
*/
export function evaluateRoomTerminalization(
  input: EvaluateRoomTerminalizationInputV1,
): RoomTerminalizationDecisionV1 {
  const reasons: RoomTerminalizationUnmetReasonV1[] = [];
  const unsafeInput = input as unknown;
  if (!isRecord(unsafeInput)) {
    addReason(
      reasons,
      "invalid_terminalization_input",
      "$",
      "Terminalization input must be an object",
    );
    return { canTerminalize: false, outcome: null, unmetReasons: reasons };
  }

  const requestedOutcome = isTerminalizationOutcome(unsafeInput.requestedOutcome)
    ? unsafeInput.requestedOutcome
    : null;
  if (!requestedOutcome) {
    addReason(
      reasons,
      "invalid_terminalization_input",
      "$.requestedOutcome",
      "A supported requested terminal outcome is required",
    );
  }

  const protocol = isRecord(unsafeInput.protocol) ? unsafeInput.protocol : null;
  if (!protocol) {
    addReason(reasons, "invalid_protocol_identity", "$.protocol", "A protocol object is required");
  }

  const protocolId = protocol?.id;
  const protocolVersion = protocol?.version;
  const hasProtocolIdentity = isNonEmptyString(protocolId) && isPositiveSafeInteger(protocolVersion);
  if (protocol && !hasProtocolIdentity) {
    addReason(
      reasons,
      "invalid_protocol_identity",
      "$.protocol",
      "A protocol requires a non-empty id and positive integer version",
    );
  }

  const declaredGatesById = new Map<string, ParsedProtocolGate>();
  const rawProtocolGates = protocol?.gates;
  if (!Array.isArray(rawProtocolGates)) {
    addReason(
      reasons,
      "invalid_protocol_gates",
      "$.protocol.gates",
      "A protocol requires a gates array",
    );
  } else {
    rawProtocolGates.forEach((gate, index) => {
      const parsed = parseProtocolGate(gate, "$.protocol.gates[" + index + "]", reasons);
      if (!parsed) return;
      if (declaredGatesById.has(parsed.id)) {
        addReason(
          reasons,
          "duplicate_protocol_gate_id",
          "$.protocol.gates[" + index + "].id",
          "Protocol gate " + parsed.id + " is declared more than once",
        );
        return;
      }
      declaredGatesById.set(parsed.id, parsed);
    });
  }

  const exitConditionsByOutcome = new Map<RoomTerminalizationOutcomeV1, ParsedExitCondition>();
  const rawExitConditions = protocol?.exitConditions;
  if (!Array.isArray(rawExitConditions)) {
    addReason(
      reasons,
      "invalid_exit_condition",
      "$.protocol.exitConditions",
      "A protocol requires an exitConditions array",
    );
  } else {
    rawExitConditions.forEach((exitCondition, index) => {
      const parsed = parseExitCondition(
        exitCondition,
        `$.protocol.exitConditions[${index}]`,
        reasons,
      );
      if (!parsed.outcome) return;
      const prior = exitConditionsByOutcome.get(parsed.outcome);
      if (prior) {
        addReason(
          reasons,
          "duplicate_exit_condition",
          `$.protocol.exitConditions[${index}].outcome`,
          `Terminal outcome ${parsed.outcome} has more than one exit condition`,
        );
        exitConditionsByOutcome.set(parsed.outcome, { ...prior, valid: false });
        return;
      }
      exitConditionsByOutcome.set(parsed.outcome, parsed);
    });
  }

  const exitCondition = requestedOutcome
    ? exitConditionsByOutcome.get(requestedOutcome)
    : undefined;
  if (requestedOutcome && !exitCondition) {
    addReason(
      reasons,
      "missing_declared_exit_condition",
      "$.protocol.exitConditions",
      `Protocol does not declare an exit condition for ${requestedOutcome}`,
    );
  }

  const evidence = isRecord(unsafeInput.evidence) ? unsafeInput.evidence : null;
  if (!evidence) {
    addReason(
      reasons,
      "invalid_authoritative_gate_evidence_set",
      "$.evidence",
      "An authoritative Room gate-ledger evidence set is required",
    );
  }

  if (
    evidence
    && (evidence.source !== "room_gate_ledger" || !isNonEmptyString(evidence.evidenceSetId))
  ) {
    addReason(
      reasons,
      "invalid_authoritative_gate_evidence_set",
      "$.evidence",
      "Evidence must identify a non-empty authoritative Room gate-ledger set",
    );
  }

  const evidenceProtocolId = evidence?.protocolId;
  const evidenceProtocolVersion = evidence?.protocolVersion;
  const hasEvidenceProtocolIdentity = isNonEmptyString(evidenceProtocolId)
    && isPositiveSafeInteger(evidenceProtocolVersion);
  if (evidence && !hasEvidenceProtocolIdentity) {
    addReason(
      reasons,
      "invalid_authoritative_gate_evidence_set",
      "$.evidence",
      "Evidence must identify a non-empty protocol id and positive integer version",
    );
  }
  if (
    hasProtocolIdentity
    && hasEvidenceProtocolIdentity
    && (protocolId !== evidenceProtocolId || protocolVersion !== evidenceProtocolVersion)
  ) {
    addReason(
      reasons,
      "protocol_evidence_mismatch",
      "$.evidence",
      "Authoritative gate evidence must match the exact declared protocol id and version",
    );
  }

  const producerBindingIds: string[] = [];
  let producerBindingsValid = true;
  const rawProducerBindingIds = evidence?.producerBindingIds;
  if (!Array.isArray(rawProducerBindingIds)) {
    addReason(
      reasons,
      "invalid_authoritative_gate_evidence_set",
      "$.evidence.producerBindingIds",
      "Evidence must provide producer binding identities as an array",
    );
    producerBindingsValid = false;
  } else {
    const seenProducerBindingIds = new Set<string>();
    rawProducerBindingIds.forEach((bindingId, index) => {
      if (!isNonEmptyString(bindingId)) {
        addReason(
          reasons,
          "invalid_authoritative_gate_evidence_set",
          `$.evidence.producerBindingIds[${index}]`,
          "A producer binding identity must be a non-empty string",
        );
        producerBindingsValid = false;
        return;
      }
      if (seenProducerBindingIds.has(bindingId)) {
        addReason(
          reasons,
          "invalid_authoritative_gate_evidence_set",
          `$.evidence.producerBindingIds[${index}]`,
          `Producer binding ${bindingId} is recorded more than once`,
        );
        producerBindingsValid = false;
        return;
      }
      seenProducerBindingIds.add(bindingId);
      producerBindingIds.push(bindingId);
    });
  }

  const gateEvidenceById = new Map<string, ParsedGateEvidence>();
  const rawGateResults = evidence?.gateResults;
  if (!Array.isArray(rawGateResults)) {
    addReason(
      reasons,
      "invalid_authoritative_gate_evidence_set",
      "$.evidence.gateResults",
      "Evidence must provide gate results as an array",
    );
  } else {
    rawGateResults.forEach((gateEvidence, index) => {
      const path = `$.evidence.gateResults[${index}]`;
      if (!isRecord(gateEvidence)) {
        addReason(reasons, "invalid_gate_evidence", path, "A gate result must be an object");
        return;
      }
      const gateId = gateEvidence.gateId;
      const status = gateEvidence.status;
      const evaluatorBindingIds = gateEvidence.evaluatorBindingIds;
      let valid = true;
      if (!isNonEmptyString(gateId)) {
        addReason(
          reasons,
          "invalid_gate_evidence",
          `${path}.gateId`,
          "A gate result must identify a non-empty gate id",
        );
        valid = false;
      }
      if (!isGateStatus(status)) {
        addReason(
          reasons,
          "invalid_gate_evidence",
          `${path}.status`,
          "A gate result must record passed, failed, or pending status",
        );
        valid = false;
      }
      if (!isNonEmptyString(gateEvidence.evidenceRef)) {
        addReason(
          reasons,
          "invalid_gate_evidence",
          `${path}.evidenceRef`,
          "A gate result must retain its authoritative evidence reference",
        );
        valid = false;
      }
      const validEvaluatorBindingIds: string[] = [];
      if (!Array.isArray(evaluatorBindingIds)) {
        addReason(
          reasons,
          "invalid_gate_evidence",
          `${path}.evaluatorBindingIds`,
          "A gate result must provide evaluator binding identities as an array",
        );
        valid = false;
      } else {
        const seenEvaluatorBindingIds = new Set<string>();
        evaluatorBindingIds.forEach((bindingId, evaluatorIndex) => {
          if (!isNonEmptyString(bindingId)) {
            addReason(
              reasons,
              "invalid_gate_evidence",
              `${path}.evaluatorBindingIds[${evaluatorIndex}]`,
              "An evaluator binding identity must be a non-empty string",
            );
            valid = false;
            return;
          }
          if (seenEvaluatorBindingIds.has(bindingId)) {
            addReason(
              reasons,
              "invalid_gate_evidence",
              `${path}.evaluatorBindingIds[${evaluatorIndex}]`,
              `Evaluator binding ${bindingId} is recorded more than once`,
            );
            valid = false;
            return;
          }
          seenEvaluatorBindingIds.add(bindingId);
          validEvaluatorBindingIds.push(bindingId);
        });
      }
      if (!valid || !isNonEmptyString(gateId) || !isGateStatus(status)) return;
      if (!declaredGatesById.has(gateId)) {
        addReason(
          reasons,
          "undeclared_gate_evidence",
          `${path}.gateId`,
          `Gate evidence references undeclared gate ${gateId}`,
        );
        return;
      }
      if (gateEvidenceById.has(gateId)) {
        addReason(
          reasons,
          "duplicate_gate_evidence",
          `${path}.gateId`,
          `Gate evidence for ${gateId} is recorded more than once`,
        );
        return;
      }
      gateEvidenceById.set(gateId, {
        gateId,
        status,
        evaluatorBindingIds: validEvaluatorBindingIds,
      });
    });
  }

  const artifactEvidenceByRequirement = parseArtifactEvidence(
    evidence?.artifactEvidence,
    declaredGatesById,
    reasons,
  );
  const deliveryEvidenceByRequirement = parseDeliveryEvidence(
    evidence?.deliveryEvidence,
    declaredGatesById,
    reasons,
  );
  const unresolvedRisks = parseResidualEvidence(
    evidence?.unresolvedRisks,
    "$.evidence.unresolvedRisks",
    "risk",
    true,
    reasons,
  );
  const requiresDissentLedger =
    requestedOutcome === "completed_with_risks" ||
    (exitCondition?.valid === true &&
      exitCondition.requiredGateIds.some(
        (gateId) => declaredGatesById.get(gateId)?.requiresDissentLedger === true,
      ));
  const unresolvedDissents = parseResidualEvidence(
    evidence?.unresolvedDissents,
    "$.evidence.unresolvedDissents",
    "dissent",
    requiresDissentLedger,
    reasons,
  );

  if (exitCondition?.valid && requestedOutcome) {
    const requiredGateIds = [...exitCondition.requiredGateIds].sort((left, right) =>
      left.localeCompare(right),
    );
    for (const gateId of requiredGateIds) {
      const declaredGate = declaredGatesById.get(gateId);
      if (!declaredGate) {
        addReason(
          reasons,
          "undeclared_required_gate",
          "$.protocol.exitConditions",
          "Exit condition requires undeclared gate " + gateId,
        );
      }
      const gateEvidence = gateEvidenceById.get(gateId);
      if (!gateEvidence) {
        addReason(
          reasons,
          "missing_required_gate_evidence",
          "$.evidence.gateResults",
          "Exit condition requires authoritative evidence for gate " + gateId,
        );
      } else if (gateEvidence.status !== "passed") {
        addReason(
          reasons,
          "required_gate_not_passed",
          "$.evidence.gateResults." + gateId,
          "Required gate " + gateId + " is " + gateEvidence.status + ", not passed",
        );
      }

      for (const artifactId of declaredGate?.requiredArtifactIds ?? []) {
        if (artifactEvidenceByRequirement.has(requirementKey(gateId, artifactId))) continue;
        addReason(
          reasons,
          "missing_required_artifact_evidence",
          "$.evidence.artifactEvidence",
          "Exit condition requires authoritative artifact " + artifactId + " for gate " + gateId,
        );
      }
      for (const deliveryId of declaredGate?.requiredDeliveryIds ?? []) {
        const deliveryEvidence = deliveryEvidenceByRequirement.get(
          requirementKey(gateId, deliveryId),
        );
        if (!deliveryEvidence) {
          addReason(
            reasons,
            "missing_required_delivery_evidence",
            "$.evidence.deliveryEvidence",
            "Exit condition requires authoritative delivery " + deliveryId + " for gate " + gateId,
          );
        } else if (deliveryEvidence.status !== "confirmed") {
          addReason(
            reasons,
            "required_delivery_not_confirmed",
            "$.evidence.deliveryEvidence." + gateId + "." + deliveryId,
            "Required delivery " +
              deliveryId +
              " for gate " +
              gateId +
              " is " +
              deliveryEvidence.status,
          );
        }
      }
    }

    if (isAcceptanceOutcome(requestedOutcome)) {
      const terminalOutcomeGateIds = new Set(
        [...exitConditionsByOutcome.values()].flatMap((condition) => condition.requiredGateIds),
      );
      for (const gate of [...declaredGatesById.values()].sort((left, right) =>
        left.id.localeCompare(right.id),
      )) {
        if (
          !gate.hard ||
          gateEvidenceById.get(gate.id)?.status !== "failed" ||
          (terminalOutcomeGateIds.has(gate.id) && !requiredGateIds.includes(gate.id))
        ) {
          continue;
        }
        addReason(
          reasons,
          "hard_gate_failed",
          "$.evidence.gateResults." + gate.id,
          "Hard gate " + gate.id + " failed and blocks " + requestedOutcome,
        );
      }
    }

    if (exitCondition.requireIndependentVerifier) {
      if (!producerBindingsValid || producerBindingIds.length === 0) {
        addReason(
          reasons,
          "missing_producer_binding_identities",
          "$.evidence.producerBindingIds",
          "Independent verification requires recorded producer binding identities",
        );
      } else {
        const producerBindings = new Set(producerBindingIds);
        const hasIndependentVerifier = requiredGateIds.some((gateId) => {
          const gateEvidence = gateEvidenceById.get(gateId);
          return gateEvidence?.status === "passed"
            && gateEvidence.evaluatorBindingIds.some((bindingId) => !producerBindings.has(bindingId));
        });
        if (!hasIndependentVerifier) {
          addReason(
            reasons,
            "independent_verifier_required",
            "$.evidence.gateResults",
            "A declared independent verifier must pass a required gate from a non-producer binding",
          );
        }
      }
    }

    const allowedRiskSeverities = new Set<string>(
      exitCondition.allowedUnresolvedRiskSeverities,
    );
    const producerBindings = new Set(producerBindingIds);
    const requiresResidualAcceptance =
      requestedOutcome === "completed_with_risks" &&
      (unresolvedRisks.length > 0 || unresolvedDissents.length > 0);
    if (
      requiresResidualAcceptance &&
      (!producerBindingsValid || producerBindingIds.length === 0)
    ) {
      addReason(
        reasons,
        "missing_producer_binding_identities",
        "$.evidence.producerBindingIds",
        "Residual-risk acceptance requires recorded producer binding identities",
      );
    }

    for (const risk of unresolvedRisks) {
      const riskPath = "$.evidence.unresolvedRisks." + risk.id;
      if (requestedOutcome === "completed") {
        addReason(
          reasons,
          risk.severity === "critical"
            ? "critical_unresolved_risk"
            : "unresolved_risk_not_allowed",
          riskPath,
          "completed cannot retain unresolved " + risk.severity + " risk " + risk.id,
        );
        continue;
      }
      if (requestedOutcome !== "completed_with_risks") continue;
      if (risk.severity === "critical") {
        addReason(
          reasons,
          "critical_unresolved_risk",
          riskPath,
          "completed_with_risks cannot retain critical risk " + risk.id,
        );
        continue;
      }
      if (!allowedRiskSeverities.has(risk.severity)) {
        addReason(
          reasons,
          "unresolved_risk_not_allowed",
          riskPath,
          "Exit condition for completed_with_risks does not allow unresolved " +
            risk.severity +
            " risk " +
            risk.id,
        );
        continue;
      }
      if (producerBindingsValid && producerBindingIds.length > 0) {
        validateResidualAcceptance(risk, riskPath, "risk", producerBindings, reasons);
      }
    }

    for (const dissent of unresolvedDissents) {
      const dissentPath = "$.evidence.unresolvedDissents." + dissent.id;
      if (requestedOutcome === "completed") {
        addReason(
          reasons,
          dissent.severity === "critical"
            ? "critical_dissent_unresolved"
            : "unresolved_dissent_not_allowed",
          dissentPath,
          "completed cannot retain unresolved " + dissent.severity + " dissent " + dissent.id,
        );
        continue;
      }
      if (requestedOutcome !== "completed_with_risks") continue;
      if (dissent.severity === "critical") {
        addReason(
          reasons,
          "critical_dissent_unresolved",
          dissentPath,
          "completed_with_risks cannot retain critical dissent " + dissent.id,
        );
        continue;
      }
      if (!allowedRiskSeverities.has(dissent.severity)) {
        addReason(
          reasons,
          "unresolved_dissent_not_allowed",
          dissentPath,
          "Exit condition for completed_with_risks does not allow unresolved " +
            dissent.severity +
            " dissent " +
            dissent.id,
        );
        continue;
      }
      if (producerBindingsValid && producerBindingIds.length > 0) {
        validateResidualAcceptance(dissent, dissentPath, "dissent", producerBindings, reasons);
      }
    }

    if (requestedOutcome === "completed_with_risks" && unresolvedRisks.length === 0) {
      addReason(
        reasons,
        "completed_with_risks_requires_unresolved_risk",
        "$.evidence.unresolvedRisks",
        "completed_with_risks requires at least one recorded unresolved risk",
      );
    }
  }

  return {
    canTerminalize: reasons.length === 0,
    outcome: reasons.length === 0 && requestedOutcome ? requestedOutcome : null,
    unmetReasons: reasons,
  };
}
