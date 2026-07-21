export const ROOM_EVOLUTION_RISK_TIER_POLICY_CONTRACT_VERSION = 1 as const;

export type RoomEvolutionChangeSurfaceV1 =
  | "policy"
  | "prompt"
  | "skill"
  | "context"
  | "task_decomposition"
  | "role_assignment"
  | "model_routing"
  | "retry_concurrency"
  | "connector_adapter"
  | "evaluation_rule"
  | "source"
  | "permission"
  | "authentication"
  | "network"
  | "destructive_action"
  | "evaluator";

export type RoomEvolutionRiskTierClassV1 = "low" | "moderate" | "high" | "critical";

export type RoomEvolutionRiskTierAuthorityV1 = "automatic_pre_authorized" | "independent" | "human";

export type RoomEvolutionRequiredGateClassV1 =
  | "correctness"
  | "security"
  | "user_constraints"
  | "evidence_integrity"
  | "regression"
  | "independent_security_review"
  | "independent_runtime_validation"
  | "rollback_lineage";

export interface RoomEvolutionRiskTierCandidateV1 {
  readonly id: string;
  readonly producerActorId: string;
  readonly riskClass: RoomEvolutionRiskTierClassV1;
  readonly changeSurfaces: readonly RoomEvolutionChangeSurfaceV1[];
  readonly autoPromotionPreAuthorized: boolean;
}

export interface RoomEvolutionRiskTierGateV1 {
  readonly gateClass: RoomEvolutionRequiredGateClassV1;
  readonly outcome: "passed" | "failed" | "not_run" | "error";
  readonly evaluatorActorId: string;
}

export interface RoomEvolutionRiskTierAuthorityRequestV1 {
  readonly tier: RoomEvolutionRiskTierAuthorityV1;
  readonly actorId: string;
  readonly approvalRequestId: string | null;
  readonly evaluatedAt: string;
}

export interface EvaluateRoomEvolutionRiskTierInputV1 {
  readonly contractVersion: typeof ROOM_EVOLUTION_RISK_TIER_POLICY_CONTRACT_VERSION;
  readonly candidate: RoomEvolutionRiskTierCandidateV1;
  readonly hardGates: readonly RoomEvolutionRiskTierGateV1[];
  readonly requestedAuthority: RoomEvolutionRiskTierAuthorityRequestV1;
}

export type RoomEvolutionRiskTierActionV1 =
  | "auto_promote"
  | "independent_promote"
  | "human_promote"
  | "human_approval_required"
  | "withhold";

export type RoomEvolutionRiskTierBlockerCodeV1 =
  | "invalid_input"
  | "required_gate_missing"
  | "hard_gate_failed"
  | "producer_only_evaluator_forbidden"
  | "automatic_pre_authorization_required"
  | "independent_authority_required"
  | "human_authority_required"
  | "approval_request_required";

export interface RoomEvolutionRiskTierBlockerV1 {
  readonly code: RoomEvolutionRiskTierBlockerCodeV1;
  readonly path: string;
  readonly message: string;
}

export interface RoomEvolutionRiskTierDecisionV1 {
  readonly allowed: boolean;
  readonly action: RoomEvolutionRiskTierActionV1;
  readonly requiredAuthorityTier: RoomEvolutionRiskTierAuthorityV1;
  readonly requiresHumanApproval: boolean;
  readonly requiredGateClasses: readonly RoomEvolutionRequiredGateClassV1[];
  readonly blockers: readonly RoomEvolutionRiskTierBlockerV1[];
}

const BASELINE_GATES: readonly RoomEvolutionRequiredGateClassV1[] = [
  "correctness",
  "security",
  "user_constraints",
  "evidence_integrity",
  "regression",
];

const HIGH_IMPACT_GATES: readonly RoomEvolutionRequiredGateClassV1[] = [
  ...BASELINE_GATES,
  "independent_security_review",
  "independent_runtime_validation",
  "rollback_lineage",
];

const HIGH_IMPACT_SURFACES = new Set<RoomEvolutionChangeSurfaceV1>([
  "source",
  "permission",
  "authentication",
  "network",
  "destructive_action",
  "evaluator",
]);

export function evaluateRoomEvolutionRiskTier(
  rawInput: unknown,
): RoomEvolutionRiskTierDecisionV1 {
  const input = parseInput(rawInput);
  if (input === null) return invalidInputDecision();

  const highImpact = input.candidate.riskClass === "high"
    || input.candidate.riskClass === "critical"
    || input.candidate.changeSurfaces.some((surface) => HIGH_IMPACT_SURFACES.has(surface));
  const requiredGateClasses = highImpact ? HIGH_IMPACT_GATES : BASELINE_GATES;
  const requiredAuthorityTier = highImpact
    ? "human"
    : input.candidate.riskClass === "low" && input.candidate.autoPromotionPreAuthorized
      ? "automatic_pre_authorized"
      : "independent";
  const requiresHumanApproval = highImpact;
  const blockers = collectGateBlockers(input, requiredGateClasses);
  collectAuthorityBlockers(input, requiredAuthorityTier, requiresHumanApproval, blockers);

  if (blockers.length > 0) {
    const waitingForHumanApproval = highImpact && blockers.some((entry) =>
      entry.code === "human_authority_required" || entry.code === "approval_request_required");
    return decision(false, waitingForHumanApproval ? "human_approval_required" : "withhold", requiredAuthorityTier, requiresHumanApproval, requiredGateClasses, blockers);
  }
  const action = requiredAuthorityTier === "automatic_pre_authorized"
    ? "auto_promote"
    : requiredAuthorityTier === "independent"
      ? "independent_promote"
      : "human_promote";
  return decision(true, action, requiredAuthorityTier, requiresHumanApproval, requiredGateClasses, []);
}

function parseInput(value: unknown): EvaluateRoomEvolutionRiskTierInputV1 | null {
  if (!isRecord(value) || value.contractVersion !== ROOM_EVOLUTION_RISK_TIER_POLICY_CONTRACT_VERSION) return null;
  const input = value as unknown as EvaluateRoomEvolutionRiskTierInputV1;
  if (!isCandidate(input.candidate) || !Array.isArray(input.hardGates) || !input.hardGates.every(isGate) || !isAuthorityRequest(input.requestedAuthority)) {
    return null;
  }
  return input;
}

function collectGateBlockers(
  input: EvaluateRoomEvolutionRiskTierInputV1,
  requiredGateClasses: readonly RoomEvolutionRequiredGateClassV1[],
): RoomEvolutionRiskTierBlockerV1[] {
  const blockers: RoomEvolutionRiskTierBlockerV1[] = [];
  for (const gateClass of requiredGateClasses) {
    const matches = input.hardGates.filter((gate) => gate.gateClass === gateClass);
    if (matches.length === 0) {
      blockers.push(blocker("required_gate_missing", `hardGates.${gateClass}`, `Required ${gateClass} gate is missing.`));
      continue;
    }
    if (matches.some((gate) => gate.outcome !== "passed")) {
      blockers.push(blocker("hard_gate_failed", `hardGates.${gateClass}`, `Required ${gateClass} gate did not pass.`));
    }
    if (!matches.some((gate) => gate.outcome === "passed" && gate.evaluatorActorId !== input.candidate.producerActorId)) {
      blockers.push(blocker(
        "producer_only_evaluator_forbidden",
        `hardGates.${gateClass}`,
        `Required ${gateClass} gate has no independent passing evaluator.`,
      ));
    }
  }
  return blockers;
}

function collectAuthorityBlockers(
  input: EvaluateRoomEvolutionRiskTierInputV1,
  requiredAuthorityTier: RoomEvolutionRiskTierAuthorityV1,
  requiresHumanApproval: boolean,
  blockers: RoomEvolutionRiskTierBlockerV1[],
): void {
  if (requiredAuthorityTier === "automatic_pre_authorized") {
    if (input.requestedAuthority.tier !== "automatic_pre_authorized") {
      blockers.push(blocker(
        "automatic_pre_authorization_required",
        "requestedAuthority.tier",
        "Low-risk auto-promotion requires the configured automatic pre-authority.",
      ));
    }
    return;
  }
  if (requiredAuthorityTier === "independent") {
    if (input.requestedAuthority.tier !== "independent" && input.requestedAuthority.tier !== "human") {
      blockers.push(blocker(
        "independent_authority_required",
        "requestedAuthority.tier",
        "This candidate requires independent or human promotion authority.",
      ));
    }
    return;
  }
  if (input.requestedAuthority.tier !== "human") {
    blockers.push(blocker("human_authority_required", "requestedAuthority.tier", "High-impact evolution requires human authority."));
  }
  if (requiresHumanApproval && input.requestedAuthority.approvalRequestId === null) {
    blockers.push(blocker("approval_request_required", "requestedAuthority.approvalRequestId", "High-impact evolution requires a durable approval request."));
  }
}

function invalidInputDecision(): RoomEvolutionRiskTierDecisionV1 {
  return decision(false, "withhold", "human", true, HIGH_IMPACT_GATES, [
    blocker("invalid_input", "input", "Risk-tier promotion input must use the exact v1 shape."),
  ]);
}

function decision(
  allowed: boolean,
  action: RoomEvolutionRiskTierActionV1,
  requiredAuthorityTier: RoomEvolutionRiskTierAuthorityV1,
  requiresHumanApproval: boolean,
  requiredGateClasses: readonly RoomEvolutionRequiredGateClassV1[],
  blockers: readonly RoomEvolutionRiskTierBlockerV1[],
): RoomEvolutionRiskTierDecisionV1 {
  return freeze({
    allowed,
    action,
    requiredAuthorityTier,
    requiresHumanApproval,
    requiredGateClasses: freeze([...requiredGateClasses]),
    blockers: freeze([...blockers].sort((left, right) => left.path.localeCompare(right.path) || left.code.localeCompare(right.code))),
  });
}

function blocker(
  code: RoomEvolutionRiskTierBlockerCodeV1,
  path: string,
  message: string,
): RoomEvolutionRiskTierBlockerV1 {
  return freeze({ code, path, message });
}

function isCandidate(value: unknown): value is RoomEvolutionRiskTierCandidateV1 {
  return isRecord(value)
    && isIdentifier(value.id)
    && isIdentifier(value.producerActorId)
    && isRiskClass(value.riskClass)
    && Array.isArray(value.changeSurfaces)
    && value.changeSurfaces.length > 0
    && value.changeSurfaces.every(isChangeSurface)
    && new Set(value.changeSurfaces).size === value.changeSurfaces.length
    && typeof value.autoPromotionPreAuthorized === "boolean";
}

function isGate(value: unknown): value is RoomEvolutionRiskTierGateV1 {
  return isRecord(value)
    && isGateClass(value.gateClass)
    && (value.outcome === "passed" || value.outcome === "failed" || value.outcome === "not_run" || value.outcome === "error")
    && isIdentifier(value.evaluatorActorId);
}

function isAuthorityRequest(value: unknown): value is RoomEvolutionRiskTierAuthorityRequestV1 {
  return isRecord(value)
    && isAuthorityTier(value.tier)
    && isIdentifier(value.actorId)
    && (value.approvalRequestId === null || isIdentifier(value.approvalRequestId))
    && isTimestamp(value.evaluatedAt);
}

function isChangeSurface(value: unknown): value is RoomEvolutionChangeSurfaceV1 {
  return value === "policy"
    || value === "prompt"
    || value === "skill"
    || value === "context"
    || value === "task_decomposition"
    || value === "role_assignment"
    || value === "model_routing"
    || value === "retry_concurrency"
    || value === "connector_adapter"
    || value === "evaluation_rule"
    || value === "source"
    || value === "permission"
    || value === "authentication"
    || value === "network"
    || value === "destructive_action"
    || value === "evaluator";
}

function isRiskClass(value: unknown): value is RoomEvolutionRiskTierClassV1 {
  return value === "low" || value === "moderate" || value === "high" || value === "critical";
}

function isAuthorityTier(value: unknown): value is RoomEvolutionRiskTierAuthorityV1 {
  return value === "automatic_pre_authorized" || value === "independent" || value === "human";
}

function isGateClass(value: unknown): value is RoomEvolutionRequiredGateClassV1 {
  return value === "correctness"
    || value === "security"
    || value === "user_constraints"
    || value === "evidence_integrity"
    || value === "regression"
    || value === "independent_security_review"
    || value === "independent_runtime_validation"
    || value === "rollback_lineage";
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function freeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  for (const nested of Object.values(value)) freeze(nested);
  return Object.freeze(value);
}
