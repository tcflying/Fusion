import type { RoomMessageIntent } from "./controller.js";
import type { RoomProtocolId } from "./ids.js";
import type { RoomLifecycleState } from "./storage.js";
import type { RoomProtocolContractVersion } from "./versions.js";

export const ROOM_PROTOCOL_FAMILIES = [
  "analysis_decision",
  "implementation",
  "diagnosis",
  "creative_review",
  "bounded_discussion",
] as const;

export type RoomProtocolFamily = (typeof ROOM_PROTOCOL_FAMILIES)[number];
export type RoomProtocolGateKind = "deterministic" | "evidence" | "model_review" | "operator_approval";
export type RoomProtocolRecoveryTrigger = "timeout" | "no_progress" | "hard_gate_failed" | "participant_lost" | "rate_limited" | "conflicting_evidence";
export type RoomProtocolRecoveryAction = "retry" | "redecompose" | "replace_participant" | "add_challenger" | "shrink_scope" | "change_model" | "request_operator";

/*
FNXC:RoomTerminalization 2026-07-18-00:00:
Task 5.10 needs durable artifact and delivery proof without adding an
unversioned persisted Protocol-v1 field. These declared prefixes keep the
requirement in the protocol and let the pure evaluator reject missing proof.
*/
export const ROOM_PROTOCOL_TERMINALIZATION_ARTIFACT_REQUIREMENT_PREFIX_V1 = "artifact:";
export const ROOM_PROTOCOL_TERMINALIZATION_DELIVERY_REQUIREMENT_PREFIX_V1 = "delivery:";

export type RoomProtocolTerminalizationEvidenceRequirementV1 =
  | `${typeof ROOM_PROTOCOL_TERMINALIZATION_ARTIFACT_REQUIREMENT_PREFIX_V1}${string}`
  | `${typeof ROOM_PROTOCOL_TERMINALIZATION_DELIVERY_REQUIREMENT_PREFIX_V1}${string}`;

export interface RoomProtocolPhaseV1 {
  readonly id: string;
  readonly roleIds: readonly string[];
  readonly entryGateIds: readonly string[];
  readonly exitGateIds: readonly string[];
  readonly timeoutMs: number;
  readonly channelIds?: readonly string[];
  readonly contextPackIds?: readonly string[];
}

export interface RoomProtocolRoleV1 {
  readonly id: string;
  readonly requiredCapabilities: readonly string[];
  readonly mayProduce: boolean;
  readonly mayVerify: boolean;
  readonly mayAccept: boolean;
}

export interface RoomProtocolChannelV1 {
  readonly id: string;
  readonly allowedIntents: readonly RoomMessageIntent[];
  readonly responderRoleIds: readonly string[];
  readonly broadcastRequiresResponse?: boolean;
}

export interface RoomProtocolContextPackV1 {
  readonly id: string;
  readonly includeKinds: readonly string[];
  readonly excludeKinds: readonly string[];
  readonly maxItems?: number;
}

export interface RoomProtocolTransitionV1 {
  readonly fromPhaseId: string;
  readonly toPhaseId: string;
  readonly whenGateId: string;
}

export interface RoomProtocolGateV1 {
  readonly id: string;
  readonly kind: RoomProtocolGateKind;
  readonly hard: boolean;
  readonly evaluatorRoleIds?: readonly string[];
  /**
   * `artifact:<id>` and `delivery:<id>` entries are terminalization proof
   * requirements. Other entries retain their existing protocol-local meaning.
   */
  readonly evidenceRequirements?: readonly string[];
  readonly provenanceKind?: "candidate" | "hypothesis";
  readonly minimumDistinctProducerBindings?: number;
}

export interface RoomProtocolRecoveryActionV1 {
  readonly id: string;
  readonly trigger: RoomProtocolRecoveryTrigger;
  readonly action: RoomProtocolRecoveryAction;
  readonly maxAttempts: number;
  readonly phaseIds: readonly string[];
  readonly exhaustedGateId: string;
}

export interface RoomProtocolExitConditionV1 {
  readonly outcome: Extract<
    RoomLifecycleState,
    "completed" | "completed_with_risks" | "partial" | "blocked" | "cancelled" | "failed"
  >;
  readonly requiredGateIds: readonly string[];
  readonly requireIndependentVerifier: boolean;
  /** Applies to non-critical residual risk and dissent for completed_with_risks. */
  readonly allowUnresolvedRiskSeverities?: readonly ("low" | "medium")[];
}

/*
FNXC:SessionRoomProtocols 2026-07-17-02:59:
Room collaboration is a versioned declarative state machine. Producer,
verifier, and acceptance permissions are explicit so a producer cannot become
its own sole verifier through an implicit role or mid-turn protocol change.
*/
export interface RoomProtocolDefinitionV1 {
  readonly contractVersion: RoomProtocolContractVersion;
  readonly id: RoomProtocolId;
  readonly version: number;
  readonly family: RoomProtocolFamily;
  readonly name: string;
  readonly phases: readonly RoomProtocolPhaseV1[];
  readonly roles: readonly RoomProtocolRoleV1[];
  readonly channels: readonly RoomProtocolChannelV1[];
  readonly contextPacks: readonly RoomProtocolContextPackV1[];
  readonly transitions: readonly RoomProtocolTransitionV1[];
  readonly gates: readonly RoomProtocolGateV1[];
  readonly recoveryActions: readonly RoomProtocolRecoveryActionV1[];
  readonly exitConditions: readonly RoomProtocolExitConditionV1[];
}

/**
 * A versioned policy overlay for one declared `trigger: "no_progress"` recovery action.
 * It stays separate from the persisted protocol-v1 JSON until that schema is versioned.
 */
export interface RoomProtocolNoProgressRecoveryActionPolicyV1 {
  readonly recoveryActionId: string;
  readonly ladderOrder: number;
  readonly minimumConsecutiveUnchangedRounds: number;
}

export interface RoomProtocolNoProgressRecoveryPolicyV1 {
  readonly protocolId: RoomProtocolId;
  readonly protocolVersion: number;
  readonly actions: readonly RoomProtocolNoProgressRecoveryActionPolicyV1[];
}

export interface RoomProtocolSelectedNoProgressRecoveryActionV1 {
  readonly recoveryAction: RoomProtocolRecoveryActionV1;
  readonly ladderOrder: number;
  readonly minimumConsecutiveUnchangedRounds: number;
}

export type RoomProtocolNoProgressRecoveryPolicyIssueCode =
  | "invalid_no_progress_recovery_policy_identity"
  | "invalid_no_progress_recovery_policy_actions"
  | "invalid_no_progress_recovery_action_reference"
  | "duplicate_no_progress_recovery_action_reference"
  | "missing_no_progress_recovery_action_policy"
  | "invalid_no_progress_recovery_ladder_order"
  | "duplicate_no_progress_recovery_ladder_order"
  | "non_contiguous_no_progress_recovery_ladder_order"
  | "invalid_no_progress_recovery_threshold"
  | "decreasing_no_progress_recovery_threshold"
  | "invalid_no_progress_recovery_action_shape";

export interface RoomProtocolNoProgressRecoveryPolicyIssueV1 {
  readonly code: RoomProtocolNoProgressRecoveryPolicyIssueCode;
  readonly path: string;
  readonly message: string;
}

export type RoomProtocolNoProgressRecoveryPolicyValidationResultV1 =
  | { readonly ok: true; readonly value: readonly RoomProtocolSelectedNoProgressRecoveryActionV1[] }
  | { readonly ok: false; readonly issues: readonly RoomProtocolNoProgressRecoveryPolicyIssueV1[] };

/** The persisted attempt/exhaustion state needed to advance a recovery ladder. */
export interface RoomProtocolRecoveryActionAttemptStateV1 {
  readonly actionId: string;
  readonly attempts: number;
  readonly exhausted: boolean;
}

export interface SelectNextRoomNoProgressRecoveryActionInputV1 {
  /** The selection seam intentionally needs only protocol identity and recovery declarations. */
  readonly protocol: Pick<RoomProtocolDefinitionV1, "id" | "version" | "recoveryActions">;
  readonly policy: RoomProtocolNoProgressRecoveryPolicyV1;
  readonly phaseId: string;
  readonly consecutiveUnchangedRounds: number;
  readonly priorActionAttempts: readonly RoomProtocolRecoveryActionAttemptStateV1[];
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function noProgressRecoveryIssue(
  issues: RoomProtocolNoProgressRecoveryPolicyIssueV1[],
  code: RoomProtocolNoProgressRecoveryPolicyIssueCode,
  path: string,
  message: string,
): void {
  issues.push({ code, path, message });
}

/*
FNXC:SessionRoomNoProgressRecoveryPolicy 2026-07-19:
No-progress recovery is a deterministic protocol decision over persisted round
observations. It selects only a declared policy action; it never invents a
replacement participant, provider, model, or external side effect.
*/
export function validateRoomProtocolNoProgressRecoveryPolicy(
  input: {
    readonly protocol: Pick<RoomProtocolDefinitionV1, "id" | "version" | "recoveryActions">;
    readonly policy: RoomProtocolNoProgressRecoveryPolicyV1;
  },
): RoomProtocolNoProgressRecoveryPolicyValidationResultV1 {
  const issues: RoomProtocolNoProgressRecoveryPolicyIssueV1[] = [];
  const protocol = input?.protocol;
  const policy = input?.policy;
  const recoveryActions = Array.isArray(protocol?.recoveryActions)
    ? protocol.recoveryActions
    : [];
  if (
    typeof protocol?.id !== "string" ||
    !isPositiveSafeInteger(protocol.version) ||
    typeof policy?.protocolId !== "string" ||
    !isPositiveSafeInteger(policy.protocolVersion) ||
    policy.protocolId !== protocol.id ||
    policy.protocolVersion !== protocol.version
  ) {
    noProgressRecoveryIssue(
      issues,
      "invalid_no_progress_recovery_policy_identity",
      "$.policy",
      "A no-progress recovery policy must identify the exact declared protocol id and version",
    );
  }
  if (!Array.isArray(policy?.actions)) {
    noProgressRecoveryIssue(
      issues,
      "invalid_no_progress_recovery_policy_actions",
      "$.policy.actions",
      "A no-progress recovery policy requires an actions array",
    );
  }

  const noProgressActionsById = new Map<string, RoomProtocolRecoveryActionV1>();
  recoveryActions.forEach((recovery, index) => {
    if (recovery?.trigger !== "no_progress") return;
    if (typeof recovery.id !== "string" || recovery.id.trim().length === 0) {
      noProgressRecoveryIssue(
        issues,
        "invalid_no_progress_recovery_action_shape",
        `$.protocol.recoveryActions[${index}].id`,
        "A declared no-progress recovery action requires a non-empty id",
      );
      return;
    }
    if (
      !isPositiveSafeInteger(recovery.maxAttempts) ||
      !Array.isArray(recovery.phaseIds) ||
      recovery.phaseIds.length === 0 ||
      recovery.phaseIds.some(
        (phaseId: unknown) => typeof phaseId !== "string" || phaseId.trim().length === 0,
      )
    ) {
      noProgressRecoveryIssue(
        issues,
        "invalid_no_progress_recovery_action_shape",
        `$.protocol.recoveryActions[${index}]`,
        "A declared no-progress recovery action requires a positive attempt limit and phase scope",
      );
      return;
    }
    noProgressActionsById.set(recovery.id, recovery);
  });

  const actionPolicies = Array.isArray(policy?.actions) ? policy.actions : [];
  const selectedActions: RoomProtocolSelectedNoProgressRecoveryActionV1[] = [];
  const orders = new Map<number, string>();
  const policyActionIds = new Set<string>();
  actionPolicies.forEach((actionPolicy, index) => {
    const path = `$.policy.actions[${index}]`;
    if (
      typeof actionPolicy?.recoveryActionId !== "string" ||
      actionPolicy.recoveryActionId.trim().length === 0
    ) {
      noProgressRecoveryIssue(
        issues,
        "invalid_no_progress_recovery_action_reference",
        `${path}.recoveryActionId`,
        "A no-progress recovery policy action requires a declared recovery action id",
      );
      return;
    }
    const recovery = noProgressActionsById.get(actionPolicy.recoveryActionId);
    if (!recovery) {
      noProgressRecoveryIssue(
        issues,
        "invalid_no_progress_recovery_action_reference",
        `${path}.recoveryActionId`,
        `No-progress recovery action '${actionPolicy.recoveryActionId}' is not declared by this protocol`,
      );
      return;
    }
    if (policyActionIds.has(actionPolicy.recoveryActionId)) {
      noProgressRecoveryIssue(
        issues,
        "duplicate_no_progress_recovery_action_reference",
        `${path}.recoveryActionId`,
        `No-progress recovery action '${actionPolicy.recoveryActionId}' has more than one policy entry`,
      );
      return;
    }
    policyActionIds.add(actionPolicy.recoveryActionId);
    if (!isPositiveSafeInteger(actionPolicy.ladderOrder)) {
      noProgressRecoveryIssue(
        issues,
        "invalid_no_progress_recovery_ladder_order",
        `${path}.ladderOrder`,
        "A no-progress recovery ladderOrder must be a positive safe integer",
      );
    } else {
      const earlierActionId = orders.get(actionPolicy.ladderOrder);
      if (earlierActionId !== undefined) {
        noProgressRecoveryIssue(
          issues,
          "duplicate_no_progress_recovery_ladder_order",
          `${path}.ladderOrder`,
          `No-progress ladderOrder ${actionPolicy.ladderOrder} is already used by '${earlierActionId}'`,
        );
      } else {
        orders.set(actionPolicy.ladderOrder, actionPolicy.recoveryActionId);
      }
    }
    if (!isPositiveSafeInteger(actionPolicy.minimumConsecutiveUnchangedRounds)) {
      noProgressRecoveryIssue(
        issues,
        "invalid_no_progress_recovery_threshold",
        `${path}.minimumConsecutiveUnchangedRounds`,
        "A no-progress recovery threshold must be a positive safe integer",
      );
    }
    if (
      isPositiveSafeInteger(actionPolicy.ladderOrder) &&
      isPositiveSafeInteger(actionPolicy.minimumConsecutiveUnchangedRounds)
    ) {
      selectedActions.push({
        recoveryAction: recovery,
        ladderOrder: actionPolicy.ladderOrder,
        minimumConsecutiveUnchangedRounds: actionPolicy.minimumConsecutiveUnchangedRounds,
      });
    }
  });

  for (const recoveryActionId of noProgressActionsById.keys()) {
    if (policyActionIds.has(recoveryActionId)) continue;
    noProgressRecoveryIssue(
      issues,
      "missing_no_progress_recovery_action_policy",
      "$.policy.actions",
      `No-progress recovery action '${recoveryActionId}' requires an explicit policy entry`,
    );
  }

  const orderedActions = [...selectedActions].sort(
    (left, right) =>
      left.ladderOrder - right.ladderOrder ||
      left.recoveryAction.id.localeCompare(right.recoveryAction.id),
  );
  orderedActions.forEach((recovery, index) => {
    const expectedOrder = index + 1;
    if (recovery.ladderOrder !== expectedOrder) {
      noProgressRecoveryIssue(
        issues,
        "non_contiguous_no_progress_recovery_ladder_order",
        `$.policy.actions.${recovery.recoveryAction.id}.ladderOrder`,
        `No-progress recovery ladder orders must be contiguous from 1; expected ${expectedOrder}`,
      );
    }
    const previous = orderedActions[index - 1];
    if (
      previous !== undefined &&
      recovery.minimumConsecutiveUnchangedRounds < previous.minimumConsecutiveUnchangedRounds
    ) {
      noProgressRecoveryIssue(
        issues,
        "decreasing_no_progress_recovery_threshold",
        `$.policy.actions.${recovery.recoveryAction.id}.minimumConsecutiveUnchangedRounds`,
        "A later no-progress recovery rung cannot require fewer unchanged rounds than an earlier rung",
      );
    }
  });

  if (issues.length > 0) return { ok: false, issues: Object.freeze(issues) };
  return { ok: true, value: Object.freeze(orderedActions.map((action) => Object.freeze(action))) };
}

function selectInputError(message: string): never {
  throw new TypeError(`selectNextRoomNoProgressRecoveryAction ${message}`);
}

export function selectNextRoomNoProgressRecoveryAction(
  input: SelectNextRoomNoProgressRecoveryActionInputV1,
): RoomProtocolSelectedNoProgressRecoveryActionV1 | undefined {
  if (typeof input?.phaseId !== "string" || input.phaseId.trim().length === 0) {
    return selectInputError("requires a non-empty phaseId");
  }
  if (!isNonNegativeSafeInteger(input.consecutiveUnchangedRounds)) {
    return selectInputError("requires consecutiveUnchangedRounds to be a non-negative safe integer");
  }
  if (!Array.isArray(input.priorActionAttempts)) {
    return selectInputError("requires priorActionAttempts to be an array");
  }

  const validatedPolicy = validateRoomProtocolNoProgressRecoveryPolicy({
    protocol: input.protocol,
    policy: input.policy,
  });
  if (!validatedPolicy.ok) {
    return selectInputError(
      `requires a valid no-progress recovery policy (${validatedPolicy.issues
        .map((issue) => issue.code)
        .join(", ")})`,
    );
  }

  const attemptsByActionId = new Map<string, RoomProtocolRecoveryActionAttemptStateV1>();
  for (const state of input.priorActionAttempts) {
    if (typeof state?.actionId !== "string" || state.actionId.trim().length === 0) {
      return selectInputError("requires every prior action state to have a non-empty actionId");
    }
    if (!isNonNegativeSafeInteger(state.attempts) || typeof state.exhausted !== "boolean") {
      return selectInputError(
        `requires a valid attempt/exhaustion state for '${state.actionId}'`,
      );
    }
    if (attemptsByActionId.has(state.actionId)) {
      return selectInputError(`received duplicate prior action state for '${state.actionId}'`);
    }
    attemptsByActionId.set(state.actionId, state);
  }

  for (const recovery of validatedPolicy.value) {
    if (!recovery.recoveryAction.phaseIds.includes(input.phaseId)) continue;
    const priorState = attemptsByActionId.get(recovery.recoveryAction.id);
    const exhausted =
      priorState?.exhausted === true ||
      (priorState?.attempts ?? 0) >= recovery.recoveryAction.maxAttempts;
    if (exhausted) continue;
    if (input.consecutiveUnchangedRounds < recovery.minimumConsecutiveUnchangedRounds) {
      return undefined;
    }
    return recovery;
  }
  return undefined;
}
