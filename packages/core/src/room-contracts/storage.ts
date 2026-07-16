import type {
  ContentHash,
  EventCursor,
  IsoTimestamp,
  ProjectId,
  RoomBindingId,
  RoomCheckpointId,
  RoomEventId,
  RoomId,
  RoomLeaseId,
  RoomMessageId,
  RoomProtocolId,
  RoomSeatId,
  RoomTaskEdgeId,
  RoomTaskNodeId,
  RoomTurnId,
  SessionConnectorId,
} from "./ids.js";
import type { RoomStorageContractVersion } from "./versions.js";

export const ROOM_LIFECYCLE_STATES = [
  "draft",
  "ready",
  "running",
  "paused",
  "completed",
  "completed_with_risks",
  "partial",
  "blocked",
  "cancelled",
  "failed",
  "archived",
] as const;

export type RoomLifecycleState = (typeof ROOM_LIFECYCLE_STATES)[number];
export type RoomSeatState = "pending" | "ready" | "active" | "paused" | "waiting" | "lost" | "removed";
export type RoomBindingState =
  | "pending"
  | "attached"
  | "paused"
  | "authentication_blocked"
  | "host_unavailable"
  | "delivery_uncertain"
  | "detached"
  | "replaced"
  | "failed";
export type RoomTurnState = "pending" | "running" | "waiting" | "checkpointed" | "completed" | "cancelled" | "uncertain";
export type RoomTaskNodeState =
  | "pending"
  | "ready"
  | "running"
  | "waiting_dependency"
  | "waiting_approval"
  | "rate_limited"
  | "retrying"
  | "accepted"
  | "blocked"
  | "failed"
  | "cancelled";
export type RoomDeliveryState = "pending" | "dispatching" | "confirmed" | "delivery_uncertain" | "rejected" | "cancelled";
export type RoomLeaseKind = "room_worker" | "sender" | "workspace" | "human_takeover";

/*
FNXC:SessionRoomStorage 2026-07-17-02:54:
Operational Room records are distinct from conversational Chat Rooms and keep
native provider identity separate from Happier and Fusion identities. Every
mutable aggregate record is project-scoped and versioned for optimistic writes.
*/
export interface RoomRecordV1 {
  readonly contractVersion: RoomStorageContractVersion;
  readonly id: RoomId;
  readonly projectId: ProjectId;
  readonly objective: string;
  readonly protocolId: RoomProtocolId;
  readonly protocolVersion: number;
  readonly state: RoomLifecycleState;
  readonly aggregateVersion: number;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface RoomSeatRecordV1 {
  readonly contractVersion: RoomStorageContractVersion;
  readonly id: RoomSeatId;
  readonly roomId: RoomId;
  readonly role: string;
  readonly state: RoomSeatState;
  readonly permissionScope: readonly string[];
  readonly activeBindingId: RoomBindingId | null;
  readonly roleVersion: number;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface RoomBindingRecordV1 {
  readonly contractVersion: RoomStorageContractVersion;
  readonly id: RoomBindingId;
  readonly roomId: RoomId;
  readonly seatId: RoomSeatId;
  readonly generation: number;
  readonly connectorId: SessionConnectorId;
  readonly providerId: string;
  readonly nativeSessionId: string;
  readonly happierSessionId: string | null;
  readonly serverProfileId: string | null;
  readonly hostId: string;
  readonly state: RoomBindingState;
  readonly attachedAt: IsoTimestamp;
  readonly detachedAt: IsoTimestamp | null;
  readonly replacedByBindingId: RoomBindingId | null;
}

export interface RoomTurnRecordV1 {
  readonly contractVersion: RoomStorageContractVersion;
  readonly id: RoomTurnId;
  readonly roomId: RoomId;
  readonly sequence: number;
  readonly protocolPhaseId: string;
  readonly membershipVersion: number;
  readonly state: RoomTurnState;
  readonly startedAt: IsoTimestamp | null;
  readonly endedAt: IsoTimestamp | null;
}

export interface RoomEventRecordV1 {
  readonly contractVersion: RoomStorageContractVersion;
  readonly id: RoomEventId;
  readonly roomId: RoomId;
  readonly projectId: ProjectId;
  readonly aggregateVersion: number;
  readonly eventType: string;
  readonly actorType: "human" | "controller" | "seat" | "system" | "evolution";
  readonly actorId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: IsoTimestamp;
  readonly cursor: EventCursor;
}

export interface RoomTaskNodeRecordV1 {
  readonly contractVersion: RoomStorageContractVersion;
  readonly id: RoomTaskNodeId;
  readonly roomId: RoomId;
  readonly parentNodeId: RoomTaskNodeId | null;
  readonly objective: string;
  readonly state: RoomTaskNodeState;
  readonly assignedSeatIds: readonly RoomSeatId[];
  readonly inputRefs: readonly string[];
  readonly outputRefs: readonly string[];
  readonly requiredGateIds: readonly string[];
  readonly progressSignature: string | null;
  readonly nodeVersion: number;
}

export interface RoomTaskEdgeRecordV1 {
  readonly contractVersion: RoomStorageContractVersion;
  readonly id: RoomTaskEdgeId;
  readonly roomId: RoomId;
  readonly fromNodeId: RoomTaskNodeId;
  readonly toNodeId: RoomTaskNodeId;
  readonly kind: "requires" | "informs" | "invalidates";
}

export interface RoomMessageRecordV1 {
  readonly contractVersion: RoomStorageContractVersion;
  readonly id: RoomMessageId;
  readonly roomId: RoomId;
  readonly turnId: RoomTurnId | null;
  readonly nodeId: RoomTaskNodeId | null;
  readonly originType: "operator" | "controller" | "seat" | "connector";
  readonly originId: string;
  readonly targetSeatIds: readonly RoomSeatId[];
  readonly intent: string;
  readonly contentHash: ContentHash;
  readonly authorityEnvelope: Readonly<Record<string, unknown>>;
  readonly createdAt: IsoTimestamp;
}

export interface RoomOutboxRecordV1 {
  readonly contractVersion: RoomStorageContractVersion;
  readonly id: string;
  readonly roomId: RoomId;
  readonly logicalMessageId: RoomMessageId;
  readonly localMessageId: string;
  readonly bindingId: RoomBindingId;
  readonly idempotencyKey: string;
  readonly payloadHash: ContentHash;
  readonly state: RoomDeliveryState;
  readonly attemptCount: number;
  readonly connectorAcknowledgementId: string | null;
  readonly nativeMessageId: string | null;
  readonly nativeCursor: EventCursor | null;
  readonly lastErrorCode: string | null;
  readonly nextAttemptAt: IsoTimestamp | null;
  readonly updatedAt: IsoTimestamp;
}

export interface RoomLeaseRecordV1 {
  readonly contractVersion: RoomStorageContractVersion;
  readonly id: RoomLeaseId;
  readonly roomId: RoomId;
  readonly kind: RoomLeaseKind;
  readonly resourceId: string;
  readonly holderId: string;
  readonly hostId: string;
  readonly epoch: number;
  readonly acquiredAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  readonly releasedAt: IsoTimestamp | null;
}

export interface RoomCheckpointRecordV1 {
  readonly contractVersion: RoomStorageContractVersion;
  readonly id: RoomCheckpointId;
  readonly roomId: RoomId;
  readonly turnId: RoomTurnId;
  readonly aggregateVersion: number;
  readonly eventCursor: EventCursor;
  readonly protocolState: Readonly<Record<string, unknown>>;
  readonly dagVersion: number;
  readonly bindingCursors: Readonly<Record<RoomBindingId, string | null>>;
  readonly pendingOutboxIds: readonly string[];
  readonly artifactRefs: readonly string[];
  readonly createdAt: IsoTimestamp;
}
