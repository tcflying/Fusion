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
