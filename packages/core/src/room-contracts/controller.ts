import type {
  ContentHash,
  IsoTimestamp,
  ProjectId,
  RoomBindingId,
  RoomEventId,
  RoomId,
  RoomProtocolId,
  RoomSeatId,
  RoomTaskNodeId,
  RoomTurnId,
} from "./ids.js";
import type { RoomLifecycleState, RoomTaskNodeState } from "./storage.js";
import type { RoomApiVersion, RoomControllerContractVersion } from "./versions.js";

export const ROOM_CONTROLLER_COMMAND_TYPES = [
  "create_room",
  "start_room",
  "pause_room",
  "resume_room",
  "request_membership_change",
  "route_message",
  "mutate_task_graph",
  "change_protocol",
  "checkpoint_turn",
  "complete_room",
  "cancel_room",
] as const;

export const ROOM_CONTROLLER_EVENT_TYPES = [
  "room_created",
  "room_state_changed",
  "membership_change_requested",
  "membership_change_activated",
  "message_routed",
  "task_graph_changed",
  "protocol_changed",
  "turn_checkpointed",
  "outbox_enqueued",
  "delivery_state_changed",
  "room_terminalized",
  "command_rejected",
] as const;

export type RoomControllerCommandType = (typeof ROOM_CONTROLLER_COMMAND_TYPES)[number];
export type RoomControllerEventType = (typeof ROOM_CONTROLLER_EVENT_TYPES)[number];
export type RoomMessageIntent = "instruction" | "proposal" | "question" | "critique" | "challenge" | "verdict" | "handoff" | "help_request";
export const ROOM_AUTHORITY_ACTOR_TYPES = ["human", "controller", "seat", "system", "evolution"] as const;
export const ROOM_AUTHORITY_CLAIM_VERSION = "room-authority/v1" as const;
export const ROOM_AUTHORITY_PROOF_ALGORITHMS = ["Ed25519"] as const;

export type RoomAuthorityActorTypeV1 = (typeof ROOM_AUTHORITY_ACTOR_TYPES)[number];
export type RoomAuthorityClaimVersionV1 = typeof ROOM_AUTHORITY_CLAIM_VERSION;
export type RoomAuthorityProofAlgorithmV1 = (typeof ROOM_AUTHORITY_PROOF_ALGORITHMS)[number];

export interface RoomAuthorityEnvelopeV1 {
  readonly actorType: RoomAuthorityActorTypeV1;
  readonly actorId: string;
  readonly deviceId: string | null;
  readonly role: string;
  readonly allowedActions: readonly string[];
  readonly projectId: ProjectId;
  readonly roomId: RoomId;
  readonly nodeIds: readonly RoomTaskNodeId[];
  readonly seatIds: readonly RoomSeatId[];
  readonly evidenceRefs: readonly string[];
}

export type RoomMessageTargetV1 =
  | { readonly kind: "controller" }
  | { readonly kind: "all" }
  | { readonly kind: "group"; readonly groupId: string }
  | { readonly kind: "seats"; readonly seatIds: readonly RoomSeatId[] };

/*
FNXC:SessionRoomAuthority 2026-07-17-22:40:
Task 9.1 adds a signed backend-issued authority layer that is evaluated
separately from peer content. Claims bind the exact Room/project/turn/node,
target selector, expected versions, intent, and content hash so text can
propose work but cannot mint tools, workspace, credential, network, or
publication authority on its own.
*/
export interface RoomAuthorityClaimsV1 {
  readonly version: RoomAuthorityClaimVersionV1;
  readonly issuer: string;
  readonly actorType: RoomAuthorityActorTypeV1;
  readonly actorId: string;
  readonly issuedAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  readonly nonce: string;
  readonly commandId: string;
  readonly projectId: ProjectId;
  readonly roomId: RoomId;
  readonly turnId: RoomTurnId | null;
  readonly nodeId: RoomTaskNodeId | null;
  readonly target: RoomMessageTargetV1;
  readonly expectedAggregateVersion: number;
  readonly expectedMembershipVersion: number;
  readonly intent: RoomMessageIntent;
  readonly contentHash: ContentHash;
  readonly scopes: readonly string[];
}

export interface RoomAuthorityProofV1 {
  readonly algorithm: RoomAuthorityProofAlgorithmV1;
  readonly keyId: string;
  readonly signature: string;
}

export interface SignedRoomAuthorityEnvelopeV1 {
  readonly version: RoomAuthorityClaimVersionV1;
  readonly issuer: string;
  readonly issuedAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  readonly claims: RoomAuthorityClaimsV1;
  readonly proof: RoomAuthorityProofV1;
}

export interface RoomAuthorityVerificationContextV1 {
  readonly commandId: string;
  readonly projectId: ProjectId;
  readonly roomId: RoomId;
  readonly turnId: RoomTurnId | null;
  readonly nodeId: RoomTaskNodeId | null;
  readonly target: RoomMessageTargetV1;
  readonly expectedAggregateVersion: number;
  readonly expectedMembershipVersion: number;
  readonly intent: RoomMessageIntent;
  readonly contentHash: ContentHash;
  readonly content?: string;
  readonly requiredScopes: readonly string[];
}

export interface CreateRoomCommandV1 {
  readonly type: "create_room";
  readonly objective: string;
  readonly protocolId: RoomProtocolId;
  readonly protocolVersion: number;
}

export interface StartRoomCommandV1 {
  readonly type: "start_room";
}

export interface PauseRoomCommandV1 {
  readonly type: "pause_room";
  readonly reason: string;
}

export interface ResumeRoomCommandV1 {
  readonly type: "resume_room";
}

export interface RequestMembershipChangeCommandV1 {
  readonly type: "request_membership_change";
  readonly action: "add" | "remove" | "pause" | "resume" | "replace" | "change_role";
  readonly seatId: RoomSeatId;
  readonly bindingId?: RoomBindingId;
  readonly replacementBindingId?: RoomBindingId;
  readonly role?: string;
  readonly activateAt: "next_turn_boundary";
  readonly reason: string;
}

export interface RouteMessageCommandV1 {
  readonly type: "route_message";
  readonly intent: RoomMessageIntent;
  readonly target: RoomMessageTargetV1;
  readonly content: string;
  readonly contentHash: ContentHash;
  readonly nodeId: RoomTaskNodeId | null;
}

export interface RoomTaskNodeMutationV1 {
  readonly action: "add" | "split" | "merge" | "cancel" | "reopen" | "assign";
  readonly nodeId: RoomTaskNodeId;
  readonly objective?: string;
  readonly parentNodeId?: RoomTaskNodeId | null;
  readonly dependencyIds?: readonly RoomTaskNodeId[];
  readonly assignedSeatIds?: readonly RoomSeatId[];
  readonly expectedNodeState?: RoomTaskNodeState;
  readonly evidenceRefs: readonly string[];
}

export interface MutateTaskGraphCommandV1 {
  readonly type: "mutate_task_graph";
  readonly expectedDagVersion: number;
  readonly mutations: readonly RoomTaskNodeMutationV1[];
}

export interface ChangeProtocolCommandV1 {
  readonly type: "change_protocol";
  readonly protocolId: RoomProtocolId;
  readonly protocolVersion: number;
  readonly activateAt: "next_turn_boundary";
  readonly migrationRef: string;
}

export interface CheckpointTurnCommandV1 {
  readonly type: "checkpoint_turn";
  readonly turnId: RoomTurnId;
  readonly reason: "boundary" | "high_risk_before" | "high_risk_after" | "recovery";
}

export interface CompleteRoomCommandV1 {
  readonly type: "complete_room";
  readonly outcome: Extract<RoomLifecycleState, "completed" | "completed_with_risks" | "partial" | "blocked" | "failed">;
  readonly completionContractRef: string;
  readonly independentVerificationRefs: readonly string[];
  readonly unresolvedRiskRefs: readonly string[];
}

export interface CancelRoomCommandV1 {
  readonly type: "cancel_room";
  readonly reason: string;
}

export type RoomControllerCommandV1 =
  | CreateRoomCommandV1
  | StartRoomCommandV1
  | PauseRoomCommandV1
  | ResumeRoomCommandV1
  | RequestMembershipChangeCommandV1
  | RouteMessageCommandV1
  | MutateTaskGraphCommandV1
  | ChangeProtocolCommandV1
  | CheckpointTurnCommandV1
  | CompleteRoomCommandV1
  | CancelRoomCommandV1;

/*
FNXC:SessionRoomCommands 2026-07-17-02:57:
Controller mutations require an idempotency key, expected aggregate version,
authenticated authority envelope, and explicit targets. Participant content
can request work but cannot manufacture authority through the message body.
*/
export interface RoomControllerCommandEnvelopeV1 {
  readonly contractVersion: RoomControllerContractVersion;
  readonly apiVersion: RoomApiVersion;
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly roomId: RoomId;
  readonly projectId: ProjectId;
  readonly expectedAggregateVersion: number;
  readonly issuedAt: IsoTimestamp;
  readonly authority: RoomAuthorityEnvelopeV1;
  readonly command: RoomControllerCommandV1;
}

export interface RoomControllerEventEnvelopeV1 {
  readonly contractVersion: RoomControllerContractVersion;
  readonly apiVersion: RoomApiVersion;
  readonly eventId: RoomEventId;
  readonly eventType: RoomControllerEventType;
  readonly roomId: RoomId;
  readonly projectId: ProjectId;
  readonly aggregateVersion: number;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly actor: RoomAuthorityEnvelopeV1;
  readonly occurredAt: IsoTimestamp;
  readonly payload: Readonly<Record<string, unknown>>;
}
