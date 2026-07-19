import { randomUUID } from "node:crypto";
import { isProxy } from "node:util/types";
import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";

import {
  RoomDomainError,
  addRoomSeat,
  attachRoomBinding,
  createRoomAggregate,
  transitionRoomLifecycle,
  type CreateRoomAggregateInput,
  type PendingRoomMembershipChangeV1,
  type RoomAggregateV1,
  type RoomBindingReplacementV1,
  type TransitionRoomLifecycleInput,
} from "./room-domain.js";
import type { RoomLifecycleState, RoomTaskNodeState } from "./room-contracts/storage.js";
import {
  assertRoomLeaseFence,
  loadRoomLeaseById,
  lockRoomLeaseResourceWithinTransaction,
  RoomLeaseFenceError,
  transferRoomSenderLeaseWithinTransaction,
  type AssertRoomLeaseFenceInput,
  type StoredRoomLeaseV1,
} from "./async-room-lease-store.js";
import type {
  RoomBindingRecordV1,
  RoomConnectorIngestionMode,
  RoomConnectorIngestionStateV1,
  RoomConnectorMessageRole,
  RoomConnectorStatus,
  RoomConnectorTranscriptBatchResultV1,
  RoomConnectorTranscriptItemV1,
  RoomConnectorTranscriptSource,
  RoomEventRecordV1,
  RoomMessageRecordV1,
  NativeIdeSenderTakeoverProjectionV1,
  RoomOutboxRecordV1,
} from "./room-contracts/storage.js";
import type {
  RoomAuthorityEnvelopeV1,
  RoomControllerCommandEnvelopeV1,
  RoomMessageIntent,
  RoomMessageTargetV1,
} from "./room-contracts/controller.js";
import {
  recordRunAuditEventWithinTransaction,
  type AsyncDataLayer,
  type DbTransaction,
} from "./postgres/data-layer.js";
import type { RunAuditEventInput } from "./types.js";
import {
  buildRoomConnectorLocalMessageId,
  compareRoomText,
  hashRoomValue,
} from "./room-integrity.js";
import { parseRoomAggregateProjection } from "./room-projection-replay.js";
import { approvalRequests, cliSessions, runAuditOutbox } from "./postgres/schema/project.js";
import {
  operationalRooms,
  roomBindingIngestionState,
  roomBindings,
  roomEvidence,
  roomEvents,
  roomIdempotencyKeys,
  roomInboxReceipts,
  roomLeases,
  roomMembershipChanges,
  roomMessageTargets,
  roomMessages,
  roomOutbox,
  roomOutboxAttempts,
  roomSeats,
  roomTaskEdges,
  roomTaskNodes,
  roomTurns,
} from "./postgres/schema/room.js";

type QueryHandle = AsyncDataLayer["db"] | DbTransaction;
type RoomEventActorType = RoomEventRecordV1["actorType"];

export interface RoomCommandContext {
  readonly eventId?: string;
  readonly actorType: RoomEventActorType;
  readonly actorId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly occurredAt: string;
}

export interface RoomRecoveryPostureV1 {
  readonly lifecycleState: RoomLifecycleState;
  readonly aggregateVersion: number;
  readonly humanPaused: boolean;
  readonly approvalState: "none" | "waiting" | "blocked";
}

export interface AssertRoomWorkerAuthorityInput {
  readonly roomId: string;
  readonly lease: StoredRoomLeaseV1;
  readonly expectedAggregateVersion: number;
  readonly now: string;
}

export interface RoomWorkerAuthorityV1 {
  readonly lease: StoredRoomLeaseV1;
  readonly posture: RoomRecoveryPostureV1;
}

export class RoomWorkerAuthorityError extends Error {
  readonly code = "room_worker_authority_revoked" as const;

  constructor(
    readonly posture: RoomRecoveryPostureV1,
    readonly reason: string,
  ) {
    super(`Room worker authority revoked: ${reason}`);
    this.name = "RoomWorkerAuthorityError";
  }
}

export type RoomRunAuditOutboxState = "pending" | "dispatching" | "exhausted" | "delivered";

export type RoomRunAuditOutboxEvent = RunAuditEventInput & {
  readonly id: string;
  readonly projectId: string;
  readonly timestamp: string;
};

export interface RoomRunAuditOutboxRecordV1 {
  readonly id: string;
  readonly dispatchSequence: number;
  readonly projectId: string;
  readonly roomId: string;
  readonly event: RoomRunAuditOutboxEvent;
  readonly state: RoomRunAuditOutboxState;
  readonly attemptCount: number;
  readonly nextAttemptAt: string | null;
  readonly claimToken: string | null;
  readonly claimExpiresAt: string | null;
  readonly lastErrorCode: string | null;
  readonly deliveredAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface RoomRunAuditOutboxRow {
  readonly id: string;
  readonly dispatchSequence: number;
  readonly projectId: string;
  readonly roomId: string;
  readonly timestamp: string;
  readonly taskId: string | null;
  readonly agentId: string;
  readonly runId: string;
  readonly domain: string;
  readonly mutationType: string;
  readonly target: string;
  readonly metadata: Record<string, unknown> | null;
  readonly state: string;
  readonly attemptCount: number;
  readonly nextAttemptAt: string | null;
  readonly claimToken: string | null;
  readonly claimExpiresAt: string | null;
  readonly lastErrorCode: string | null;
  readonly deliveredAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class RoomRunAuditOutboxConflictError extends Error {
  readonly code = "room_run_audit_outbox_conflict" as const;

  constructor(readonly eventId: string) {
    super(`Room run-audit outbox id ${eventId} already exists with a different payload`);
    this.name = "RoomRunAuditOutboxConflictError";
  }
}

function normalizeRunAuditOutboxJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeRunAuditOutboxJson(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, normalizeRunAuditOutboxJson(nested)]),
    );
  }
  return value ?? null;
}

function roomIdFromRunAuditEvent(event: RoomRunAuditOutboxEvent): string {
  const metadataRoomId = event.metadata && typeof event.metadata === "object"
    ? (event.metadata as Record<string, unknown>).roomId
    : null;
  if (typeof metadataRoomId === "string" && metadataRoomId.trim()) return metadataRoomId;
  return event.target;
}

function comparableRunAuditOutboxEvent(
  roomId: string,
  event: RoomRunAuditOutboxEvent,
): Record<string, unknown> {
  return {
    projectId: event.projectId,
    roomId,
    timestamp: event.timestamp,
    taskId: event.taskId ?? null,
    agentId: event.agentId,
    runId: event.runId,
    domain: event.domain,
    mutationType: event.mutationType,
    target: event.target,
    metadata: normalizeRunAuditOutboxJson(event.metadata ?? null),
  };
}

function parseRoomRunAuditDomain(domain: string): RunAuditEventInput["domain"] {
  if (domain === "database" || domain === "git" || domain === "filesystem" || domain === "sandbox") {
    return domain;
  }
  throw new Error("room_run_audit_outbox_invalid_domain");
}

function rowToRunAuditOutboxRecord(row: RoomRunAuditOutboxRow): RoomRunAuditOutboxRecordV1 {
  return {
    id: row.id,
    dispatchSequence: row.dispatchSequence,
    projectId: row.projectId,
    roomId: row.roomId,
    event: {
      id: row.id,
      projectId: row.projectId,
      timestamp: row.timestamp,
      taskId: row.taskId ?? undefined,
      agentId: row.agentId,
      runId: row.runId,
      domain: parseRoomRunAuditDomain(row.domain),
      mutationType: row.mutationType,
      target: row.target,
      metadata: row.metadata ?? undefined,
    },
    state: row.state as RoomRunAuditOutboxState,
    attemptCount: row.attemptCount,
    nextAttemptAt: row.nextAttemptAt,
    claimToken: row.claimToken,
    claimExpiresAt: row.claimExpiresAt,
    lastErrorCode: row.lastErrorCode,
    deliveredAt: row.deliveredAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function recoveryWithheldReason(posture: RoomRecoveryPostureV1): string | null {
  if (posture.humanPaused) return "human_paused";
  if (posture.approvalState === "waiting") return "approval_waiting";
  if (posture.approvalState === "blocked") return "approval_blocked";
  if ([
    "completed",
    "completed_with_risks",
    "partial",
    "cancelled",
    "failed",
    "archived",
  ].includes(posture.lifecycleState)) {
    return "terminal_state";
  }
  return posture.lifecycleState === "running" ? null : "lifecycle_not_running";
}

export type RoomCommittedEventListener = (
  event: RoomEventRecordV1,
) => void | Promise<void>;

export interface AsyncRoomStoreOptions {
  readonly projectId?: string;
  readonly onCommittedEvent?: RoomCommittedEventListener;
  readonly onNotificationError?: (error: unknown, event: RoomEventRecordV1) => void;
}

export const MAX_ROOM_EVENT_LIST_LIMIT = 1_000;

export interface ListRoomEventsOptionsV1 {
  readonly limit: number;
}

export type RoomStoreErrorCode =
  | "idempotency_conflict"
  | "idempotency_result_missing"
  | "room_event_list_invalid"
  | "routing_command_invalid"
  | "routing_target_not_found"
  | "routing_group_not_found"
  | "authority_scope_violation"
  | "connector_batch_invalid"
  | "delivery_target_conflict"
  | "delivery_state_conflict"
  | "delivery_attempt_conflict"
  | "sender_takeover_conflict"
  | "resume_cursor_conflict"
  | "inbox_payload_conflict"
  | "legacy_binding_not_found"
  | "legacy_binding_integrity_conflict"
  | "legacy_binding_already_imported"
  | "dag_version_conflict"
  | "task_node_version_conflict"
  | "accepted_node_frozen"
  | "reopen_requires_invalidated_upstream"
  | "task_graph_cycle"
  | "task_graph_self_edge"
  | "task_graph_unknown_node"
  | "task_graph_invalid_mutation"
  | "task_graph_critical_path_overflow"
  | "task_graph_version_overflow";

export class RoomStoreError extends Error {
  readonly code: RoomStoreErrorCode;

  constructor(code: RoomStoreErrorCode, message: string) {
    super(message);
    this.name = "RoomStoreError";
    this.code = code;
  }
}

function normalizeRoomEventListLimit(options: unknown): number | undefined {
  if (options === undefined) return undefined;
  const ownKeys = options !== null && typeof options === "object"
    ? Reflect.ownKeys(options)
    : [];
  if (
    options === null
    || typeof options !== "object"
    || Array.isArray(options)
    || Object.getPrototypeOf(options) !== Object.prototype
    || ownKeys.length !== 1
    || ownKeys[0] !== "limit"
  ) {
    throw new RoomStoreError(
      "room_event_list_invalid",
      "Room event list options must be a plain object containing only limit",
    );
  }
  const limit = (options as { readonly limit?: unknown }).limit;
  if (
    !Number.isSafeInteger(limit)
    || limit < 1
    || limit > MAX_ROOM_EVENT_LIST_LIMIT
  ) {
    throw new RoomStoreError(
      "room_event_list_invalid",
      `Room event list limit must be an integer between 1 and ${MAX_ROOM_EVENT_LIST_LIMIT}`,
    );
  }
  return limit;
}

export interface EnqueueRoomMessageInput {
  readonly roomId: string;
  readonly expectedAggregateVersion: number;
  readonly idempotencyKey: string;
  readonly message: {
    readonly id: string;
    readonly turnId: string | null;
    readonly nodeId: string | null;
    readonly originType: RoomMessageRecordV1["originType"];
    readonly originId: string;
    readonly targetSeatIds: readonly string[];
    readonly intent: string;
    readonly content: string;
    readonly authorityEnvelope: Readonly<Record<string, unknown>>;
    readonly createdAt: string;
  };
  readonly deliveries: readonly {
    readonly id: string;
    readonly bindingId: string;
  }[];
}

export interface StoredRoomMessageV1 extends RoomMessageRecordV1 {
  readonly content: string;
}

export interface DurableRoomMessageTargetV1 {
  readonly contractVersion: 1;
  readonly id: string;
  readonly projectId: string;
  readonly roomId: string;
  readonly messageId: string;
  readonly selectorKind: RoomMessageTargetV1["kind"];
  readonly selectorRef: string | null;
  readonly targetKind: "controller" | "seat";
  readonly seatId: string | null;
  readonly bindingId: string | null;
  readonly ordinal: number;
  readonly createdAt: string;
}

export interface StoredRoutedOperatorMessageV1 extends Omit<StoredRoomMessageV1, "authorityEnvelope"> {
  readonly target: RoomMessageTargetV1;
  readonly idempotencyKey: string;
  readonly expectedAggregateVersion: number;
  readonly authorityEnvelope: RoomAuthorityEnvelopeV1;
}

export interface RouteOperatorMessageResultV1 {
  readonly message: StoredRoutedOperatorMessageV1;
  readonly targets: readonly DurableRoomMessageTargetV1[];
  readonly deliveries: readonly RoomOutboxRecordV1[];
  readonly event: RoomEventRecordV1;
  readonly replayed: boolean;
}

export interface EnqueueRoomMessageResult {
  readonly message: StoredRoomMessageV1;
  readonly deliveries: readonly RoomOutboxRecordV1[];
  readonly event: RoomEventRecordV1;
  readonly replayed: boolean;
}

export interface BeginRoomDeliveryAttemptInput {
  readonly outboxId: string;
  readonly attemptId: string;
  readonly reconciliationFromCursor: string | null;
  readonly now: string;
  /**
   * Required once a binding has entered sender-lease management. Legacy rows
   * with no sender lease history remain readable during rolling upgrades, but
   * can never downgrade again after their first lease is created.
   */
  readonly senderFence?: Omit<AssertRoomLeaseFenceInput, "now"> & { readonly kind: "sender" };
}

export interface TransferNativeIdeSenderLeaseInput {
  readonly roomId: string;
  readonly bindingId: string;
  readonly takeoverId: string;
  readonly expectedTakeoverEpoch: number;
  readonly fromSenderFence: Omit<AssertRoomLeaseFenceInput, "now"> & { readonly kind: "sender" };
  readonly humanHolderId: string;
  readonly hostId: string;
  readonly now: string;
  readonly expiresAt: string;
}

export interface TransferNativeIdeSenderLeaseResult {
  readonly takeover: NativeIdeSenderTakeoverProjectionV1;
  readonly senderLease: StoredRoomLeaseV1;
}

export interface ResumeAutomaticSenderAfterNativeIdeInput {
  readonly roomId: string;
  readonly bindingId: string;
  readonly takeoverId: string;
  readonly expectedTakeoverEpoch: number;
  readonly confirmedCursor: string;
  readonly fromHumanFence: Omit<AssertRoomLeaseFenceInput, "now"> & { readonly kind: "sender" };
  readonly automaticHolderId: string;
  readonly hostId: string;
  readonly now: string;
  readonly expiresAt: string;
}

export interface ResumeAutomaticSenderAfterNativeIdeResult {
  readonly takeover: NativeIdeSenderTakeoverProjectionV1;
  readonly senderLease: StoredRoomLeaseV1;
}

export interface CompleteRoomDeliveryAttemptInput {
  readonly outboxId: string;
  readonly attemptId: string;
  readonly outcome: "confirmed" | "delivery_uncertain" | "retryable_failure" | "rejected";
  readonly connectorAcknowledgementId: string | null;
  readonly nativeMessageId: string | null;
  readonly nativeCursor: string | null;
  readonly errorCode: string | null;
  readonly nextAttemptAt: string | null;
  readonly now: string;
  readonly audit: {
    readonly runId: string;
    readonly agentId: string;
    readonly taskId?: string;
  };
}

export interface ReconcileRoomDeliveryInput {
  readonly outboxId: string;
  readonly expectedAttemptCount: number;
  readonly outcome: "confirmed" | "delivery_uncertain";
  readonly connectorAcknowledgementId: string | null;
  readonly nativeMessageId: string | null;
  readonly nativeCursor: string | null;
  readonly errorCode: string | null;
  readonly evidenceRef: string;
  readonly now: string;
  readonly audit: {
    readonly runId: string;
    readonly agentId: string;
    readonly taskId?: string;
  };
}

export interface RecordRoomInboxReceiptInput {
  readonly id: string;
  readonly roomId: string;
  readonly bindingId: string;
  readonly nativeMessageId: string | null;
  readonly logicalMessageId?: string | null;
  readonly nativeCursor: string;
  readonly payloadHash: string;
  readonly role?: RoomConnectorMessageRole;
  readonly occurredAt?: string;
  readonly source?: RoomConnectorTranscriptSource;
  readonly receivedAt: string;
}

export interface RoomInboxReceiptV1 {
  readonly id: string;
  readonly roomId: string;
  readonly bindingId: string;
  readonly nativeMessageId: string | null;
  readonly logicalMessageId: string | null;
  readonly nativeCursor: string;
  readonly payloadHash: string;
  readonly role: RoomConnectorMessageRole;
  readonly occurredAt: string;
  readonly source: RoomConnectorTranscriptSource;
  readonly receivedAt: string;
}

export interface GetRoomConnectorIngestionStateInput {
  readonly roomId: string;
  readonly bindingId: string;
}

export interface RecordRoomConnectorTranscriptBatchInput extends GetRoomConnectorIngestionStateInput {
  readonly source: RoomConnectorTranscriptSource;
  readonly fromCursor: string | null;
  readonly nextCursor: string | null;
  readonly truncated: boolean;
  readonly modeAfterCommit: RoomConnectorIngestionMode;
  readonly receivedAt: string;
  readonly items: readonly RoomConnectorTranscriptItemV1[];
}

export interface RecordRoomConnectorStatusInput extends GetRoomConnectorIngestionStateInput {
  readonly state: RoomConnectorStatus;
  readonly statusCursor: string | null;
  readonly nativeWriterDetected: boolean;
  readonly occurredAt: string;
}

export interface RecordRoomConnectorIngestionModeInput extends GetRoomConnectorIngestionStateInput {
  readonly mode: RoomConnectorIngestionMode;
  readonly occurredAt: string;
}

export type LegacyHappierBindingProviderId = "codex" | "claude" | "opencode";

export interface LegacyHappierBindingSourceV1 {
  readonly taskId: string;
  readonly cliSessionId: string;
  readonly providerId: LegacyHappierBindingProviderId;
  readonly nativeSessionId: string;
  readonly happierSessionId: string;
  readonly machineId: string;
  readonly hostId: string;
  readonly serverProfileId: string;
  readonly linkedAt: string;
  readonly cliSessionUpdatedAt: string;
}

export interface ImportLegacyHappierBindingInput {
  readonly room: {
    readonly id: string;
    readonly objective: string;
    readonly protocolId: string;
    readonly protocolVersion: number;
  };
  readonly seat: {
    readonly id: string;
    readonly role: string;
    readonly permissionScope: readonly string[];
  };
  readonly bindingId: string;
  readonly source: LegacyHappierBindingSourceV1;
  readonly now: string;
}

export interface CreateRoomWithExistingBindingsInput {
  readonly room: Omit<CreateRoomAggregateInput, "projectId" | "now">;
  readonly participants: readonly {
    readonly seat: {
      readonly id: string;
      readonly role: string;
      readonly permissionScope: readonly string[];
    };
    readonly binding: RoomBindingReplacementV1;
  }[];
  readonly now: string;
}

export type RoomMembershipMutationV1 =
  | {
      readonly action: "add";
      readonly seat: {
        readonly id: string;
        readonly role: string;
        readonly permissionScope: readonly string[];
      };
      readonly binding: RoomBindingReplacementV1;
    }
  | { readonly action: "remove"; readonly seatId: string }
  | { readonly action: "pause"; readonly seatId: string }
  | {
      readonly action: "replace";
      readonly seatId: string;
      readonly replacement: RoomBindingReplacementV1;
    }
  | { readonly action: "change_role"; readonly seatId: string; readonly role: string };

export interface RequestRoomMembershipChangeInput {
  readonly roomId: string;
  readonly changeId: string;
  readonly idempotencyKey: string;
  readonly expectedAggregateVersion: number;
  readonly expectedMembershipVersion: number;
  readonly activateAt: "next_turn_boundary";
  readonly mutation: RoomMembershipMutationV1;
  readonly reason: string;
  readonly requestedAt: string;
}

export interface ApplyRoomMembershipChangesAtTurnBoundaryInput {
  readonly roomId: string;
  readonly turnId: string;
  readonly idempotencyKey?: string;
  readonly expectedAggregateVersion: number;
  readonly expectedMembershipVersion: number;
  readonly now: string;
}

export type RoomTaskEdgeKindV1 = "requires" | "informs" | "invalidates";

export interface RoomTaskResourceHintsV1 {
  readonly estimatedDurationMs: number;
  readonly concurrencyClass: "serial" | "parallel";
  readonly preferredProviderIds: readonly string[];
}

export interface RoomTaskAuthorityScopeV1 {
  readonly allowedActions: readonly string[];
  readonly readPaths: readonly string[];
  readonly writePaths: readonly string[];
}

export interface RoomTaskRetryPolicyV1 {
  readonly maxAttempts: number;
  readonly backoff: "fixed" | "exponential";
  readonly baseDelayMs: number;
  readonly recoveryActions: readonly string[];
}

export interface RoomTaskNodeDefinitionV1 {
  readonly id: string;
  readonly parentNodeId: string | null;
  readonly objective: string;
  readonly inputRefs: readonly string[];
  readonly outputRefs: readonly string[];
  readonly roleRequirements: readonly string[];
  readonly capabilityRequirements: readonly string[];
  readonly resourceHints: RoomTaskResourceHintsV1;
  readonly authorityScope: RoomTaskAuthorityScopeV1;
  readonly acceptanceGateIds: readonly string[];
  readonly retryPolicy: RoomTaskRetryPolicyV1;
  readonly progressSignature: string;
}

export type RoomTaskNodeOriginV1 =
  | { readonly kind: "created" }
  | {
      readonly kind: "split_child" | "merge_result";
      readonly operationId: string;
      readonly sourceNodeIds: readonly string[];
    };

export interface RoomTaskNodeTerminalLineageV1 {
  readonly kind: "split" | "merge" | "cancel";
  readonly operationId: string;
  readonly at: string;
  readonly reasonHash: string;
}

export interface RoomTaskNodeProjectionV1 extends RoomTaskNodeDefinitionV1 {
  readonly state: RoomTaskNodeState;
  readonly nodeVersion: number;
  readonly acceptedAt: string | null;
  readonly acceptanceEvidenceIds: readonly string[];
  readonly invalidatedByEvidenceId: string | null;
  readonly reopenedByEvidenceId: string | null;
  readonly origin: RoomTaskNodeOriginV1;
  readonly terminalLineage: RoomTaskNodeTerminalLineageV1 | null;
}

export interface RoomTaskEdgeDefinitionV1 {
  readonly id: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly kind: RoomTaskEdgeKindV1;
}

export interface RoomTaskEdgeProjectionV1 extends RoomTaskEdgeDefinitionV1 {
  readonly createdByOperationId: string | null;
  readonly derivedFromEdgeIds: readonly string[];
}

export type RoomTaskTopologyNodeDefinitionV1 = Omit<RoomTaskNodeDefinitionV1, "parentNodeId">;

export type RoomTaskGraphMutationV1 =
  | { readonly action: "add_node"; readonly node: RoomTaskNodeDefinitionV1 }
  | { readonly action: "add_edge"; readonly edge: RoomTaskEdgeDefinitionV1 }
  | {
      readonly action: "update_node";
      readonly nodeId: string;
      readonly expectedNodeVersion: number;
      readonly patch: Partial<Pick<
        RoomTaskNodeDefinitionV1,
        | "objective"
        | "inputRefs"
        | "outputRefs"
        | "roleRequirements"
        | "capabilityRequirements"
        | "resourceHints"
        | "authorityScope"
        | "acceptanceGateIds"
        | "retryPolicy"
        | "progressSignature"
      >>;
      readonly evidenceIds: readonly string[];
    }
  | {
      readonly action: "transition_node";
      readonly nodeId: string;
      readonly expectedNodeVersion: number;
      readonly to: RoomTaskNodeState;
      readonly acceptanceEvidenceIds: readonly string[];
      readonly progressSignature: string;
    }
  | {
      readonly action: "invalidate_acceptance_evidence";
      readonly nodeId: string;
      readonly expectedNodeVersion: number;
      readonly acceptanceEvidenceId: string;
      readonly invalidatedByEvidenceId: string;
      readonly reason: string;
    }
  | {
      readonly action: "reopen_node";
      readonly nodeId: string;
      readonly expectedNodeVersion: number;
      readonly upstreamNodeId: string;
      readonly invalidatedByEvidenceId: string;
      readonly reason: string;
    }
  | {
      readonly action: "split_node";
      readonly nodeId: string;
      readonly children: readonly RoomTaskTopologyNodeDefinitionV1[];
      readonly causalEvidenceIds: readonly string[];
      readonly reason: string;
    }
  | {
      readonly action: "merge_nodes";
      readonly nodeIds: readonly string[];
      readonly mergedNode: RoomTaskTopologyNodeDefinitionV1;
      readonly causalEvidenceIds: readonly string[];
      readonly reason: string;
    }
  | {
      readonly action: "cancel_node";
      readonly nodeId: string;
      readonly causalEvidenceIds: readonly string[];
      readonly reason: string;
    }
  | {
      readonly action: "remove_edge";
      readonly edgeId: string;
      readonly causalEvidenceIds: readonly string[];
      readonly reason: string;
    };

export interface MutateRoomTaskGraphInputV1 {
  readonly roomId: string;
  readonly expectedAggregateVersion: number;
  readonly expectedDagVersion: number;
  readonly idempotencyKey: string;
  readonly mutations: readonly RoomTaskGraphMutationV1[];
  readonly mutatedAt: string;
  readonly expectedNodeVersions?: Readonly<Record<string, number>>;
}

export interface RoomTaskGraphProjectionV1 {
  readonly roomId: string;
  readonly aggregateVersion: number;
  readonly dagVersion: number;
  readonly nodes: readonly RoomTaskNodeProjectionV1[];
  readonly edges: readonly RoomTaskEdgeProjectionV1[];
  readonly readyNodeIds: readonly string[];
  readonly criticalPathNodeIds: readonly string[];
}

/**
 * Durable PostgreSQL owner for the operational Room aggregate.
 *
 * FNXC:SessionRoomStore 2026-07-17-03:33:
 * Projection updates and their immutable causal event commit in one database
 * transaction. Notifications are queued only after commit and never control
 * command success, preventing a slow/broken UI listener from blocking workers
 * or causing a committed command to be retried as if it had failed.
 */
export class AsyncRoomStore {
  private readonly projectId: string;
  private readonly listeners = new Set<RoomCommittedEventListener>();

  constructor(
    private readonly layer: AsyncDataLayer,
    private readonly options: AsyncRoomStoreOptions = {},
  ) {
    const projectId = options.projectId ?? layer.projectId;
    if (!projectId) {
      throw new Error("AsyncRoomStore requires an explicit projectId or a project-bound AsyncDataLayer");
    }
    if (layer.projectId && options.projectId && layer.projectId !== options.projectId) {
      throw new Error(
        `AsyncRoomStore project mismatch: layer=${layer.projectId}, options=${options.projectId}`,
      );
    }
    this.projectId = projectId;
    if (options.onCommittedEvent) this.listeners.add(options.onCommittedEvent);
  }

  subscribe(listener: RoomCommittedEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async createRoom(
    input: CreateRoomAggregateInput,
    context: RoomCommandContext,
  ): Promise<RoomAggregateV1> {
    if (input.projectId !== this.projectId) {
      throw new Error(
        `Cannot create Room for project ${input.projectId} through project-scoped store ${this.projectId}`,
      );
    }
    const aggregate = createRoomAggregate(input);
    const committed = await this.layer.transactionImmediate(async (tx) => {
      const existing = await tx
        .select({ id: operationalRooms.id })
        .from(operationalRooms)
        .where(and(eq(operationalRooms.id, aggregate.room.id), eq(operationalRooms.projectId, this.projectId)))
        .limit(1);
      if (existing.length > 0) {
        throw new RoomDomainError(
          "room_state_conflict",
          `Operational Room ${aggregate.room.id} already exists in project ${this.projectId}`,
        );
      }
      await tx.insert(operationalRooms).values({
        id: aggregate.room.id,
        projectId: aggregate.room.projectId,
        objective: aggregate.room.objective,
        protocolId: aggregate.room.protocolId,
        protocolVersion: aggregate.room.protocolVersion,
        protocolPhaseId: null,
        lifecycleState: aggregate.room.state,
        aggregateVersion: aggregate.room.aggregateVersion,
        membershipVersion: aggregate.membershipVersion,
        activeTurnId: aggregate.activeTurnId,
        completionContract: {},
        createdAt: aggregate.room.createdAt,
        updatedAt: aggregate.room.updatedAt,
      });
      const event = await insertRoomEvent(tx, aggregate, "room_created", context, {
        projectionVersion: 1,
        initialProjection: aggregate,
        initialProjectionHash: hashRoomValue(aggregate),
        objective: aggregate.room.objective,
        lifecycleState: aggregate.room.state,
        protocolId: aggregate.room.protocolId,
        protocolVersion: aggregate.room.protocolVersion,
        membershipVersion: aggregate.membershipVersion,
        activeTurnId: aggregate.activeTurnId,
        createdAt: aggregate.room.createdAt,
        updatedAt: aggregate.room.updatedAt,
      });
      return { aggregate, event };
    });
    this.publishCommittedEvent(committed.event);
    return committed.aggregate;
  }

  /**
   * Atomically create a Room whose initial membership is already bound to two
   * or more exact existing native Sessions. No observable Room is committed
   * until every immutable identity reservation, seat, binding, and creation
   * event succeeds.
   *
   * FNXC:SessionRoomExistingBindings 2026-07-18-10:25:
   * Initial existing-Session creation uses one globally ordered advisory-lock
   * set for the Room and every provider-native/Happier identity. A durable
   * command hash replays the original creation projection after later Room
   * mutations, while any changed input fails closed before another write.
   */
  async createRoomWithExistingBindings(
    input: CreateRoomWithExistingBindingsInput,
    context: RoomCommandContext,
  ): Promise<RoomAggregateV1> {
    if (input.participants.length < 2) {
      throw new RoomDomainError(
        "room_state_conflict",
        "An existing-Session Room requires at least two initial participants",
      );
    }
    const participants = input.participants
      .map((participant) => ({
        seat: {
          ...participant.seat,
          permissionScope: [...participant.seat.permissionScope],
        },
        binding: { ...participant.binding },
      }));
    validateInitialExistingParticipants(participants);

    const base = createRoomAggregate({
      ...input.room,
      projectId: this.projectId,
      now: input.now,
    });
    let validated = base;
    for (const participant of participants) {
      validated = addRoomSeat(validated, {
        ...participant.seat,
        expectedAggregateVersion: validated.room.aggregateVersion,
        now: input.now,
      });
      validated = attachRoomBinding(validated, {
        ...participant.binding,
        seatId: participant.seat.id,
        expectedAggregateVersion: validated.room.aggregateVersion,
        now: input.now,
      });
    }
    const aggregate: RoomAggregateV1 = {
      ...validated,
      room: base.room,
      membershipVersion: 1,
    };
    // Retry identity is the immutable creation command, not the wall-clock used
    // by the first successful projection. A later acknowledgement-loss retry
    // must replay that original projection instead of conflicting on `now`.
    const commandHash = hashRoomValue({
      projectId: this.projectId,
      room: input.room,
      participants,
    });
    const idempotencyKey = "create-room-with-existing-bindings";

    const committed = await this.layer.transactionImmediate(async (tx) => {
      await lockRoomBindingIdentities(
        tx,
        participants.map((participant) => participant.binding),
        [`fusion-room-create-v1:${this.projectId}:${aggregate.room.id}`],
      );
      const existing = await loadRoomAggregateProjection(
        tx,
        this.projectId,
        aggregate.room.id,
      );
      if (existing) {
        const idempotencyRows = await tx
          .select()
          .from(roomIdempotencyKeys)
          .where(and(
            eq(roomIdempotencyKeys.projectId, this.projectId),
            eq(roomIdempotencyKeys.roomId, aggregate.room.id),
            eq(roomIdempotencyKeys.idempotencyKey, idempotencyKey),
          ))
          .limit(1);
        const idempotency = idempotencyRows[0];
        if (
          !idempotency
          || idempotency.commandType !== "create_room_with_existing_bindings"
          || idempotency.commandHash !== commandHash
        ) {
          throw new RoomStoreError(
            "idempotency_conflict",
            `Operational Room ${aggregate.room.id} already exists with different initial Sessions`,
          );
        }
        if (!idempotency.resultEventId) {
          throw new RoomStoreError(
            "idempotency_result_missing",
            `Existing-Session Room ${aggregate.room.id} has no committed creation result`,
          );
        }
        return {
          aggregate: await loadInitialRoomCreationResult(
            tx,
            this.projectId,
            aggregate.room.id,
            idempotency.resultEventId,
          ),
          event: null,
        };
      }
      for (const participant of participants) {
        await assertRoomBindingIdentityAvailableAfterLock(tx, participant.binding);
      }

      await tx.insert(operationalRooms).values({
        id: aggregate.room.id,
        projectId: aggregate.room.projectId,
        objective: aggregate.room.objective,
        protocolId: aggregate.room.protocolId,
        protocolVersion: aggregate.room.protocolVersion,
        protocolPhaseId: null,
        lifecycleState: aggregate.room.state,
        aggregateVersion: aggregate.room.aggregateVersion,
        membershipVersion: aggregate.membershipVersion,
        activeTurnId: aggregate.activeTurnId,
        completionContract: {},
        createdAt: aggregate.room.createdAt,
        updatedAt: aggregate.room.updatedAt,
      });
      await tx.insert(roomSeats).values(participants.map((participant) => ({
        id: participant.seat.id,
        projectId: this.projectId,
        roomId: aggregate.room.id,
        role: participant.seat.role,
        roleVersion: 1,
        roleHistory: [],
        permissionScope: [...participant.seat.permissionScope],
        state: "ready" as const,
        activeBindingId: participant.binding.id,
        createdAt: input.now,
        updatedAt: input.now,
      })));
      await tx.insert(roomBindings).values(participants.map((participant) => ({
        id: participant.binding.id,
        projectId: this.projectId,
        roomId: aggregate.room.id,
        seatId: participant.seat.id,
        generation: 1,
        connectorId: participant.binding.connectorId,
        providerId: participant.binding.providerId,
        nativeSessionId: participant.binding.nativeSessionId,
        happierSessionId: participant.binding.happierSessionId,
        serverProfileId: participant.binding.serverProfileId,
        machineId: participant.binding.machineId,
        hostId: participant.binding.hostId,
        state: "attached" as const,
        attachedAt: input.now,
        detachedAt: null,
        replacedByBindingId: null,
        replacementReason: null,
      })));
      const event = await insertRoomEvent(tx, aggregate, "room_created", context, {
        projectionVersion: 1,
        initialProjection: aggregate,
        initialProjectionHash: hashRoomValue(aggregate),
        objective: aggregate.room.objective,
        lifecycleState: aggregate.room.state,
        protocolId: aggregate.room.protocolId,
        protocolVersion: aggregate.room.protocolVersion,
        membershipVersion: aggregate.membershipVersion,
        activeTurnId: aggregate.activeTurnId,
        createdAt: aggregate.room.createdAt,
        updatedAt: aggregate.room.updatedAt,
        initialExistingSessionBindingIds: participants.map((participant) => participant.binding.id),
      });
      await tx.insert(roomIdempotencyKeys).values({
        id: `room-idempotency-${randomUUID()}`,
        projectId: this.projectId,
        roomId: aggregate.room.id,
        idempotencyKey,
        commandType: "create_room_with_existing_bindings",
        commandHash,
        resultEventId: event.id,
        createdAt: input.now,
        expiresAt: null,
      });
      return { aggregate, event };
    });
    if (committed.event) this.publishCommittedEvent(committed.event);
    return committed.aggregate;
  }

  /**
   * Import the immutable identity snapshot of an existing task-owned Happier
   * Session into a new one-seat operational Room. The legacy CLI Session is a
   * read-only source: no migration marker or ownership rewrite is permitted.
   *
   * FNXC:SessionRoomLegacyImport 2026-07-17-04:35:
   * A provider-native Session may have only one active Room owner. Serialize
   * by native identity, verify the exact legacy row, then commit Room, seat,
   * binding, and replayable creation event atomically. Any final append failure
   * rolls every Room write back while the source row remains untouched.
   */
  async importLegacyHappierBinding(
    input: ImportLegacyHappierBindingInput,
    context: RoomCommandContext,
  ): Promise<RoomAggregateV1> {
    assertLegacyImportInput(input);
    const base = createRoomAggregate({
      id: input.room.id,
      projectId: this.projectId,
      objective: input.room.objective,
      protocolId: input.room.protocolId,
      protocolVersion: input.room.protocolVersion,
      now: input.now,
    });
    const aggregate: RoomAggregateV1 = {
      ...base,
      membershipVersion: 1,
      seats: [{
        contractVersion: 1,
        id: input.seat.id,
        roomId: input.room.id,
        role: input.seat.role,
        state: "ready",
        permissionScope: [...input.seat.permissionScope],
        activeBindingId: input.bindingId,
        roleVersion: 1,
        createdAt: input.now,
        updatedAt: input.now,
      }],
      bindings: [{
        contractVersion: 1,
        id: input.bindingId,
        roomId: input.room.id,
        seatId: input.seat.id,
        generation: 1,
        connectorId: "happier",
        providerId: input.source.providerId,
        nativeSessionId: input.source.nativeSessionId,
        happierSessionId: input.source.happierSessionId,
        serverProfileId: input.source.serverProfileId,
        machineId: input.source.machineId,
        hostId: input.source.hostId,
        state: "attached",
        attachedAt: input.source.linkedAt,
        detachedAt: null,
        replacedByBindingId: null,
      }],
    };
    const sourceHash = hashRoomValue(input.source);

    const committed = await this.layer.transactionImmediate(async (tx) => {
      await lockLegacyHappierBindingSource(
        tx,
        input.source.providerId,
        input.source.nativeSessionId,
        input.source.happierSessionId,
      );
      await verifyLegacyHappierBindingSource(tx, this.projectId, input.source);

      const activeNativeOwners = await tx
        .select({ roomId: roomBindings.roomId, bindingId: roomBindings.id })
        .from(roomBindings)
        .where(and(
          eq(roomBindings.providerId, input.source.providerId),
          eq(roomBindings.nativeSessionId, input.source.nativeSessionId),
          inArray(roomBindings.state, ACTIVE_ROOM_BINDING_STATES),
        ))
        .limit(1);
      const activeNativeOwner = activeNativeOwners[0];
      if (activeNativeOwner) {
        throw new RoomStoreError(
          "legacy_binding_already_imported",
          `Legacy Happier binding ${input.source.cliSessionId} already belongs to Room ${activeNativeOwner.roomId} as binding ${activeNativeOwner.bindingId}`,
        );
      }

      const activeHappierOwners = await tx
        .select({ roomId: roomBindings.roomId, bindingId: roomBindings.id })
        .from(roomBindings)
        .where(and(
          eq(roomBindings.connectorId, "happier"),
          eq(roomBindings.happierSessionId, input.source.happierSessionId),
          inArray(roomBindings.state, ACTIVE_ROOM_BINDING_STATES),
        ))
        .limit(1);
      const activeHappierOwner = activeHappierOwners[0];
      if (activeHappierOwner) {
        throw new RoomStoreError(
          "legacy_binding_integrity_conflict",
          `Happier Session ${input.source.happierSessionId} already belongs to Room ${activeHappierOwner.roomId} as binding ${activeHappierOwner.bindingId}`,
        );
      }

      const pendingOwners = await tx
        .select({ roomId: roomMembershipChanges.roomId, changeId: roomMembershipChanges.id })
        .from(roomMembershipChanges)
        .where(and(
          eq(roomMembershipChanges.state, "waiting_turn_boundary"),
          or(
            and(
              eq(roomMembershipChanges.reservedProviderId, input.source.providerId),
              eq(roomMembershipChanges.reservedNativeSessionId, input.source.nativeSessionId),
            ),
            and(
              eq(roomMembershipChanges.reservedConnectorId, "happier"),
              eq(roomMembershipChanges.reservedHappierSessionId, input.source.happierSessionId),
            ),
          ),
        ))
        .limit(1);
      if (pendingOwners[0]) {
        throw new RoomStoreError(
          "legacy_binding_integrity_conflict",
          `Legacy Happier binding ${input.source.cliSessionId} conflicts with pending membership change ${pendingOwners[0].changeId} in Room ${pendingOwners[0].roomId}`,
        );
      }

      const existingRooms = await tx
        .select({ id: operationalRooms.id })
        .from(operationalRooms)
        .where(and(
          eq(operationalRooms.projectId, this.projectId),
          eq(operationalRooms.id, input.room.id),
        ))
        .limit(1);
      if (existingRooms.length > 0) {
        throw new RoomDomainError(
          "room_state_conflict",
          `Operational Room ${input.room.id} already exists in project ${this.projectId}`,
        );
      }

      await tx.insert(operationalRooms).values({
        id: aggregate.room.id,
        projectId: aggregate.room.projectId,
        objective: aggregate.room.objective,
        protocolId: aggregate.room.protocolId,
        protocolVersion: aggregate.room.protocolVersion,
        protocolPhaseId: null,
        lifecycleState: aggregate.room.state,
        aggregateVersion: aggregate.room.aggregateVersion,
        membershipVersion: aggregate.membershipVersion,
        activeTurnId: aggregate.activeTurnId,
        completionContract: {},
        createdAt: aggregate.room.createdAt,
        updatedAt: aggregate.room.updatedAt,
      });
      await tx.insert(roomSeats).values({
        id: input.seat.id,
        projectId: this.projectId,
        roomId: input.room.id,
        role: input.seat.role,
        roleVersion: 1,
        roleHistory: [],
        permissionScope: [...input.seat.permissionScope],
        state: "ready",
        activeBindingId: input.bindingId,
        createdAt: input.now,
        updatedAt: input.now,
      });
      await tx.insert(roomBindings).values({
        id: input.bindingId,
        projectId: this.projectId,
        roomId: input.room.id,
        seatId: input.seat.id,
        generation: 1,
        connectorId: "happier",
        providerId: input.source.providerId,
        nativeSessionId: input.source.nativeSessionId,
        happierSessionId: input.source.happierSessionId,
        serverProfileId: input.source.serverProfileId,
        machineId: input.source.machineId,
        hostId: input.source.hostId,
        state: "attached",
        attachedAt: input.source.linkedAt,
        detachedAt: null,
        replacedByBindingId: null,
        replacementReason: null,
      });
      const event = await insertRoomEvent(tx, aggregate, "room_created", context, {
        projectionVersion: 1,
        initialProjection: aggregate,
        initialProjectionHash: hashRoomValue(aggregate),
        objective: aggregate.room.objective,
        lifecycleState: aggregate.room.state,
        protocolId: aggregate.room.protocolId,
        protocolVersion: aggregate.room.protocolVersion,
        membershipVersion: aggregate.membershipVersion,
        activeTurnId: aggregate.activeTurnId,
        createdAt: aggregate.room.createdAt,
        updatedAt: aggregate.room.updatedAt,
        importSource: {
          kind: "task_happier_direct_session_v1",
          taskId: input.source.taskId,
          cliSessionId: input.source.cliSessionId,
          sourceHash,
        },
      });
      return { aggregate, event };
    });

    this.publishCommittedEvent(committed.event);
    return committed.aggregate;
  }

  async transitionLifecycle(
    roomId: string,
    input: TransitionRoomLifecycleInput,
    context: RoomCommandContext,
  ): Promise<RoomAggregateV1> {
    const committed = await this.layer.transactionImmediate(async (tx) => {
      const current = await loadRoomAggregateProjection(tx, this.projectId, roomId);
      if (!current) {
        throw new RoomDomainError("room_state_conflict", `Operational Room ${roomId} does not exist`);
      }
      const next = transitionRoomLifecycle(current, input);
      const updated = await tx
        .update(operationalRooms)
        .set({
          lifecycleState: next.room.state,
          aggregateVersion: next.room.aggregateVersion,
          updatedAt: next.room.updatedAt,
        })
        .where(
          and(
            eq(operationalRooms.id, roomId),
            eq(operationalRooms.projectId, this.projectId),
            eq(operationalRooms.aggregateVersion, input.expectedAggregateVersion),
          ),
        )
        .returning({ id: operationalRooms.id });
      if (updated.length !== 1) {
        throw new RoomDomainError(
          "aggregate_version_conflict",
          `Concurrent Room update rejected for ${roomId}`,
          { expected: input.expectedAggregateVersion },
        );
      }
      if (current.room.state === "running" && next.room.state !== "running") {
        /*
        FNXC:SessionRoomAuthority 2026-07-18-02:14:
        A committed pause, approval block, or terminal lifecycle transition
        revokes every active Room-worker lease in the same transaction. The
        process signal remains a latency hint; the durable fence is authority.
        */
        await tx
          .update(roomLeases)
          .set({ releasedAt: input.now })
          .where(and(
            eq(roomLeases.projectId, this.projectId),
            eq(roomLeases.roomId, roomId),
            eq(roomLeases.kind, "room_worker"),
            isNull(roomLeases.releasedAt),
          ));
      }
      const event = await insertRoomEvent(tx, next, "room_lifecycle_transitioned", context, {
        projectionVersion: 1,
        from: current.room.state,
        to: next.room.state,
        updatedAt: next.room.updatedAt,
      });
      return { aggregate: next, event };
    });
    this.publishCommittedEvent(committed.event);
    return committed.aggregate;
  }

  async getRoom(roomId: string): Promise<RoomAggregateV1 | undefined> {
    return loadRoomAggregateProjection(this.layer.db, this.projectId, roomId);
  }

  async getTaskGraph(roomId: string): Promise<RoomTaskGraphProjectionV1 | null> {
    assertNonBlankTaskGraphString(roomId, "roomId");
    return this.layer.transaction(
      (tx) => loadRoomTaskGraphProjection(tx, this.projectId, roomId),
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  /**
   * Commit one versioned task-graph command against the Room aggregate. The
   * aggregate CAS, DAG CAS, node/edge projections, immutable event, and
   * idempotency result share one PostgreSQL transaction.
   *
   * FNXC:SessionRoomTaskDag 2026-07-18-12:48:
   * `requires` is the only readiness/critical-path edge. Accepted work stays
   * frozen after evidence invalidation until a separate causal reopen command
   * names the invalidated upstream evidence. Replays return the first event's
   * projection even after later commands advance the live Room.
   *
   * FNXC:SessionRoomTaskDag 2026-07-18-13:58:
   * Every committed graph command retains bounded normalized mutation audit.
   * Evidence identities remain explicit, while mutable task content, progress
   * text, and causal reasons are represented only by canonical SHA-256 hashes;
   * an idempotent retry must keep returning the original immutable event. A
   * critical path whose duration cannot be represented exactly is rejected
   * before any projection or event write begins.
   */
  async mutateTaskGraph(
    rawInput: MutateRoomTaskGraphInputV1,
    rawContext: RoomCommandContext,
  ): Promise<RoomTaskGraphProjectionV1> {
    const { input, context } = normalizeTaskGraphRuntimeCommand(rawInput, rawContext);
    const commandHash = hashRoomValue({
      roomId: input.roomId,
      expectedAggregateVersion: input.expectedAggregateVersion,
      expectedDagVersion: input.expectedDagVersion,
      expectedNodeVersions: input.expectedNodeVersions,
      mutations: input.mutations,
    });
    const topologyOperationId = buildTaskGraphTopologyOperationId(input, commandHash);
    const topologyCausalEvidenceIds = collectTaskGraphTopologyCausalEvidenceIds(input.mutations);

    const committed = await this.layer.transactionImmediate(async (tx) => {
      const roomRows = await tx
        .select({ id: operationalRooms.id })
        .from(operationalRooms)
        .where(and(
          eq(operationalRooms.projectId, this.projectId),
          eq(operationalRooms.id, input.roomId),
        ))
        .limit(1);
      if (!roomRows[0]) {
        throw new RoomDomainError(
          "room_state_conflict",
          `Operational Room ${input.roomId} does not exist in project ${this.projectId}`,
        );
      }

      const reservationId = `room-idempotency-${randomUUID()}`;
      const reservation = await tx
        .insert(roomIdempotencyKeys)
        .values({
          id: reservationId,
          projectId: this.projectId,
          roomId: input.roomId,
          idempotencyKey: input.idempotencyKey,
          commandType: "mutate_task_graph",
          commandHash,
          resultEventId: null,
          createdAt: input.mutatedAt,
          expiresAt: null,
        })
        .onConflictDoNothing()
        .returning({ id: roomIdempotencyKeys.id });

      if (reservation.length === 0) {
        const existingRows = await tx
          .select()
          .from(roomIdempotencyKeys)
          .where(and(
            eq(roomIdempotencyKeys.projectId, this.projectId),
            eq(roomIdempotencyKeys.roomId, input.roomId),
            eq(roomIdempotencyKeys.idempotencyKey, input.idempotencyKey),
          ))
          .limit(1);
        const existing = existingRows[0];
        if (
          !existing
          || existing.commandType !== "mutate_task_graph"
          || existing.commandHash !== commandHash
        ) {
          throw new RoomStoreError(
            "idempotency_conflict",
            `Idempotency key ${input.idempotencyKey} was already used for a different Room command`,
          );
        }
        if (!existing.resultEventId) {
          throw new RoomStoreError(
            "idempotency_result_missing",
            `Idempotency key ${input.idempotencyKey} has no committed task-graph event`,
          );
        }
        return {
          projection: await loadTaskGraphMutationResult(
            tx,
            this.projectId,
            input.roomId,
            existing.resultEventId,
          ),
          event: null,
        };
      }

      if (topologyCausalEvidenceIds.length > 0) {
        const evidenceRows = await tx
          .select({ id: roomEvidence.id })
          .from(roomEvidence)
          .where(and(
            eq(roomEvidence.projectId, this.projectId),
            eq(roomEvidence.roomId, input.roomId),
            inArray(roomEvidence.id, topologyCausalEvidenceIds),
          ));
        const foundIds = new Set(evidenceRows.map((row) => row.id));
        const missingIds = topologyCausalEvidenceIds.filter((evidenceId) => !foundIds.has(evidenceId));
        if (missingIds.length > 0) {
          throw new RoomStoreError(
            "task_graph_invalid_mutation",
            `Topology command references evidence outside Room ${input.roomId}: ${missingIds.join(", ")}`,
          );
        }
      }

      const [current, currentGraph] = await Promise.all([
        loadRoomAggregateProjection(tx, this.projectId, input.roomId),
        loadRoomTaskGraphProjection(tx, this.projectId, input.roomId),
      ]);
      if (!current || !currentGraph) {
        throw new RoomDomainError(
          "room_state_conflict",
          `Operational Room ${input.roomId} disappeared during task-graph mutation`,
        );
      }
      if (current.room.aggregateVersion !== input.expectedAggregateVersion) {
        throw new RoomDomainError(
          "aggregate_version_conflict",
          `Room ${input.roomId} expected aggregate version ${input.expectedAggregateVersion} but is ${current.room.aggregateVersion}`,
          {
            expected: input.expectedAggregateVersion,
            actual: current.room.aggregateVersion,
          },
        );
      }
      if (currentGraph.dagVersion !== input.expectedDagVersion) {
        throw new RoomStoreError(
          "dag_version_conflict",
          `Room ${input.roomId} expected DAG version ${input.expectedDagVersion} but is ${currentGraph.dagVersion}`,
        );
      }
      if (isEarlierTimestamp(input.mutatedAt, current.room.updatedAt)) {
        throw new RoomStoreError(
          "task_graph_invalid_mutation",
          `Task-graph mutation timestamp cannot precede Room ${input.roomId} updatedAt`,
        );
      }

      const applied = applyTaskGraphMutations(currentGraph, input, topologyOperationId);
      const projection = applied.projection;
      const next: RoomAggregateV1 = {
        ...current,
        room: {
          ...current.room,
          aggregateVersion: projection.aggregateVersion,
          updatedAt: input.mutatedAt,
        },
      };
      const updated = await tx
        .update(operationalRooms)
        .set({
          aggregateVersion: projection.aggregateVersion,
          taskGraphVersion: projection.dagVersion,
          updatedAt: input.mutatedAt,
        })
        .where(and(
          eq(operationalRooms.projectId, this.projectId),
          eq(operationalRooms.id, input.roomId),
          eq(operationalRooms.aggregateVersion, input.expectedAggregateVersion),
          eq(operationalRooms.taskGraphVersion, input.expectedDagVersion),
        ))
        .returning({ id: operationalRooms.id });
      if (updated.length !== 1) {
        throw new RoomStoreError(
          "dag_version_conflict",
          `Concurrent task-graph mutation rejected for Room ${input.roomId}`,
        );
      }

      await persistRoomTaskGraphProjection(
        tx,
        this.projectId,
        currentGraph,
        projection,
        input.mutatedAt,
        applied.retiredEdges,
      );
      const event = await insertRoomEvent(tx, next, "room_task_graph_mutated", context, {
        projectionVersion: 1,
        dagVersion: projection.dagVersion,
        idempotencyKey: input.idempotencyKey,
        mutationActions: input.mutations.map((mutation) => mutation.action),
        commandAudit: buildTaskGraphCommandAudit(input.mutations, topologyOperationId),
        projection,
        projectionHash: hashRoomValue(projection),
        mutatedAt: input.mutatedAt,
      });
      await tx
        .update(roomIdempotencyKeys)
        .set({ resultEventId: event.id })
        .where(eq(roomIdempotencyKeys.id, reservationId));
      return { projection, event };
    });
    if (committed.event) this.publishCommittedEvent(committed.event);
    return committed.projection;
  }

  /**
   * Durable restart discovery for backend Room workers. The process-local
   * committed-event subscription is only a latency hint; this PostgreSQL scan
   * is the correctness path across crashes and controller instances.
   */
  async listRunnableRooms(): Promise<readonly RoomAggregateV1[]> {
    const rows = await this.layer.db
      .select({ id: operationalRooms.id })
      .from(operationalRooms)
      .where(and(
        eq(operationalRooms.projectId, this.projectId),
        eq(operationalRooms.lifecycleState, "running"),
      ))
      .orderBy(asc(operationalRooms.updatedAt), asc(operationalRooms.id));
    const projections = await Promise.all(
      rows.map(({ id }) => loadRoomAggregateProjection(this.layer.db, this.projectId, id)),
    );
    return projections.filter((room): room is RoomAggregateV1 => room?.room.state === "running");
  }

  async enqueueRunAuditEvent(event: RoomRunAuditOutboxEvent): Promise<RoomRunAuditOutboxRecordV1> {
    if (event.projectId !== this.projectId) {
      throw new RoomRunAuditOutboxConflictError(event.id);
    }
    const roomId = roomIdFromRunAuditEvent(event);
    return this.layer.transactionImmediate(async (tx) => {
      const lockKey = `fusion-room-run-audit-outbox-v1:${this.projectId}:${roomId}`;
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
      const inserted = await tx
        .insert(runAuditOutbox)
        .values({
          id: event.id,
          projectId: this.projectId,
          roomId,
          timestamp: event.timestamp,
          taskId: event.taskId ?? null,
          agentId: event.agentId,
          runId: event.runId,
          domain: event.domain,
          mutationType: event.mutationType,
          target: event.target,
          metadata: event.metadata ?? null,
          state: "pending",
          attemptCount: 0,
          nextAttemptAt: null,
          claimToken: null,
          claimExpiresAt: null,
          lastErrorCode: null,
          deliveredAt: null,
          createdAt: event.timestamp,
          updatedAt: event.timestamp,
        })
        .onConflictDoNothing()
        .returning();
      if (inserted[0]) return rowToRunAuditOutboxRecord(inserted[0] as RoomRunAuditOutboxRow);

      const existing = await tx
        .select()
        .from(runAuditOutbox)
        .where(and(
          eq(runAuditOutbox.projectId, this.projectId),
          eq(runAuditOutbox.id, event.id),
        ))
        .limit(1)
        .then((rows) => rows[0] as RoomRunAuditOutboxRow | undefined);
      if (!existing) throw new RoomRunAuditOutboxConflictError(event.id);
      const existingEvent: RoomRunAuditOutboxEvent = {
        id: existing.id,
        projectId: existing.projectId,
        timestamp: existing.timestamp,
        taskId: existing.taskId ?? undefined,
        agentId: existing.agentId,
        runId: existing.runId,
        domain: parseRoomRunAuditDomain(existing.domain),
        mutationType: existing.mutationType,
        target: existing.target,
        metadata: existing.metadata ?? undefined,
      };
      if (
        JSON.stringify(comparableRunAuditOutboxEvent(existing.roomId, existingEvent))
        !== JSON.stringify(comparableRunAuditOutboxEvent(roomId, event))
      ) {
        throw new RoomRunAuditOutboxConflictError(event.id);
      }
      return rowToRunAuditOutboxRecord(existing);
    });
  }

  async claimRunAuditEvents(input: {
    readonly claimToken: string;
    readonly now: string;
    readonly claimExpiresAt: string;
    readonly limit: number;
  }): Promise<readonly RoomRunAuditOutboxRecordV1[]> {
    return this.layer.transactionImmediate(async (tx) => {
      const rows = await tx
        .select()
        .from(runAuditOutbox)
        .where(and(
          eq(runAuditOutbox.projectId, this.projectId),
          or(
            and(
              eq(runAuditOutbox.state, "pending"),
              or(
                isNull(runAuditOutbox.nextAttemptAt),
                sql`${runAuditOutbox.nextAttemptAt} <= ${input.now}`,
              ),
            ),
            and(
              eq(runAuditOutbox.state, "dispatching"),
              sql`${runAuditOutbox.claimExpiresAt} IS NOT NULL AND ${runAuditOutbox.claimExpiresAt} <= ${input.now}`,
            ),
          ),
          sql`NOT EXISTS (
            SELECT 1
            FROM project.run_audit_outbox AS earlier
            WHERE earlier.project_id = ${runAuditOutbox.projectId}
              AND earlier.room_id = ${runAuditOutbox.roomId}
              AND earlier.dispatch_sequence < ${runAuditOutbox.dispatchSequence}
              AND earlier.state NOT IN ('delivered', 'exhausted')
          )`,
        ))
        .orderBy(asc(runAuditOutbox.dispatchSequence))
        .limit(input.limit)
        .for("update");
      const claimed: RoomRunAuditOutboxRecordV1[] = [];
      for (const row of rows as RoomRunAuditOutboxRow[]) {
        const updated = await tx
          .update(runAuditOutbox)
          .set({
            state: "dispatching",
            attemptCount: sql`${runAuditOutbox.attemptCount} + 1`,
            claimToken: input.claimToken,
            claimExpiresAt: input.claimExpiresAt,
            updatedAt: input.now,
          })
          .where(and(
            eq(runAuditOutbox.projectId, this.projectId),
            eq(runAuditOutbox.id, row.id),
          ))
          .returning()
          .then((nextRows) => nextRows[0] as RoomRunAuditOutboxRow | undefined);
        if (updated) claimed.push(rowToRunAuditOutboxRecord(updated));
      }
      return claimed;
    });
  }

  async markRunAuditEventDelivered(input: {
    readonly id: string;
    readonly claimToken: string;
    readonly now: string;
  }): Promise<RoomRunAuditOutboxRecordV1> {
    return this.layer.transactionImmediate(async (tx) => {
      const updated = await tx
        .update(runAuditOutbox)
        .set({
          state: "delivered",
          claimToken: null,
          claimExpiresAt: null,
          nextAttemptAt: null,
          deliveredAt: input.now,
          updatedAt: input.now,
        })
        .where(and(
          eq(runAuditOutbox.projectId, this.projectId),
          eq(runAuditOutbox.id, input.id),
          eq(runAuditOutbox.state, "dispatching"),
          eq(runAuditOutbox.claimToken, input.claimToken),
        ))
        .returning()
        .then((rows) => rows[0] as RoomRunAuditOutboxRow | undefined);
      if (!updated) {
        throw new RoomStoreError(
          "delivery_state_conflict",
          `Run-audit outbox ${input.id} is not claimed by ${input.claimToken}`,
        );
      }
      return rowToRunAuditOutboxRecord(updated);
    });
  }

  async markRunAuditEventFailed(input: {
    readonly id: string;
    readonly claimToken: string;
    readonly now: string;
    readonly errorCode: string;
    readonly nextAttemptAt: string | null;
    readonly exhausted: boolean;
  }): Promise<RoomRunAuditOutboxRecordV1> {
    if (!input.errorCode.trim()) {
      throw new RoomStoreError(
        "delivery_state_conflict",
        `Run-audit outbox ${input.id} failure requires an error code`,
      );
    }
    if (!input.exhausted && !input.nextAttemptAt) {
      throw new RoomStoreError(
        "delivery_state_conflict",
        `Run-audit outbox ${input.id} retry requires nextAttemptAt`,
      );
    }
    if (input.exhausted && input.nextAttemptAt !== null) {
      throw new RoomStoreError(
        "delivery_state_conflict",
        `Exhausted run-audit outbox ${input.id} cannot schedule a retry`,
      );
    }
    return this.layer.transactionImmediate(async (tx) => {
      const updated = await tx
        .update(runAuditOutbox)
        .set({
          state: input.exhausted ? "exhausted" : "pending",
          claimToken: null,
          claimExpiresAt: null,
          nextAttemptAt: input.nextAttemptAt,
          lastErrorCode: input.errorCode.trim(),
          updatedAt: input.now,
        })
        .where(and(
          eq(runAuditOutbox.projectId, this.projectId),
          eq(runAuditOutbox.id, input.id),
          eq(runAuditOutbox.state, "dispatching"),
          eq(runAuditOutbox.claimToken, input.claimToken),
        ))
        .returning()
        .then((rows) => rows[0] as RoomRunAuditOutboxRow | undefined);
      if (!updated) {
        throw new RoomStoreError(
          "delivery_state_conflict",
          `Run-audit outbox ${input.id} is not claimed by ${input.claimToken}`,
        );
      }
      return rowToRunAuditOutboxRecord(updated);
    });
  }

  async listRunAuditOutbox(): Promise<readonly RoomRunAuditOutboxRecordV1[]> {
    const rows = await this.layer.db
      .select()
      .from(runAuditOutbox)
      .where(eq(runAuditOutbox.projectId, this.projectId))
      .orderBy(asc(runAuditOutbox.dispatchSequence));
    return (rows as RoomRunAuditOutboxRow[]).map((row) => rowToRunAuditOutboxRecord(row));
  }

  /**
   * Re-read the durable human-control posture immediately before a worker claim
   * or renewal. Discovery is intentionally broader than this guard so a stale
   * running projection can never steal-run a newer pause, approval hold, or
   * terminal outcome after restart.
   */
  async getRecoveryPosture(roomId: string): Promise<RoomRecoveryPostureV1> {
    return this.readRecoveryPosture(this.layer.db, roomId);
  }

  async assertWorkerAuthority(
    input: AssertRoomWorkerAuthorityInput,
  ): Promise<RoomWorkerAuthorityV1> {
    return this.layer.transaction(async (tx) => {
      const lease = await assertRoomLeaseFence(tx, this.projectId, {
        leaseId: input.lease.id,
        roomId: input.roomId,
        kind: "room_worker",
        resourceId: input.roomId,
        holderId: input.lease.holderId,
        hostId: input.lease.hostId,
        expectedEpoch: input.lease.epoch,
        now: input.now,
      });
      const posture = await this.readRecoveryPosture(tx, input.roomId);
      const reason = recoveryWithheldReason(posture)
        ?? (posture.aggregateVersion === input.expectedAggregateVersion
          ? null
          : "posture_version_changed");
      if (reason) throw new RoomWorkerAuthorityError(posture, reason);
      return { lease, posture };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }

  private async readRecoveryPosture(
    handle: QueryHandle,
    roomId: string,
  ): Promise<RoomRecoveryPostureV1> {
    const [room] = await handle
      .select({
        lifecycleState: operationalRooms.lifecycleState,
        aggregateVersion: operationalRooms.aggregateVersion,
      })
      .from(operationalRooms)
      .where(and(
        eq(operationalRooms.projectId, this.projectId),
        eq(operationalRooms.id, roomId),
      ))
      .limit(1);
    if (!room) {
      throw new RoomDomainError("room_state_conflict", `Operational Room ${roomId} does not exist`);
    }

    const [lastLifecycleEvent, roomApproval, waitingNode] = await Promise.all([
      handle
        .select({ actorType: roomEvents.actorType, payload: roomEvents.payload })
        .from(roomEvents)
        .where(and(
          eq(roomEvents.projectId, this.projectId),
          eq(roomEvents.roomId, roomId),
          eq(roomEvents.eventType, "room_lifecycle_transitioned"),
        ))
        .orderBy(desc(roomEvents.cursor))
        .limit(1)
        .then((rows) => rows[0]),
      handle
        .select({ status: approvalRequests.status })
        .from(approvalRequests)
        .where(and(
          eq(approvalRequests.targetResourceId, roomId),
          inArray(approvalRequests.targetResourceType, ["room", "operational_room"]),
        ))
        /*
        FNXC:SessionRoomApproval 2026-07-17-00:58:
        Restart recovery must classify approval from the newest REQUEST, not the
        row with the newest update. Older denied requests can receive later
        bookkeeping updates after a newer request is already approved/completed,
        and those stale writes must never re-block the Room.
        */
        .orderBy(
          desc(approvalRequests.requestedAt),
          desc(approvalRequests.createdAt),
          desc(approvalRequests.id),
        )
        .limit(1)
        .then((rows) => rows[0]),
      handle
        .select({ id: roomTaskNodes.id })
        .from(roomTaskNodes)
        .where(and(
          eq(roomTaskNodes.projectId, this.projectId),
          eq(roomTaskNodes.roomId, roomId),
          eq(roomTaskNodes.state, "waiting_approval"),
        ))
        .limit(1)
        .then((rows) => rows[0]),
    ]);
    const payload = lastLifecycleEvent?.payload;
    const transitionedToPaused = Boolean(
      payload
      && typeof payload === "object"
      && !Array.isArray(payload)
      && (payload as Record<string, unknown>).to === "paused",
    );
    const approvalState = roomApproval?.status === "pending" || waitingNode
      ? "waiting"
      : roomApproval?.status === "denied" && room.lifecycleState === "blocked"
        ? "blocked"
        : "none";
    return {
      lifecycleState: room.lifecycleState as RoomLifecycleState,
      aggregateVersion: room.aggregateVersion,
      humanPaused: room.lifecycleState === "paused"
        && lastLifecycleEvent?.actorType === "human"
        && transitionedToPaused,
      approvalState,
    };
  }

  async requestMembershipChange(
    input: RequestRoomMembershipChangeInput,
    context: RoomCommandContext,
  ): Promise<RoomAggregateV1> {
    validateMembershipChangeRequest(input);
    const commandHash = hashRoomValue({
      roomId: input.roomId,
      changeId: input.changeId,
      expectedAggregateVersion: input.expectedAggregateVersion,
      expectedMembershipVersion: input.expectedMembershipVersion,
      activateAt: input.activateAt,
      mutation: input.mutation,
      reason: input.reason,
      requestedAt: input.requestedAt,
    });
    const committed = await this.layer.transactionImmediate(async (tx) => {
      const current = await loadRoomAggregateProjection(tx, this.projectId, input.roomId);
      if (!current) {
        throw new RoomDomainError("room_state_conflict", `Operational Room ${input.roomId} does not exist`);
      }

      const reservation = await tx
        .insert(roomIdempotencyKeys)
        .values({
          id: `room-idempotency-${randomUUID()}`,
          projectId: this.projectId,
          roomId: input.roomId,
          idempotencyKey: input.idempotencyKey,
          commandType: "request_membership_change",
          commandHash,
          resultEventId: null,
          createdAt: input.requestedAt,
          expiresAt: null,
        })
        .onConflictDoNothing()
        .returning({ id: roomIdempotencyKeys.id });
      if (reservation.length === 0) {
        const existingRows = await tx
          .select()
          .from(roomIdempotencyKeys)
          .where(and(
            eq(roomIdempotencyKeys.projectId, this.projectId),
            eq(roomIdempotencyKeys.roomId, input.roomId),
            eq(roomIdempotencyKeys.idempotencyKey, input.idempotencyKey),
          ))
          .limit(1);
        const existing = existingRows[0];
        if (
          !existing
          || existing.commandType !== "request_membership_change"
          || existing.commandHash !== commandHash
        ) {
          throw new RoomStoreError(
            "idempotency_conflict",
            `Idempotency key ${input.idempotencyKey} was already used for a different Room command`,
          );
        }
        if (!existing.resultEventId) {
          throw new RoomStoreError(
            "idempotency_result_missing",
            `Idempotency key ${input.idempotencyKey} has no committed membership result`,
          );
        }
        const aggregate = await loadMembershipResult(
          tx,
          this.projectId,
          existing.resultEventId,
          "membership_change_requested",
        );
        return { aggregate, event: null };
      }

      assertMembershipVersions(current, input);
      if (current.room.state !== "running" && current.room.state !== "paused") {
        throw new RoomDomainError(
          "room_state_conflict",
          `Membership changes require a running or paused Room, found ${current.room.state}`,
        );
      }
      if (!current.activeTurnId) {
        throw new RoomDomainError(
          "turn_boundary_required",
          `Room ${input.roomId} has no active turn whose boundary can activate the membership change`,
        );
      }
      const pending = await preparePendingMembershipChange(
        tx,
        current,
        input,
      );
      const next: RoomAggregateV1 = {
        ...current,
        room: {
          ...current.room,
          aggregateVersion: current.room.aggregateVersion + 1,
          updatedAt: input.requestedAt,
        },
        pendingMembershipChanges: [...current.pendingMembershipChanges, pending],
      };
      const updated = await tx
        .update(operationalRooms)
        .set({
          aggregateVersion: next.room.aggregateVersion,
          updatedAt: next.room.updatedAt,
        })
        .where(and(
          eq(operationalRooms.projectId, this.projectId),
          eq(operationalRooms.id, input.roomId),
          eq(operationalRooms.aggregateVersion, input.expectedAggregateVersion),
          eq(operationalRooms.membershipVersion, input.expectedMembershipVersion),
        ))
        .returning({ id: operationalRooms.id });
      if (updated.length !== 1) {
        throw new RoomDomainError(
          "aggregate_version_conflict",
          `Concurrent membership request rejected for Room ${input.roomId}`,
        );
      }
      await tx.insert(roomMembershipChanges).values({
        id: input.changeId,
        projectId: this.projectId,
        roomId: input.roomId,
        seatId: pending.seatId,
        kind: pending.kind,
        payload: membershipChangePayload(pending),
        reason: input.reason,
        requestedAt: input.requestedAt,
        requestedBy: context.actorId,
        effectiveAfterTurnId: current.activeTurnId,
        reservedConnectorId: pending.kind === "add"
          ? pending.binding?.connectorId ?? null
          : pending.kind === "replace"
            ? pending.replacement?.connectorId ?? null
            : null,
        reservedProviderId: pending.kind === "add"
          ? pending.binding?.providerId ?? null
          : pending.kind === "replace"
            ? pending.replacement?.providerId ?? null
            : null,
        reservedNativeSessionId: pending.kind === "add"
          ? pending.binding?.nativeSessionId ?? null
          : pending.kind === "replace"
            ? pending.replacement?.nativeSessionId ?? null
            : null,
        reservedHappierSessionId: pending.kind === "add"
          ? pending.binding?.happierSessionId ?? null
          : pending.kind === "replace"
            ? pending.replacement?.happierSessionId ?? null
            : null,
        appliedAt: null,
        failedAt: null,
        failureCode: null,
        state: "waiting_turn_boundary",
      });
      const event = await insertRoomEvent(tx, next, "membership_change_requested", context, {
        projectionVersion: 1,
        changeId: input.changeId,
        changeKind: pending.kind,
        effectiveAfterTurnId: current.activeTurnId,
        projection: next,
        projectionHash: hashRoomValue(next),
        updatedAt: next.room.updatedAt,
      });
      await tx
        .update(roomIdempotencyKeys)
        .set({ resultEventId: event.id })
        .where(eq(roomIdempotencyKeys.id, reservation[0]!.id));
      return { aggregate: next, event };
    });
    if (committed.event) this.publishCommittedEvent(committed.event);
    return committed.aggregate;
  }

  async applyMembershipChangesAtTurnBoundary(
    input: ApplyRoomMembershipChangesAtTurnBoundaryInput,
    context: RoomCommandContext,
  ): Promise<RoomAggregateV1> {
    validateMembershipBoundaryInput(input);
    const idempotencyKey = input.idempotencyKey?.trim()
      || `membership-boundary:${input.turnId}`;
    const commandHash = hashRoomValue({
      roomId: input.roomId,
      turnId: input.turnId,
      expectedAggregateVersion: input.expectedAggregateVersion,
      expectedMembershipVersion: input.expectedMembershipVersion,
      now: input.now,
    });
    const committed = await this.layer.transactionImmediate(async (tx) => {
      const reservation = await tx
        .insert(roomIdempotencyKeys)
        .values({
          id: `room-idempotency-${randomUUID()}`,
          projectId: this.projectId,
          roomId: input.roomId,
          idempotencyKey,
          commandType: "apply_membership_changes_at_turn_boundary",
          commandHash,
          resultEventId: null,
          createdAt: input.now,
          expiresAt: null,
        })
        .onConflictDoNothing()
        .returning({ id: roomIdempotencyKeys.id });
      if (reservation.length === 0) {
        const existingRows = await tx
          .select()
          .from(roomIdempotencyKeys)
          .where(and(
            eq(roomIdempotencyKeys.projectId, this.projectId),
            eq(roomIdempotencyKeys.roomId, input.roomId),
            eq(roomIdempotencyKeys.idempotencyKey, idempotencyKey),
          ))
          .limit(1);
        const existing = existingRows[0];
        if (
          !existing
          || existing.commandType !== "apply_membership_changes_at_turn_boundary"
          || existing.commandHash !== commandHash
        ) {
          throw new RoomStoreError(
            "idempotency_conflict",
            `Idempotency key ${idempotencyKey} was already used for a different Room command`,
          );
        }
        if (!existing.resultEventId) {
          throw new RoomStoreError(
            "idempotency_result_missing",
            `Idempotency key ${idempotencyKey} has no committed membership boundary result`,
          );
        }
        const aggregate = await loadMembershipResult(
          tx,
          this.projectId,
          existing.resultEventId,
          "membership_change_activated",
        );
        return { aggregate, event: null };
      }

      const current = await loadRoomAggregateProjection(tx, this.projectId, input.roomId);
      if (!current) {
        throw new RoomDomainError("room_state_conflict", `Operational Room ${input.roomId} does not exist`);
      }
      assertMembershipVersions(current, input);
      const boundaryTurn = current.turns.find((turn) => turn.id === input.turnId);
      const laterTurnStarted = boundaryTurn
        ? current.turns.some((turn) => (
            turn.sequence > boundaryTurn.sequence
            && turn.startedAt !== null
          ))
        : false;
      if (
        !boundaryTurn
        || current.activeTurnId !== null
        || current.activeTurnId === input.turnId
        || laterTurnStarted
        || !["completed", "cancelled", "uncertain"].includes(boundaryTurn.state)
      ) {
        throw new RoomDomainError(
          "turn_boundary_required",
          `Turn ${input.turnId} has not reached a safe membership boundary`,
        );
      }
      const rows = await tx
        .select()
        .from(roomMembershipChanges)
        .where(and(
          eq(roomMembershipChanges.projectId, this.projectId),
          eq(roomMembershipChanges.roomId, input.roomId),
          eq(roomMembershipChanges.effectiveAfterTurnId, input.turnId),
          eq(roomMembershipChanges.state, "waiting_turn_boundary"),
        ))
        .orderBy(asc(roomMembershipChanges.requestedAt), asc(roomMembershipChanges.id));
      if (rows.length === 0) {
        throw new RoomDomainError(
          "membership_change_conflict",
          `No pending membership changes target turn ${input.turnId}`,
        );
      }

      const membershipRequestEvents = await tx
        .select({ payload: roomEvents.payload })
        .from(roomEvents)
        .where(and(
          eq(roomEvents.projectId, this.projectId),
          eq(roomEvents.roomId, input.roomId),
          eq(roomEvents.eventType, "membership_change_requested"),
        ));
      const eventBackedChangeIds = new Set(
        membershipRequestEvents
          .map((event) => asRecord(event.payload).changeId)
          .filter((changeId): changeId is string => (
            typeof changeId === "string" && changeId.trim().length > 0
          )),
      );

      let projected = current;
      const failedIds = new Set<string>();
      const appliedIds = new Set<string>();
      const quarantinedChangeIds: string[] = [];
      const outcomes: Array<
        | { readonly changeId: string; readonly status: "applied" }
        | {
            readonly changeId: string;
            readonly status: "failed";
            readonly failureCode: "seat_not_found" | "binding_not_found";
          }
      > = [];
      for (const row of rows) {
        if (!eventBackedChangeIds.has(row.id)) {
          failedIds.add(row.id);
          quarantinedChangeIds.push(row.id);
          await tx
            .update(roomMembershipChanges)
            .set({
              state: "failed",
              failedAt: input.now,
              failureCode: "missing_request_event",
            })
            .where(and(
              eq(roomMembershipChanges.projectId, this.projectId),
              eq(roomMembershipChanges.roomId, input.roomId),
              eq(roomMembershipChanges.id, row.id),
              eq(roomMembershipChanges.state, "waiting_turn_boundary"),
            ));
          continue;
        }
        const change = rowToPendingMembershipChange(row);
        const before = projected;
        try {
          projected = applyPendingMembershipChange(before, change, input.now);
          await persistAppliedMembershipChange(tx, this.projectId, before, projected, change, input.now);
          appliedIds.add(row.id);
          outcomes.push({ changeId: row.id, status: "applied" });
        } catch (error) {
          if (
            !(error instanceof RoomDomainError)
            || (error.code !== "seat_not_found" && error.code !== "binding_not_found")
          ) throw error;
          failedIds.add(row.id);
          outcomes.push({ changeId: row.id, status: "failed", failureCode: error.code });
          await tx
            .update(roomMembershipChanges)
            .set({ state: "failed", failedAt: input.now, failureCode: error.code })
            .where(and(
              eq(roomMembershipChanges.projectId, this.projectId),
              eq(roomMembershipChanges.roomId, input.roomId),
              eq(roomMembershipChanges.id, row.id),
              eq(roomMembershipChanges.state, "waiting_turn_boundary"),
            ));
        }
      }
      const next: RoomAggregateV1 = {
        ...projected,
        room: {
          ...projected.room,
          aggregateVersion: current.room.aggregateVersion + 1,
          updatedAt: input.now,
        },
        membershipVersion: current.membershipVersion + (appliedIds.size > 0 ? 1 : 0),
        pendingMembershipChanges: current.pendingMembershipChanges.filter(
          (change) => !appliedIds.has(change.id) && !failedIds.has(change.id),
        ),
      };
      const updated = await tx
        .update(operationalRooms)
        .set({
          aggregateVersion: next.room.aggregateVersion,
          membershipVersion: next.membershipVersion,
          updatedAt: next.room.updatedAt,
        })
        .where(and(
          eq(operationalRooms.projectId, this.projectId),
          eq(operationalRooms.id, input.roomId),
          eq(operationalRooms.aggregateVersion, input.expectedAggregateVersion),
          eq(operationalRooms.membershipVersion, input.expectedMembershipVersion),
        ))
        .returning({ id: operationalRooms.id });
      if (updated.length !== 1) {
        throw new RoomDomainError(
          "aggregate_version_conflict",
          `Concurrent membership activation rejected for Room ${input.roomId}`,
        );
      }
      if (appliedIds.size > 0) {
        await tx
          .update(roomMembershipChanges)
          .set({ state: "applied", appliedAt: input.now })
          .where(and(
            eq(roomMembershipChanges.projectId, this.projectId),
            eq(roomMembershipChanges.roomId, input.roomId),
            inArray(roomMembershipChanges.id, [...appliedIds]),
            eq(roomMembershipChanges.state, "waiting_turn_boundary"),
          ));
      }
      const event = await insertRoomEvent(tx, next, "membership_change_activated", context, {
        projectionVersion: 2,
        turnId: input.turnId,
        outcomes,
        quarantinedChangeIds,
        membershipVersion: next.membershipVersion,
        projection: next,
        projectionHash: hashRoomValue(next),
        updatedAt: next.room.updatedAt,
      });
      await tx
        .update(roomIdempotencyKeys)
        .set({ resultEventId: event.id })
        .where(eq(roomIdempotencyKeys.id, reservation[0]!.id));
      return { aggregate: next, event };
    });
    if (committed.event) this.publishCommittedEvent(committed.event);
    return committed.aggregate;
  }

  async getDelivery(outboxId: string): Promise<RoomOutboxRecordV1 | null> {
    const rows = await this.layer.db
      .select()
      .from(roomOutbox)
      .where(and(eq(roomOutbox.projectId, this.projectId), eq(roomOutbox.id, outboxId)))
      .limit(1);
    return rows[0] ? rowToOutboxRecord(rows[0]) : null;
  }

  async getBinding(bindingId: string): Promise<RoomBindingRecordV1 | null> {
    const rows = await this.layer.db
      .select()
      .from(roomBindings)
      .where(and(eq(roomBindings.projectId, this.projectId), eq(roomBindings.id, bindingId)))
      .limit(1);
    return rows[0] ? rowToBindingRecord(rows[0]) : null;
  }

  async listEvents(
    roomId: string,
    afterCursor?: string,
    options?: ListRoomEventsOptionsV1,
  ): Promise<RoomEventRecordV1[]> {
    return loadRoomEvents(this.layer.db, this.projectId, roomId, afterCursor, options);
  }

  async getRoutedMessage(messageId: string): Promise<StoredRoutedOperatorMessageV1 | null> {
    const rows = await this.layer.db
      .select()
      .from(roomMessages)
      .where(and(eq(roomMessages.projectId, this.projectId), eq(roomMessages.id, messageId)))
      .limit(1);
    const row = rows[0];
    if (
      !row
      || row.idempotencyKey === null
      || row.expectedAggregateVersion === null
    ) return null;
    const targets = await loadDurableMessageTargets(
      this.layer.db,
      this.projectId,
      row.roomId,
      messageId,
    );
    return rowToStoredRoutedOperatorMessage(row, targets);
  }

  async listMessageTargets(messageId: string): Promise<readonly DurableRoomMessageTargetV1[]> {
    const rows = await this.layer.db
      .select({ roomId: roomMessages.roomId })
      .from(roomMessages)
      .where(and(eq(roomMessages.projectId, this.projectId), eq(roomMessages.id, messageId)))
      .limit(1);
    const row = rows[0];
    if (!row) return [];
    return loadDurableMessageTargets(
      this.layer.db,
      this.projectId,
      row.roomId,
      messageId,
    );
  }

  /**
   * Resolve an operator selector and freeze its seat/binding lineage in the
   * same transaction as the message, outbox intents, aggregate CAS, event, and
   * idempotency result. This method persists connector work only; it never
   * performs a provider send.
   *
   * FNXC:SessionRoomMessageRouting 2026-07-18-11:31:
   * Task 4.4 requires exact project/Room/action/content-hash validation, authority-scoped target resolution, durable selector provenance, one outbox intent per seat, replay before optimistic-version rejection, and post-commit-only listener notification. Any validation, target, CAS, or persistence failure rolls back the complete command.
   */
  async routeOperatorMessage(
    envelope: RoomControllerCommandEnvelopeV1,
  ): Promise<RouteOperatorMessageResultV1> {
    assertRouteOperatorMessageEnvelope(envelope, this.projectId);
    // Retry identity is the immutable routing command, not the transport time
    // at which a caller reconstructed the envelope after acknowledgement loss.
    // The first committed issuedAt remains authoritative in the stored result.
    const commandHash = hashRoomValue({
      contractVersion: envelope.contractVersion,
      apiVersion: envelope.apiVersion,
      commandId: envelope.commandId,
      correlationId: envelope.correlationId,
      projectId: envelope.projectId,
      roomId: envelope.roomId,
      expectedAggregateVersion: envelope.expectedAggregateVersion,
      authority: envelope.authority,
      command: envelope.command,
    });

    const committed = await this.layer.transactionImmediate(async (tx) => {
      const reservationId = `room-idempotency-${randomUUID()}`;
      const reservation = await tx
        .insert(roomIdempotencyKeys)
        .values({
          id: reservationId,
          projectId: this.projectId,
          roomId: envelope.roomId,
          idempotencyKey: envelope.idempotencyKey,
          commandType: "route_message",
          commandHash,
          resultEventId: null,
          createdAt: envelope.issuedAt,
          expiresAt: null,
        })
        .onConflictDoNothing()
        .returning({ id: roomIdempotencyKeys.id });

      // Replay is intentionally resolved before loading or checking the latest
      // aggregate version. A committed retry remains valid after later Room
      // commands advance the aggregate.
      if (reservation.length === 0) {
        const existingRows = await tx
          .select()
          .from(roomIdempotencyKeys)
          .where(and(
            eq(roomIdempotencyKeys.projectId, this.projectId),
            eq(roomIdempotencyKeys.roomId, envelope.roomId),
            eq(roomIdempotencyKeys.idempotencyKey, envelope.idempotencyKey),
          ))
          .limit(1);
        const existing = existingRows[0];
        if (
          !existing
          || existing.commandType !== "route_message"
          || existing.commandHash !== commandHash
        ) {
          throw new RoomStoreError(
            "idempotency_conflict",
            `Idempotency key ${envelope.idempotencyKey} was already used for a different Room command`,
          );
        }
        if (!existing.resultEventId) {
          throw new RoomStoreError(
            "idempotency_result_missing",
            `Idempotency key ${envelope.idempotencyKey} has no committed routed-message event`,
          );
        }
        const replay = await loadRouteOperatorMessageResult(
          tx,
          this.projectId,
          existing.resultEventId,
        );
        return { result: { ...replay, replayed: true }, eventToPublish: null };
      }

      const current = await loadRoomAggregateProjection(tx, this.projectId, envelope.roomId);
      if (!current) {
        throw new RoomDomainError(
          "room_state_conflict",
          `Operational Room ${envelope.roomId} does not exist`,
        );
      }
      if ([
        "completed",
        "completed_with_risks",
        "partial",
        "cancelled",
        "failed",
        "archived",
      ].includes(current.room.state)) {
        throw new RoomDomainError(
          "terminal_state_immutable",
          `Operational Room ${envelope.roomId} cannot accept a new routed message in ${current.room.state}`,
        );
      }
      if (
        envelope.command.target.kind !== "controller"
        && !["draft", "ready", "running"].includes(current.room.state)
      ) {
        throw new RoomDomainError(
          "room_state_conflict",
          `Operational Room ${envelope.roomId} cannot route provider work while ${current.room.state}`,
        );
      }
      if (current.room.aggregateVersion !== envelope.expectedAggregateVersion) {
        throw new RoomDomainError(
          "aggregate_version_conflict",
          `Room ${envelope.roomId} expected aggregate version ${envelope.expectedAggregateVersion} but is ${current.room.aggregateVersion}`,
          {
            expected: envelope.expectedAggregateVersion,
            actual: current.room.aggregateVersion,
          },
        );
      }
      if (isEarlierTimestamp(envelope.issuedAt, current.room.updatedAt)) {
        throw new RoomStoreError(
          "routing_command_invalid",
          `Routed operator message timestamp cannot precede Room ${envelope.roomId} updatedAt`,
        );
      }

      const resolvedSeats = resolveOperatorMessageTargets(current, envelope.command.target);
      assertAuthoritySeatScope(envelope.authority, resolvedSeats.map((target) => target.seatId));

      const next: RoomAggregateV1 = {
        ...current,
        room: {
          ...current.room,
          aggregateVersion: current.room.aggregateVersion + 1,
          updatedAt: envelope.issuedAt,
        },
      };
      const updated = await tx
        .update(operationalRooms)
        .set({
          aggregateVersion: next.room.aggregateVersion,
          updatedAt: next.room.updatedAt,
        })
        .where(and(
          eq(operationalRooms.id, envelope.roomId),
          eq(operationalRooms.projectId, this.projectId),
          eq(operationalRooms.aggregateVersion, envelope.expectedAggregateVersion),
        ))
        .returning({ id: operationalRooms.id });
      if (updated.length !== 1) {
        throw new RoomDomainError(
          "aggregate_version_conflict",
          `Concurrent routed-message update rejected for Room ${envelope.roomId}`,
          { expected: envelope.expectedAggregateVersion },
        );
      }

      const messageId = `room-message-${randomUUID()}`;
      await tx.insert(roomMessages).values({
        id: messageId,
        projectId: this.projectId,
        roomId: envelope.roomId,
        turnId: current.activeTurnId,
        nodeId: envelope.command.nodeId,
        originType: "operator",
        originId: envelope.authority.actorId,
        intent: envelope.command.intent,
        target: envelope.command.target,
        targetSeatIds: resolvedSeats.map((target) => target.seatId),
        authority: envelope.authority,
        content: envelope.command.content,
        contentHash: envelope.command.contentHash,
        evidenceRefs: envelope.authority.evidenceRefs,
        idempotencyKey: envelope.idempotencyKey,
        expectedAggregateVersion: envelope.expectedAggregateVersion,
        createdAt: envelope.issuedAt,
      });

      const selectorRef = envelope.command.target.kind === "group"
        ? envelope.command.target.groupId
        : null;
      const targetValues = envelope.command.target.kind === "controller"
        ? [{
            id: `room-message-target-${randomUUID()}`,
            projectId: this.projectId,
            roomId: envelope.roomId,
            messageId,
            selectorKind: "controller" as const,
            selectorRef: null,
            targetKind: "controller" as const,
            seatId: null,
            bindingId: null,
            ordinal: 0,
            createdAt: envelope.issuedAt,
          }]
        : resolvedSeats.map((target, ordinal) => ({
            id: `room-message-target-${randomUUID()}`,
            projectId: this.projectId,
            roomId: envelope.roomId,
            messageId,
            selectorKind: envelope.command.target.kind,
            selectorRef,
            targetKind: "seat" as const,
            seatId: target.seatId,
            bindingId: target.bindingId,
            ordinal,
            createdAt: envelope.issuedAt,
          }));
      await tx.insert(roomMessageTargets).values(targetValues);

      const outboxValues = resolvedSeats.map((target) => {
        const idempotencyKey = `${envelope.idempotencyKey}:${target.bindingId}`;
        return {
          id: `room-outbox-${randomUUID()}`,
          projectId: this.projectId,
          roomId: envelope.roomId,
          messageId,
          bindingId: target.bindingId,
          logicalMessageId: messageId,
          localMessageId: buildRoomConnectorLocalMessageId({
            logicalMessageId: messageId,
            bindingId: target.bindingId,
            idempotencyKey,
            payloadHash: envelope.command.contentHash,
          }),
          idempotencyKey,
          payloadHash: envelope.command.contentHash,
          deliveryState: "pending",
          nativeAcknowledgement: null,
          nativeCursor: null,
          reconciliationFromCursor: null,
          reconciliationEvidenceRef: null,
          attemptCount: 0,
          lastErrorCode: null,
          nextAttemptAt: null,
          createdAt: envelope.issuedAt,
          updatedAt: envelope.issuedAt,
        };
      });
      if (outboxValues.length > 0) await tx.insert(roomOutbox).values(outboxValues);

      const event = await insertRoomEvent(
        tx,
        next,
        "message_routed",
        {
          eventId: `room-event-${randomUUID()}`,
          actorType: envelope.authority.actorType,
          actorId: envelope.authority.actorId,
          correlationId: envelope.correlationId,
          causationId: envelope.commandId,
          occurredAt: envelope.issuedAt,
        },
        {
          projectionVersion: 1,
          messageId,
          targetIds: targetValues.map((target) => target.id),
          outboxIds: outboxValues.map((delivery) => delivery.id),
          target: envelope.command.target,
          updatedAt: next.room.updatedAt,
        },
      );
      const linked = await tx
        .update(roomIdempotencyKeys)
        .set({ resultEventId: event.id })
        .where(and(
          eq(roomIdempotencyKeys.id, reservationId),
          eq(roomIdempotencyKeys.projectId, this.projectId),
        ))
        .returning({ id: roomIdempotencyKeys.id });
      if (linked.length !== 1) {
        throw new RoomStoreError(
          "idempotency_result_missing",
          `Failed to bind idempotency key ${envelope.idempotencyKey} to event ${event.id}`,
        );
      }
      const result = await loadRouteOperatorMessageResult(tx, this.projectId, event.id);
      return { result: { ...result, replayed: false }, eventToPublish: event };
    });

    if (committed.eventToPublish) this.publishCommittedEvent(committed.eventToPublish);
    return committed.result;
  }

  /**
   * Persist one logical message, every native delivery intent, and the causal
   * Room event atomically. A replay with the same key returns the first result;
   * reusing the key for different content is a hard conflict.
   *
   * FNXC:SessionRoomExactlyOnceIntent 2026-07-17-04:12:
   * The database owns idempotency. Process-local locks cannot protect a Room
   * after a crash or across several Fusion nodes, so the reservation, message,
   * outbox rows, aggregate version, and event are committed together.
   */
  async enqueueMessage(
    input: EnqueueRoomMessageInput,
    context: RoomCommandContext,
  ): Promise<EnqueueRoomMessageResult> {
    const contentHash = hashRoomValue(input.message.content);
    const commandHash = hashRoomValue({
      roomId: input.roomId,
      message: {
        id: input.message.id,
        turnId: input.message.turnId,
        nodeId: input.message.nodeId,
        originType: input.message.originType,
        originId: input.message.originId,
        targetSeatIds: [...input.message.targetSeatIds].sort(compareRoomText),
        intent: input.message.intent,
        contentHash,
        authorityEnvelope: input.message.authorityEnvelope,
        createdAt: input.message.createdAt,
      },
      deliveries: [...input.deliveries]
        .map((delivery) => ({ id: delivery.id, bindingId: delivery.bindingId }))
        .sort((left, right) => compareRoomText(left.id, right.id) || compareRoomText(left.bindingId, right.bindingId)),
    });

    const committed = await this.layer.transactionImmediate(async (tx) => {
      const current = await loadRoomAggregateProjection(tx, this.projectId, input.roomId);
      if (!current) {
        throw new RoomDomainError(
          "room_state_conflict",
          `Operational Room ${input.roomId} does not exist`,
        );
      }

      const reservationId = `room-idempotency-${randomUUID()}`;
      const reservation = await tx
        .insert(roomIdempotencyKeys)
        .values({
          id: reservationId,
          projectId: this.projectId,
          roomId: input.roomId,
          idempotencyKey: input.idempotencyKey,
          commandType: "enqueue_message",
          commandHash,
          resultEventId: null,
          createdAt: input.message.createdAt,
          expiresAt: null,
        })
        .onConflictDoNothing()
        .returning({ id: roomIdempotencyKeys.id });

      if (reservation.length === 0) {
        const existingRows = await tx
          .select()
          .from(roomIdempotencyKeys)
          .where(
            and(
              eq(roomIdempotencyKeys.projectId, this.projectId),
              eq(roomIdempotencyKeys.roomId, input.roomId),
              eq(roomIdempotencyKeys.idempotencyKey, input.idempotencyKey),
            ),
          )
          .limit(1);
        const existing = existingRows[0];
        if (!existing || existing.commandHash !== commandHash) {
          throw new RoomStoreError(
            "idempotency_conflict",
            `Idempotency key ${input.idempotencyKey} was already used for a different Room command`,
          );
        }
        if (!existing.resultEventId) {
          throw new RoomStoreError(
            "idempotency_result_missing",
            `Idempotency key ${input.idempotencyKey} has no committed result event`,
          );
        }
        const replay = await loadEnqueueMessageResult(tx, this.projectId, existing.resultEventId);
        return { result: { ...replay, replayed: true }, eventToPublish: null };
      }

      if (current.room.aggregateVersion !== input.expectedAggregateVersion) {
        throw new RoomDomainError(
          "aggregate_version_conflict",
          `Room ${input.roomId} expected aggregate version ${input.expectedAggregateVersion} but is ${current.room.aggregateVersion}`,
          {
            expected: input.expectedAggregateVersion,
            actual: current.room.aggregateVersion,
          },
        );
      }
      validateMessageDeliveries(current, input);

      const next: RoomAggregateV1 = {
        ...current,
        room: {
          ...current.room,
          aggregateVersion: current.room.aggregateVersion + 1,
          updatedAt: input.message.createdAt,
        },
      };
      const updated = await tx
        .update(operationalRooms)
        .set({
          aggregateVersion: next.room.aggregateVersion,
          updatedAt: next.room.updatedAt,
        })
        .where(
          and(
            eq(operationalRooms.id, input.roomId),
            eq(operationalRooms.projectId, this.projectId),
            eq(operationalRooms.aggregateVersion, input.expectedAggregateVersion),
          ),
        )
        .returning({ id: operationalRooms.id });
      if (updated.length !== 1) {
        throw new RoomDomainError(
          "aggregate_version_conflict",
          `Concurrent Room message update rejected for ${input.roomId}`,
          { expected: input.expectedAggregateVersion },
        );
      }

      await tx.insert(roomMessages).values({
        id: input.message.id,
        projectId: this.projectId,
        roomId: input.roomId,
        turnId: input.message.turnId,
        nodeId: input.message.nodeId,
        originType: input.message.originType,
        originId: input.message.originId,
        intent: input.message.intent,
        target: { kind: "seats", seatIds: input.message.targetSeatIds },
        authority: input.message.authorityEnvelope,
        content: input.message.content,
        contentHash,
        evidenceRefs: [],
        createdAt: input.message.createdAt,
      });

      const outboxValues = input.deliveries.map((delivery) => {
        const idempotencyKey = `${input.idempotencyKey}:${delivery.bindingId}`;
        return {
          id: delivery.id,
          projectId: this.projectId,
          roomId: input.roomId,
          messageId: input.message.id,
          bindingId: delivery.bindingId,
          logicalMessageId: input.message.id,
          localMessageId: buildRoomConnectorLocalMessageId({
            logicalMessageId: input.message.id,
            bindingId: delivery.bindingId,
            idempotencyKey,
            payloadHash: contentHash,
          }),
          idempotencyKey,
          payloadHash: contentHash,
          deliveryState: "pending",
          nativeAcknowledgement: null,
          nativeCursor: null,
          reconciliationFromCursor: null,
          reconciliationEvidenceRef: null,
          attemptCount: 0,
          lastErrorCode: null,
          nextAttemptAt: null,
          createdAt: input.message.createdAt,
          updatedAt: input.message.createdAt,
        };
      });
      await tx.insert(roomOutbox).values(outboxValues);

      const event = await insertRoomEvent(tx, next, "room_message_queued", context, {
        projectionVersion: 1,
        messageId: input.message.id,
        outboxIds: input.deliveries.map((delivery) => delivery.id),
        updatedAt: next.room.updatedAt,
      });
      const linked = await tx
        .update(roomIdempotencyKeys)
        .set({ resultEventId: event.id })
        .where(
          and(
            eq(roomIdempotencyKeys.id, reservationId),
            eq(roomIdempotencyKeys.projectId, this.projectId),
          ),
        )
        .returning({ id: roomIdempotencyKeys.id });
      if (linked.length !== 1) {
        throw new RoomStoreError(
          "idempotency_result_missing",
          `Failed to bind idempotency key ${input.idempotencyKey} to event ${event.id}`,
        );
      }
      const result = await loadEnqueueMessageResult(tx, this.projectId, event.id);
      return { result: { ...result, replayed: false }, eventToPublish: event };
    });

    if (committed.eventToPublish) this.publishCommittedEvent(committed.eventToPublish);
    return committed.result;
  }

  async beginDeliveryAttempt(
    input: BeginRoomDeliveryAttemptInput,
  ): Promise<RoomOutboxRecordV1> {
    if (input.reconciliationFromCursor !== null && !input.reconciliationFromCursor.trim()) {
      throw new RoomStoreError(
        "delivery_state_conflict",
        `Room outbox ${input.outboxId} reconciliation cursor cannot be blank`,
      );
    }
    return this.layer.transactionImmediate(async (tx) => {
      const rows = await tx
        .select()
        .from(roomOutbox)
        .where(and(eq(roomOutbox.projectId, this.projectId), eq(roomOutbox.id, input.outboxId)))
        .limit(1)
        .for("update");
      const current = rows[0];
      if (!current) {
        throw new RoomStoreError(
          "delivery_state_conflict",
          `Room outbox ${input.outboxId} does not exist in project ${this.projectId}`,
        );
      }
      if (current.deliveryState === "delivery_uncertain") {
        throw new RoomStoreError(
          "delivery_state_conflict",
          `Room outbox ${input.outboxId} is delivery uncertain; reconcile the native Session before any retry`,
        );
      }
      if (current.deliveryState !== "pending") {
        throw new RoomStoreError(
          "delivery_state_conflict",
          `Room outbox ${input.outboxId} cannot dispatch from state ${current.deliveryState}`,
        );
      }

      let senderLease: StoredRoomLeaseV1 | null = null;
      if (input.senderFence) {
        await lockRoomConnectorIngestion(tx, this.projectId, current.bindingId);
        await lockRoomLeaseResourceWithinTransaction(
          tx,
          this.projectId,
          "sender",
          input.senderFence.resourceId,
        );
        senderLease = await assertRoomLeaseFence(tx, this.projectId, {
          ...input.senderFence,
          now: input.now,
        });
        if (
          senderLease.kind !== "sender"
          || senderLease.roomId !== current.roomId
          || senderLease.resourceId !== current.bindingId
        ) {
          throw new RoomLeaseFenceError(
            `Sender lease ${senderLease.id} does not authorize outbox ${input.outboxId}`,
            senderLease,
          );
        }
      } else {
        const leaseHistory = await tx
          .select({ id: roomLeases.id })
          .from(roomLeases)
          .where(and(
            eq(roomLeases.projectId, this.projectId),
            eq(roomLeases.kind, "sender"),
            eq(roomLeases.resourceId, current.bindingId),
          ))
          .orderBy(desc(roomLeases.epoch))
          .limit(1);
        if (leaseHistory.length > 0) {
          throw new RoomLeaseFenceError(
            `Sender-managed outbox ${input.outboxId} requires the exact active sender lease fence`,
            null,
          );
        }
      }

      if (senderLease) {
        const ingestion = await loadRoomConnectorIngestionState(
          tx,
          this.projectId,
          current.roomId,
          current.bindingId,
        );
        let takeover = ingestion.senderTakeover;
        if (
          takeover !== null
          && (
            takeover.state === "reconciling"
            || (takeover.state === "automatic_resumed"
              && senderLease.epoch > takeover.autoSenderLeaseEpoch)
          )
          && !ingestion.nativeWriterDetected
          && takeover.confirmedCursor !== null
          && takeover.confirmedCursor === ingestion.transcriptCursor
          && input.reconciliationFromCursor === takeover.confirmedCursor
        ) {
          takeover = {
            ...takeover,
            state: "automatic_resumed",
            automaticSender: "active",
            autoSenderLeaseEpoch: senderLease.epoch,
          };
          const resumedState: RoomConnectorIngestionStateV1 = {
            ...ingestion,
            mode: ingestion.mode === "stopped" ? "stopped" : "streaming",
            senderTakeover: takeover,
            lastModeAt: ingestion.mode === "stopped"
              ? ingestion.lastModeAt
              : latestTimestamp(ingestion.lastModeAt, input.now),
            updatedAt: latestTimestamp(ingestion.updatedAt, input.now),
          };
          await persistRoomConnectorIngestionState(
            tx,
            this.projectId,
            resumedState,
            resumedState.updatedAt!,
          );
        }
        const senderMatchesTakeover = takeover === null
          || (takeover.state === "human_active"
            && senderLease.epoch === takeover.autoSenderLeaseEpoch + 1)
          || (takeover.state === "automatic_resumed"
            && senderLease.epoch === takeover.autoSenderLeaseEpoch);
        if (
          takeover !== null
          && !senderMatchesTakeover
        ) {
          throw new RoomStoreError(
            "sender_takeover_conflict",
            `Sender takeover ${takeover.takeoverId} pauses provider writes for binding ${current.bindingId}`,
          );
        }
        if (
          senderLease.epoch > 1
          && input.reconciliationFromCursor !== ingestion.transcriptCursor
        ) {
          throw new RoomStoreError(
            "resume_cursor_conflict",
            `Sender epoch ${senderLease.epoch} for outbox ${input.outboxId} must resume from confirmed cursor ${String(ingestion.transcriptCursor)}`,
          );
        }
      }
      const unresolvedSibling = await tx
        .select({ id: roomOutbox.id })
        .from(roomOutbox)
        .where(and(
          eq(roomOutbox.projectId, this.projectId),
          eq(roomOutbox.roomId, current.roomId),
          eq(roomOutbox.bindingId, current.bindingId),
          inArray(roomOutbox.deliveryState, ["dispatching", "delivery_uncertain"]),
          sql`${roomOutbox.id} <> ${current.id}`,
        ))
        .limit(1);
      if (unresolvedSibling[0]) {
        throw new RoomStoreError(
          "delivery_state_conflict",
          `Room outbox ${input.outboxId} cannot dispatch while ${unresolvedSibling[0].id} is unresolved for binding ${current.bindingId}`,
        );
      }
      if (
        current.nextAttemptAt
        && Date.parse(current.nextAttemptAt) > Date.parse(input.now)
      ) {
        /*
        FNXC:SessionRoomDelivery 2026-07-17-02:43:
        Retry scheduling is a durable fence, not a hint. Recovery may only
        re-dispatch once the stored nextAttemptAt window has opened; otherwise a
        restart could blind-resend earlier than the committed backoff contract.
        */
        throw new RoomStoreError(
          "delivery_state_conflict",
          `Room outbox ${input.outboxId} is not due until ${current.nextAttemptAt}`,
        );
      }

      const attempt = current.attemptCount + 1;
      const updated = await tx
        .update(roomOutbox)
        .set({
          deliveryState: "dispatching",
          attemptCount: attempt,
          nativeAcknowledgement: null,
          nativeCursor: null,
          reconciliationFromCursor: input.reconciliationFromCursor,
          reconciliationEvidenceRef: null,
          lastErrorCode: null,
          nextAttemptAt: null,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(roomOutbox.projectId, this.projectId),
            eq(roomOutbox.id, input.outboxId),
            eq(roomOutbox.deliveryState, "pending"),
            eq(roomOutbox.attemptCount, current.attemptCount),
          ),
        )
        .returning();
      const updatedRow = updated[0];
      if (!updatedRow) {
        throw new RoomStoreError(
          "delivery_state_conflict",
          `Concurrent dispatcher already claimed Room outbox ${input.outboxId}`,
        );
      }

      try {
        await tx.insert(roomOutboxAttempts).values({
          id: input.attemptId,
          projectId: this.projectId,
          roomId: current.roomId,
          outboxId: input.outboxId,
          attempt,
          startedAt: input.now,
          endedAt: null,
          outcome: "started",
          errorCode: null,
          evidenceRef: null,
        });
      } catch (error) {
        throw new RoomStoreError(
          "delivery_attempt_conflict",
          `Delivery attempt ${input.attemptId} already exists or conflicts: ${errorMessage(error)}`,
        );
      }
      return rowToOutboxRecord(updatedRow);
    });
  }

  async reconcileDelivery(
    input: ReconcileRoomDeliveryInput,
  ): Promise<RoomOutboxRecordV1> {
    if (!ROOM_HISTORY_EVIDENCE_REF_PATTERN.test(input.evidenceRef)) {
      throw new RoomStoreError(
        "delivery_state_conflict",
        `Delivery reconciliation for ${input.outboxId} requires a canonical hashed history evidence reference`,
      );
    }
    if (!Number.isSafeInteger(input.expectedAttemptCount) || input.expectedAttemptCount < 1) {
      throw new RoomStoreError(
        "delivery_attempt_conflict",
        `Delivery reconciliation for ${input.outboxId} requires a positive expected attempt count`,
      );
    }
    assertSafeRoomAuditCode(input.errorCode, `Delivery reconciliation for ${input.outboxId}`);
    if (!input.audit.runId.trim() || !input.audit.agentId.trim()) {
      throw new RoomStoreError(
        "delivery_state_conflict",
        `Delivery reconciliation for ${input.outboxId} requires run and agent audit identity`,
      );
    }
    if (
      input.outcome === "confirmed"
      && !input.connectorAcknowledgementId
      && !input.nativeMessageId
      && !input.nativeCursor
    ) {
      throw new RoomStoreError(
        "delivery_state_conflict",
        `Confirmed reconciliation for ${input.outboxId} requires connector or native acknowledgement evidence`,
      );
    }
    if (input.outcome === "confirmed" && input.errorCode !== null) {
      throw new RoomStoreError(
        "delivery_state_conflict",
        `Confirmed reconciliation for ${input.outboxId} cannot retain an error code`,
      );
    }
    if (input.outcome === "delivery_uncertain" && !input.errorCode?.trim()) {
      throw new RoomStoreError(
        "delivery_state_conflict",
        `Uncertain reconciliation for ${input.outboxId} requires an error code`,
      );
    }

    return this.layer.transactionImmediate(async (tx) => {
      const rows = await tx
        .select()
        .from(roomOutbox)
        .where(and(eq(roomOutbox.projectId, this.projectId), eq(roomOutbox.id, input.outboxId)))
        .limit(1)
        .for("update");
      const current = rows[0];
      if (!current) {
        throw new RoomStoreError(
          "delivery_state_conflict",
          `Room outbox ${input.outboxId} does not exist in project ${this.projectId}`,
        );
      }
      if (current.attemptCount !== input.expectedAttemptCount) {
        throw new RoomStoreError(
          "delivery_attempt_conflict",
          `Room outbox ${input.outboxId} is on attempt ${current.attemptCount}, not expected attempt ${input.expectedAttemptCount}`,
        );
      }

      const currentRecord = rowToOutboxRecord(current);
      if (current.deliveryState === "confirmed") {
        if (
          input.outcome === "confirmed"
          && currentRecord.connectorAcknowledgementId === input.connectorAcknowledgementId
          && currentRecord.nativeMessageId === input.nativeMessageId
          && currentRecord.nativeCursor === input.nativeCursor
          && currentRecord.reconciliationEvidenceRef === input.evidenceRef
        ) {
          await refreshBlockedSenderTakeoverAfterDeliveryResolution(
            tx,
            this.projectId,
            current.roomId,
            current.bindingId,
            input.now,
          );
          return currentRecord;
        }
        throw new RoomStoreError(
          "delivery_state_conflict",
          `Room outbox ${input.outboxId} is already confirmed with different evidence`,
        );
      }
      if (current.deliveryState !== "dispatching" && current.deliveryState !== "delivery_uncertain") {
        throw new RoomStoreError(
          "delivery_state_conflict",
          `Room outbox ${input.outboxId} cannot reconcile from state ${current.deliveryState}`,
        );
      }
      if (
        current.deliveryState === "delivery_uncertain"
        && input.outcome === "delivery_uncertain"
        && current.reconciliationEvidenceRef === input.evidenceRef
        && current.lastErrorCode === input.errorCode
      ) {
        return currentRecord;
      }

      const nextAcknowledgement = input.outcome === "confirmed"
        ? {
            connectorAcknowledgementId: input.connectorAcknowledgementId,
            nativeMessageId: input.nativeMessageId,
          }
        : current.nativeAcknowledgement;
      const updated = await tx
        .update(roomOutbox)
        .set({
          deliveryState: input.outcome,
          nativeAcknowledgement: nextAcknowledgement,
          nativeCursor: input.outcome === "confirmed" ? input.nativeCursor : current.nativeCursor,
          reconciliationEvidenceRef: input.evidenceRef,
          lastErrorCode: input.errorCode,
          nextAttemptAt: null,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(roomOutbox.projectId, this.projectId),
            eq(roomOutbox.id, input.outboxId),
            eq(roomOutbox.deliveryState, current.deliveryState),
            eq(roomOutbox.attemptCount, current.attemptCount),
          ),
        )
        .returning();
      const updatedRow = updated[0];
      if (!updatedRow) {
        throw new RoomStoreError(
          "delivery_state_conflict",
          `Concurrent reconciliation changed Room outbox ${input.outboxId}`,
        );
      }

      if (current.deliveryState === "dispatching") {
        const completedAttempts = await tx
          .update(roomOutboxAttempts)
          .set({
            endedAt: input.now,
            outcome: input.outcome,
            errorCode: input.errorCode,
            evidenceRef: input.evidenceRef,
          })
          .where(
            and(
              eq(roomOutboxAttempts.projectId, this.projectId),
              eq(roomOutboxAttempts.outboxId, input.outboxId),
              eq(roomOutboxAttempts.attempt, current.attemptCount),
              isNull(roomOutboxAttempts.endedAt),
            ),
          )
          .returning({ id: roomOutboxAttempts.id });
        if (completedAttempts.length !== 1) {
          throw new RoomStoreError(
            "delivery_attempt_conflict",
            `Room outbox ${input.outboxId} has no single active attempt to reconcile`,
          );
        }
      }

      await recordRunAuditEventWithinTransaction(tx, {
        projectId: this.projectId,
        timestamp: input.now,
        taskId: input.audit.taskId,
        agentId: input.audit.agentId,
        runId: input.audit.runId,
        domain: "database",
        mutationType: "room:connector-delivery-reconciliation",
        target: input.outboxId,
        metadata: {
          roomId: current.roomId,
          bindingId: current.bindingId,
          messageId: current.messageId,
          logicalMessageId: current.logicalMessageId,
          localMessageId: current.localMessageId,
          payloadHash: current.payloadHash,
          attempt: current.attemptCount,
          fromState: current.deliveryState,
          outcome: input.outcome,
          connectorAcknowledgementId: input.connectorAcknowledgementId,
          nativeMessageId: input.nativeMessageId,
          nativeCursor: input.nativeCursor,
          reconciliationFromCursor: current.reconciliationFromCursor,
          evidenceRef: input.evidenceRef,
          errorCode: input.errorCode,
        },
      });
      if (input.outcome === "confirmed") {
        await refreshBlockedSenderTakeoverAfterDeliveryResolution(
          tx,
          this.projectId,
          current.roomId,
          current.bindingId,
          input.now,
        );
      }
      return rowToOutboxRecord(updatedRow);
    });
  }

  async completeDeliveryAttempt(
    input: CompleteRoomDeliveryAttemptInput,
  ): Promise<RoomOutboxRecordV1> {
    assertSafeRoomAuditCode(input.errorCode, `Delivery completion for ${input.outboxId}`);
    return this.layer.transactionImmediate(async (tx) => {
      const rows = await tx
        .select()
        .from(roomOutbox)
        .where(and(eq(roomOutbox.projectId, this.projectId), eq(roomOutbox.id, input.outboxId)))
        .limit(1);
      const current = rows[0];
      if (!current || current.deliveryState !== "dispatching") {
        throw new RoomStoreError(
          "delivery_state_conflict",
          `Room outbox ${input.outboxId} is not dispatching`,
        );
      }
      const attemptRows = await tx
        .select()
        .from(roomOutboxAttempts)
        .where(
          and(
            eq(roomOutboxAttempts.projectId, this.projectId),
            eq(roomOutboxAttempts.outboxId, input.outboxId),
            eq(roomOutboxAttempts.id, input.attemptId),
          ),
        )
        .limit(1);
      const attempt = attemptRows[0];
      if (!attempt || attempt.attempt !== current.attemptCount || attempt.endedAt !== null) {
        throw new RoomStoreError(
          "delivery_attempt_conflict",
          `Delivery attempt ${input.attemptId} is not the active attempt for ${input.outboxId}`,
        );
      }
      if (input.outcome === "retryable_failure" && !input.nextAttemptAt) {
        throw new RoomStoreError(
          "delivery_state_conflict",
          `Retryable delivery failure for ${input.outboxId} requires nextAttemptAt`,
        );
      }
      if (input.outcome !== "retryable_failure" && input.nextAttemptAt !== null) {
        throw new RoomStoreError(
          "delivery_state_conflict",
          `Delivery outcome ${input.outcome} cannot schedule a retry`,
        );
      }
      if (!input.audit.runId.trim() || !input.audit.agentId.trim()) {
        throw new RoomStoreError(
          "delivery_state_conflict",
          `Delivery completion for ${input.outboxId} requires run and agent audit identity`,
        );
      }
      if (
        input.outcome === "confirmed"
        && !input.connectorAcknowledgementId
        && !input.nativeMessageId
        && !input.nativeCursor
      ) {
        throw new RoomStoreError(
          "delivery_state_conflict",
          `Confirmed delivery for ${input.outboxId} requires connector or native acknowledgement evidence`,
        );
      }

      const hasAcceptedEvidence = Boolean(
        input.connectorAcknowledgementId || input.nativeMessageId || input.nativeCursor,
      );
      const nextState = deliveryStateForOutcome(input.outcome, hasAcceptedEvidence);
      const nativeAcknowledgement = input.connectorAcknowledgementId || input.nativeMessageId
        ? {
            connectorAcknowledgementId: input.connectorAcknowledgementId,
            nativeMessageId: input.nativeMessageId,
          }
        : null;
      const updated = await tx
        .update(roomOutbox)
        .set({
            deliveryState: nextState,
            nativeAcknowledgement,
            nativeCursor: input.nativeCursor,
            lastErrorCode: input.errorCode,
            /*
            FNXC:SessionRoomDelivery 2026-07-17-02:43:
            A retryable transport failure that already carries connector/native
            acknowledgement evidence becomes delivery_uncertain immediately. The
            system must surface the ambiguity and wait for reconciliation instead
            of parking it back in pending where crash recovery could resend.
            */
            nextAttemptAt: nextState === "pending" ? input.nextAttemptAt : null,
            updatedAt: input.now,
          })
        .where(
          and(
            eq(roomOutbox.projectId, this.projectId),
            eq(roomOutbox.id, input.outboxId),
            eq(roomOutbox.deliveryState, "dispatching"),
            eq(roomOutbox.attemptCount, current.attemptCount),
          ),
        )
        .returning();
      const updatedRow = updated[0];
      if (!updatedRow) {
        throw new RoomStoreError(
          "delivery_state_conflict",
          `Concurrent completion changed Room outbox ${input.outboxId}`,
        );
      }
      const completedAttempt = await tx
        .update(roomOutboxAttempts)
        .set({
          endedAt: input.now,
          outcome: input.outcome,
          errorCode: input.errorCode,
        })
        .where(
          and(
            eq(roomOutboxAttempts.projectId, this.projectId),
            eq(roomOutboxAttempts.outboxId, input.outboxId),
            eq(roomOutboxAttempts.id, input.attemptId),
          ),
        )
        .returning({ id: roomOutboxAttempts.id });
      if (completedAttempt.length !== 1) {
        throw new RoomStoreError(
          "delivery_attempt_conflict",
          `Failed to complete delivery attempt ${input.attemptId}`,
        );
      }
      // FNXC:RoomConnectorAuditPrivacy 2026-07-17-05:31:
      // Run audit carries only durable identities, hashes, outcome, and cursor.
      // Message plaintext, authority envelopes, connector settings, and official
      // credential material are intentionally unavailable to this payload.
      await recordRunAuditEventWithinTransaction(tx, {
        projectId: this.projectId,
        timestamp: input.now,
        taskId: input.audit.taskId,
        agentId: input.audit.agentId,
        runId: input.audit.runId,
        domain: "database",
        mutationType: "room:connector-delivery",
        target: input.outboxId,
        metadata: {
          roomId: current.roomId,
          bindingId: current.bindingId,
          messageId: current.messageId,
          logicalMessageId: current.logicalMessageId,
          localMessageId: current.localMessageId,
          payloadHash: current.payloadHash,
          attempt: current.attemptCount,
          outcome: input.outcome,
          connectorAcknowledgementId: input.connectorAcknowledgementId,
          nativeMessageId: input.nativeMessageId,
          nativeCursor: input.nativeCursor,
          errorCode: input.errorCode,
        },
      });
      if (nextState === "confirmed" || nextState === "rejected") {
        await refreshBlockedSenderTakeoverAfterDeliveryResolution(
          tx,
          this.projectId,
          current.roomId,
          current.bindingId,
          input.now,
        );
      }
      return rowToOutboxRecord(updatedRow);
    });
  }

  async getConnectorIngestionState(
    input: GetRoomConnectorIngestionStateInput,
  ): Promise<RoomConnectorIngestionStateV1> {
    await requireRoomBinding(this.layer.db, this.projectId, input.roomId, input.bindingId);
    return loadRoomConnectorIngestionState(
      this.layer.db,
      this.projectId,
      input.roomId,
      input.bindingId,
    );
  }

  /**
   * Commit one contiguous connector transcript batch and its durable cursor.
   * A cursor discontinuity or truncation records repair evidence but commits no
   * messages and advances no cursor, so a crash can only replay known input.
   *
   * FNXC:RoomConnectorEventIngestion 2026-07-17-07:02:
   * Connector event delivery is at-least-once. The database therefore owns the
   * per-binding cursor, native-id/hash fallback dedupe, and gap state in one
   * advisory-locked transaction rather than trusting a process-local offset.
   */
  async recordConnectorTranscriptBatch(
    input: RecordRoomConnectorTranscriptBatchInput,
  ): Promise<RoomConnectorTranscriptBatchResultV1> {
    validateConnectorTranscriptBatchInput(input);

    return this.layer.transactionImmediate(async (tx) => {
      await lockRoomConnectorIngestion(tx, this.projectId, input.bindingId);
      await requireRoomBinding(tx, this.projectId, input.roomId, input.bindingId);
      const current = await loadRoomConnectorIngestionState(
        tx,
        this.projectId,
        input.roomId,
        input.bindingId,
      );
      const unresolvedGap = current.gapDetectedAt !== null
        || current.gapExpectedCursor !== null
        || current.gapObservedCursor !== null;
      if (
        !input.truncated
        && current.transcriptCursor === input.nextCursor
        && input.items.length > 0
        && !unresolvedGap
      ) {
        const replay = await classifyCompleteConnectorBatchReplay(tx, this.projectId, input);
        if (replay) {
          return {
            state: current,
            insertedCount: 0,
            duplicateCount: input.items.length,
            duplicateNativeMessageIdCount: replay.duplicateNativeMessageIdCount,
            duplicatePayloadHashCount: replay.duplicatePayloadHashCount,
            gapDetected: false,
          };
        }
        if (current.transcriptCursor === input.fromCursor) {
          throw new RoomStoreError(
            "connector_batch_invalid",
            "A connector transcript batch cannot insert new messages without advancing its cursor",
          );
        }
      }
      if (unresolvedGap && input.source === "event") {
        const mode = current.mode === "stopped"
          ? "stopped"
          : current.mode === "degraded"
            ? "degraded"
            : "reconciling";
        const updatedAt = latestTimestamp(current.updatedAt, input.receivedAt);
        const state: RoomConnectorIngestionStateV1 = {
          ...current,
          mode,
          lastModeAt: mode === current.mode
            ? current.lastModeAt
            : latestTimestamp(current.lastModeAt, input.receivedAt),
          updatedAt,
        };
        if (state !== current) {
          await persistRoomConnectorIngestionState(tx, this.projectId, state, updatedAt);
        }
        return {
          state,
          insertedCount: 0,
          duplicateCount: 0,
          duplicateNativeMessageIdCount: 0,
          duplicatePayloadHashCount: 0,
          gapDetected: true,
        };
      }
      const gapDetected = current.transcriptCursor !== input.fromCursor;
      if (gapDetected) {
        const updatedAt = latestTimestamp(current.updatedAt, input.receivedAt);
        const modeChanges = current.mode !== "stopped";
        const state: RoomConnectorIngestionStateV1 = {
          ...current,
          mode: current.mode === "stopped"
            ? "stopped"
            : input.modeAfterCommit === "degraded"
              ? "degraded"
              : "reconciling",
          gapExpectedCursor: current.transcriptCursor,
          gapObservedCursor: input.fromCursor,
          gapDetectedAt: input.receivedAt,
          lastModeAt: modeChanges
            ? latestTimestamp(current.lastModeAt, input.receivedAt)
            : current.lastModeAt,
          updatedAt,
        };
        await persistRoomConnectorIngestionState(tx, this.projectId, state, updatedAt);
        return {
          state,
          insertedCount: 0,
          duplicateCount: 0,
          duplicateNativeMessageIdCount: 0,
          duplicatePayloadHashCount: 0,
          gapDetected: true,
        };
      }

      let insertedCount = 0;
      let duplicateCount = 0;
      let duplicateNativeMessageIdCount = 0;
      let duplicatePayloadHashCount = 0;
      for (const item of input.items) {
        const receipt = connectorTranscriptItemToReceipt(input, item);
        const result = await insertRoomInboxReceipt(tx, this.projectId, receipt);
        if (result.inserted) insertedCount += 1;
        else {
          duplicateCount += 1;
          if (item.nativeMessageId) duplicateNativeMessageIdCount += 1;
          else duplicatePayloadHashCount += 1;
        }
      }

      const lastItem = input.items.length > 0 ? input.items[input.items.length - 1] : undefined;
      const updatedAt = latestTimestamp(current.updatedAt, input.receivedAt);
      const currentTakeover = current.senderTakeover;
      const takeoverCanReconcile = currentTakeover?.state === "reconciling"
        || currentTakeover?.state === "blocked_delivery_uncertain"
        || currentTakeover?.state === "releasing";
      const completeHistoryCanConfirm = currentTakeover?.state === "releasing"
        || (currentTakeover?.state === "reconciling" && !current.nativeWriterDetected)
        || input.items.some((item) => item.role === "user");
      const takeoverReconciled = takeoverCanReconcile
        && input.source === "history"
        && input.nextCursor !== null
        && !input.truncated
        && completeHistoryCanConfirm;
      let reconciledAutomaticSenderLeaseEpoch: number | null = null;
      if (
        takeoverReconciled
        && currentTakeover?.state === "reconciling"
        && !current.nativeWriterDetected
      ) {
        await lockRoomLeaseResourceWithinTransaction(
          tx,
          this.projectId,
          "sender",
          input.bindingId,
        );
        const activeSenderRows = await tx
          .select({ epoch: roomLeases.epoch, expiresAt: roomLeases.expiresAt })
          .from(roomLeases)
          .where(and(
            eq(roomLeases.projectId, this.projectId),
            eq(roomLeases.roomId, input.roomId),
            eq(roomLeases.kind, "sender"),
            eq(roomLeases.resourceId, input.bindingId),
            isNull(roomLeases.releasedAt),
          ))
          .orderBy(desc(roomLeases.epoch))
          .limit(1)
          .for("update");
        const activeSender = activeSenderRows[0];
        if (
          activeSender
          && Date.parse(activeSender.expiresAt) > Date.parse(input.receivedAt)
        ) {
          reconciledAutomaticSenderLeaseEpoch = Number(activeSender.epoch);
        }
      }
      const reconciledTakeoverState = currentTakeover?.state === "blocked_delivery_uncertain"
        ? "blocked_delivery_uncertain" as const
        : currentTakeover?.state === "releasing"
          ? "releasing" as const
          : currentTakeover?.state === "reconciling"
              && !current.nativeWriterDetected
              && reconciledAutomaticSenderLeaseEpoch !== null
            ? "automatic_resumed" as const
            : currentTakeover?.state === "reconciling" && !current.nativeWriterDetected
              ? "reconciling" as const
              : "ready_for_transfer" as const;
      const reconciledTakeover = takeoverReconciled && currentTakeover
        ? {
            ...currentTakeover,
            state: reconciledTakeoverState,
            automaticSender: reconciledTakeoverState === "automatic_resumed"
              ? "active" as const
              : "paused" as const,
            autoSenderLeaseEpoch: reconciledAutomaticSenderLeaseEpoch
              ?? currentTakeover.autoSenderLeaseEpoch,
            confirmedCursor: input.nextCursor,
          }
        : currentTakeover;
      const state: RoomConnectorIngestionStateV1 = {
        ...current,
        mode: current.mode === "stopped"
          ? "stopped"
          : reconciledTakeover?.state === "automatic_resumed"
            ? "streaming"
            : input.modeAfterCommit,
        transcriptCursor: input.nextCursor,
        lastNativeMessageId: lastItem?.nativeMessageId ?? current.lastNativeMessageId,
        lastPayloadHash: lastItem?.payloadHash ?? current.lastPayloadHash,
        gapExpectedCursor: null,
        gapObservedCursor: null,
        gapDetectedAt: null,
        senderTakeover: reconciledTakeover,
        lastTranscriptAt: latestTimestamp(current.lastTranscriptAt, input.receivedAt),
        lastModeAt: current.mode === "stopped"
          ? current.lastModeAt
          : latestTimestamp(current.lastModeAt, input.receivedAt),
        updatedAt,
      };
      await persistRoomConnectorIngestionState(tx, this.projectId, state, updatedAt);
      return {
        state,
        insertedCount,
        duplicateCount,
        duplicateNativeMessageIdCount,
        duplicatePayloadHashCount,
        gapDetected: false,
      };
    });
  }

  async recordConnectorStatus(
    input: RecordRoomConnectorStatusInput,
  ): Promise<RoomConnectorIngestionStateV1> {
    assertCanonicalIsoTimestamp(input.occurredAt, "Connector status occurredAt");
    let committedEvent: RoomEventRecordV1 | null = null;
    const committedState = await this.layer.transactionImmediate(async (tx) => {
      await lockRoomConnectorIngestion(tx, this.projectId, input.bindingId);
      await requireRoomBinding(tx, this.projectId, input.roomId, input.bindingId);
      const current = await loadRoomConnectorIngestionState(
        tx,
        this.projectId,
        input.roomId,
        input.bindingId,
      );
      if (isEarlierTimestamp(input.occurredAt, current.lastStatusAt)) return current;
      if (current.lastStatusAt === input.occurredAt) {
        if (
          current.statusCursor !== input.statusCursor
          || current.connectorStatus !== input.state
          || current.nativeWriterDetected !== input.nativeWriterDetected
        ) {
          throw new RoomStoreError(
            "delivery_state_conflict",
            `Connector status timestamp ${input.occurredAt} was replayed with different state`,
          );
        }
        return current;
      }
      if (input.statusCursor !== null && current.statusCursor === input.statusCursor) {
        if (
          current.connectorStatus !== input.state
          || current.nativeWriterDetected !== input.nativeWriterDetected
        ) {
          throw new RoomStoreError(
            "delivery_state_conflict",
            `Connector status cursor ${input.statusCursor} was replayed with different state`,
          );
        }
        return current;
      }
      const updatedAt = latestTimestamp(current.updatedAt, input.occurredAt);
      let senderTakeover = current.senderTakeover;
      let blockedOutboxIds: readonly string[] = [];
      if (
        !input.nativeWriterDetected
        && senderTakeover?.state === "human_active"
      ) {
        senderTakeover = {
          ...senderTakeover,
          state: "releasing",
          reconcileFromCursor: current.transcriptCursor,
          confirmedCursor: null,
        };
      } else if (
        !input.nativeWriterDetected
        && senderTakeover !== null
        && (
          senderTakeover.state === "reconciling"
          || senderTakeover.state === "ready_for_transfer"
          || senderTakeover.state === "blocked_delivery_uncertain"
        )
      ) {
        senderTakeover = {
          ...senderTakeover,
          state: senderTakeover.state === "blocked_delivery_uncertain"
            ? "blocked_delivery_uncertain"
            : "reconciling",
          reconcileFromCursor: current.transcriptCursor,
          confirmedCursor: null,
        };
      } else if (
        input.nativeWriterDetected
        && senderTakeover?.state === "releasing"
      ) {
        senderTakeover = {
          ...senderTakeover,
          state: "human_active",
          reconcileFromCursor: current.transcriptCursor,
          confirmedCursor: current.transcriptCursor,
        };
      }
      if (
        input.nativeWriterDetected
        && (senderTakeover === null || senderTakeover.state === "automatic_resumed")
      ) {
        await lockRoomLeaseResourceWithinTransaction(
          tx,
          this.projectId,
          "sender",
          input.bindingId,
        );
        const activeSenderRows = await tx
          .select({ epoch: roomLeases.epoch, expiresAt: roomLeases.expiresAt })
          .from(roomLeases)
          .where(and(
            eq(roomLeases.projectId, this.projectId),
            eq(roomLeases.roomId, input.roomId),
            eq(roomLeases.kind, "sender"),
            eq(roomLeases.resourceId, input.bindingId),
            isNull(roomLeases.releasedAt),
          ))
          .orderBy(desc(roomLeases.epoch))
          .limit(1)
          .for("update");
        const activeSender = activeSenderRows[0];
        if (
          !activeSender
          || Date.parse(activeSender.expiresAt) <= Date.parse(input.occurredAt)
        ) {
          throw new RoomStoreError(
            "delivery_state_conflict",
            `Native writer detection for binding ${input.bindingId} requires an active automatic sender lease`,
          );
        }
        blockedOutboxIds = (await tx
          .select({ id: roomOutbox.id })
          .from(roomOutbox)
          .where(and(
            eq(roomOutbox.projectId, this.projectId),
            eq(roomOutbox.roomId, input.roomId),
            eq(roomOutbox.bindingId, input.bindingId),
            inArray(roomOutbox.deliveryState, ["dispatching", "delivery_uncertain"]),
          ))
          .orderBy(asc(roomOutbox.id)))
          .map((row) => row.id);
        senderTakeover = {
          takeoverId: `native-writer:${input.statusCursor ?? input.occurredAt}`,
          takeoverEpoch: (senderTakeover?.takeoverEpoch ?? 0) + 1,
          state: blockedOutboxIds.length > 0
            ? "blocked_delivery_uncertain"
            : "reconciling",
          automaticSender: "paused",
          autoSenderLeaseEpoch: Number(activeSender.epoch),
          reconcileFromCursor: current.transcriptCursor,
          confirmedCursor: null,
          blockedOutboxIds,
        };
      }
      const state: RoomConnectorIngestionStateV1 = {
        ...current,
        mode: senderTakeover !== null
          && senderTakeover.state !== "automatic_resumed"
          && current.mode !== "stopped"
          ? "reconciling"
          : current.mode,
        statusCursor: input.statusCursor,
        connectorStatus: input.state,
        nativeWriterDetected: input.nativeWriterDetected,
        senderTakeover,
        lastStatusAt: input.occurredAt,
        lastModeAt: senderTakeover !== null
          && senderTakeover.state !== "automatic_resumed"
          && current.mode !== "stopped"
          ? latestTimestamp(current.lastModeAt, input.occurredAt)
          : current.lastModeAt,
        updatedAt,
      };
      await persistRoomConnectorIngestionState(tx, this.projectId, state, updatedAt);

      if (blockedOutboxIds.length > 0 && senderTakeover !== null) {
        const lockedRoomRows = await tx
          .select({
            aggregateVersion: operationalRooms.aggregateVersion,
            updatedAt: operationalRooms.updatedAt,
          })
          .from(operationalRooms)
          .where(and(
            eq(operationalRooms.projectId, this.projectId),
            eq(operationalRooms.id, input.roomId),
          ))
          .limit(1)
          .for("update");
        const lockedRoom = lockedRoomRows[0];
        if (!lockedRoom) {
          throw new RoomStoreError(
            "delivery_state_conflict",
            `Operational Room ${input.roomId} disappeared during native writer takeover`,
          );
        }
        const nextAggregateVersion = Number(lockedRoom.aggregateVersion) + 1;
        const roomUpdatedAt = latestTimestamp(lockedRoom.updatedAt, input.occurredAt);
        const advanced = await tx
          .update(operationalRooms)
          .set({ aggregateVersion: nextAggregateVersion, updatedAt: roomUpdatedAt })
          .where(and(
            eq(operationalRooms.projectId, this.projectId),
            eq(operationalRooms.id, input.roomId),
            eq(operationalRooms.aggregateVersion, lockedRoom.aggregateVersion),
          ))
          .returning({ id: operationalRooms.id });
        if (!advanced[0]) {
          throw new RoomStoreError(
            "delivery_state_conflict",
            `Operational Room ${input.roomId} changed during native writer takeover`,
          );
        }
        const aggregate = await loadRoomAggregateProjection(tx, this.projectId, input.roomId);
        if (!aggregate) {
          throw new RoomStoreError(
            "delivery_state_conflict",
            `Operational Room ${input.roomId} could not be reloaded during native writer takeover`,
          );
        }
        committedEvent = await insertRoomEvent(
          tx,
          aggregate,
          "sender_takeover_blocked_delivery_uncertain",
          {
            eventId: `room-event-sender-takeover-blocked:${input.bindingId}:${senderTakeover.takeoverEpoch}`,
            actorType: "system",
            actorId: "room-connector-ingestion",
            correlationId: senderTakeover.takeoverId,
            causationId: null,
            occurredAt: input.occurredAt,
          },
          {
            projectionVersion: 1,
            bindingId: input.bindingId,
            takeoverId: senderTakeover.takeoverId,
            takeoverEpoch: senderTakeover.takeoverEpoch,
            outboxIds: blockedOutboxIds,
            updatedAt: roomUpdatedAt,
          },
        );
      }
      return state;
    });
    if (committedEvent) this.publishCommittedEvent(committedEvent);
    return committedState;
  }

  async transferNativeIdeSenderLease(
    input: TransferNativeIdeSenderLeaseInput,
  ): Promise<TransferNativeIdeSenderLeaseResult> {
    assertCanonicalIsoTimestamp(input.now, "Native IDE sender transfer now");
    assertCanonicalIsoTimestamp(input.expiresAt, "Native IDE sender transfer expiresAt");
    if (Date.parse(input.expiresAt) <= Date.parse(input.now)) {
      throw new RoomStoreError(
        "delivery_state_conflict",
        "Native IDE sender transfer expiry must be after its transfer time",
      );
    }
    if (
      !input.takeoverId.trim()
      || !input.humanHolderId.trim()
      || !Number.isSafeInteger(input.expectedTakeoverEpoch)
      || input.expectedTakeoverEpoch < 1
    ) {
      throw new RoomStoreError(
        "delivery_state_conflict",
        "Native IDE sender transfer requires a valid takeover identity, epoch, and human holder",
      );
    }
    if (
      input.fromSenderFence.kind !== "sender"
      || input.fromSenderFence.roomId !== input.roomId
      || input.fromSenderFence.resourceId !== input.bindingId
      || input.fromSenderFence.hostId !== input.hostId
    ) {
      throw new RoomLeaseFenceError(
        `Sender transfer fence does not authorize binding ${input.bindingId}`,
        null,
      );
    }

    return this.layer.transactionImmediate(async (tx) => {
      await lockRoomConnectorIngestion(tx, this.projectId, input.bindingId);
      await requireRoomBinding(tx, this.projectId, input.roomId, input.bindingId);
      const current = await loadRoomConnectorIngestionState(
        tx,
        this.projectId,
        input.roomId,
        input.bindingId,
      );
      const takeover = current.senderTakeover;
      if (
        takeover === null
        || takeover.takeoverId !== input.takeoverId
        || takeover.takeoverEpoch !== input.expectedTakeoverEpoch
      ) {
        throw new RoomStoreError(
          "delivery_state_conflict",
          `Native IDE sender takeover ${input.takeoverId} does not match its durable projection`,
        );
      }
      const replacementLeaseId = nativeIdeSenderLeaseId(
        this.projectId,
        input.roomId,
        input.bindingId,
        input.takeoverId,
        "human",
      );
      await lockRoomLeaseResourceWithinTransaction(tx, this.projectId, "sender", input.bindingId);
      await assertPersistedRoomLeaseFenceIdentity(tx, this.projectId, input.fromSenderFence);
      if (input.fromSenderFence.expectedEpoch !== takeover.autoSenderLeaseEpoch) {
        throw new RoomLeaseFenceError(
          `Native IDE sender takeover ${input.takeoverId} must transfer automatic epoch ${takeover.autoSenderLeaseEpoch}`,
          null,
        );
      }
      if (takeover.state === "human_active") {
        const replayedLease = await loadRoomLeaseById(tx, this.projectId, replacementLeaseId);
        if (
          !replayedLease
          || replayedLease.roomId !== input.roomId
          || replayedLease.resourceId !== input.bindingId
          || replayedLease.holderId !== input.humanHolderId
          || replayedLease.hostId !== input.hostId
          || replayedLease.epoch !== takeover.autoSenderLeaseEpoch + 1
        ) {
          throw new RoomStoreError(
            "delivery_state_conflict",
            `Native IDE sender takeover ${input.takeoverId} was already transferred with different authority`,
          );
        }
        return { takeover, senderLease: replayedLease };
      }
      if (takeover.state !== "ready_for_transfer" || takeover.confirmedCursor === null) {
        throw new RoomStoreError(
          "delivery_state_conflict",
          `Native IDE sender takeover ${input.takeoverId} is not ready for explicit transfer`,
        );
      }

      const transferred = await transferRoomSenderLeaseWithinTransaction(
        tx,
        this.projectId,
        {
          fromFence: { ...input.fromSenderFence, now: input.now },
          replacementLeaseId,
          replacementHolderId: input.humanHolderId,
          replacementHostId: input.hostId,
          now: input.now,
          expiresAt: input.expiresAt,
        },
      );
      const transferredTakeover: NativeIdeSenderTakeoverProjectionV1 = {
        ...takeover,
        state: "human_active",
      };
      const state: RoomConnectorIngestionStateV1 = {
        ...current,
        senderTakeover: transferredTakeover,
        updatedAt: latestTimestamp(current.updatedAt, input.now),
      };
      await persistRoomConnectorIngestionState(tx, this.projectId, state, state.updatedAt!);
      return {
        takeover: transferredTakeover,
        senderLease: transferred.replacement,
      };
    });
  }

  async resumeAutomaticSenderAfterNativeIde(
    input: ResumeAutomaticSenderAfterNativeIdeInput,
  ): Promise<ResumeAutomaticSenderAfterNativeIdeResult> {
    assertCanonicalIsoTimestamp(input.now, "Automatic sender resume now");
    assertCanonicalIsoTimestamp(input.expiresAt, "Automatic sender resume expiresAt");
    if (Date.parse(input.expiresAt) <= Date.parse(input.now)) {
      throw new RoomStoreError(
        "delivery_state_conflict",
        "Automatic sender resume expiry must be after its resume time",
      );
    }
    if (
      !input.takeoverId.trim()
      || !input.confirmedCursor.trim()
      || !input.automaticHolderId.trim()
      || !Number.isSafeInteger(input.expectedTakeoverEpoch)
      || input.expectedTakeoverEpoch < 1
    ) {
      throw new RoomStoreError(
        "delivery_state_conflict",
        "Automatic sender resume requires a valid takeover, cursor, epoch, and holder",
      );
    }
    if (
      input.fromHumanFence.kind !== "sender"
      || input.fromHumanFence.roomId !== input.roomId
      || input.fromHumanFence.resourceId !== input.bindingId
      || input.fromHumanFence.hostId !== input.hostId
    ) {
      throw new RoomLeaseFenceError(
        `Automatic sender resume fence does not authorize binding ${input.bindingId}`,
        null,
      );
    }

    return this.layer.transactionImmediate(async (tx) => {
      await lockRoomConnectorIngestion(tx, this.projectId, input.bindingId);
      await requireRoomBinding(tx, this.projectId, input.roomId, input.bindingId);
      const current = await loadRoomConnectorIngestionState(
        tx,
        this.projectId,
        input.roomId,
        input.bindingId,
      );
      const takeover = current.senderTakeover;
      if (
        takeover === null
        || takeover.takeoverId !== input.takeoverId
        || takeover.takeoverEpoch !== input.expectedTakeoverEpoch
      ) {
        throw new RoomStoreError(
          "resume_cursor_conflict",
          `Automatic sender resume does not match takeover ${input.takeoverId} and its confirmed cursor`,
        );
      }
      if (
        (takeover.state !== "releasing" && takeover.state !== "automatic_resumed")
        || takeover.confirmedCursor !== input.confirmedCursor
      ) {
        throw new RoomStoreError(
          "resume_cursor_conflict",
          `Automatic sender resume requires post-human reconciliation for takeover ${input.takeoverId}`,
        );
      }

      const replacementLeaseId = nativeIdeSenderLeaseId(
        this.projectId,
        input.roomId,
        input.bindingId,
        input.takeoverId,
        "automatic",
      );
      await lockRoomLeaseResourceWithinTransaction(tx, this.projectId, "sender", input.bindingId);
      const expectedHumanEpoch = takeover.state === "automatic_resumed"
        ? takeover.autoSenderLeaseEpoch - 1
        : takeover.autoSenderLeaseEpoch + 1;
      await assertPersistedRoomLeaseFenceIdentity(tx, this.projectId, input.fromHumanFence);
      if (input.fromHumanFence.expectedEpoch !== expectedHumanEpoch) {
        throw new RoomLeaseFenceError(
          `Automatic sender resume for ${input.takeoverId} requires human epoch ${expectedHumanEpoch}`,
          null,
        );
      }
      if (takeover.state === "automatic_resumed") {
        const replayedLease = await loadRoomLeaseById(tx, this.projectId, replacementLeaseId);
        if (
          !replayedLease
          || replayedLease.roomId !== input.roomId
          || replayedLease.resourceId !== input.bindingId
          || replayedLease.holderId !== input.automaticHolderId
          || replayedLease.hostId !== input.hostId
          || replayedLease.epoch !== takeover.autoSenderLeaseEpoch
        ) {
          throw new RoomStoreError(
            "delivery_state_conflict",
            `Automatic sender resume for ${input.takeoverId} was already committed with different authority`,
          );
        }
        return { takeover, senderLease: replayedLease };
      }

      const transferred = await transferRoomSenderLeaseWithinTransaction(
        tx,
        this.projectId,
        {
          fromFence: { ...input.fromHumanFence, now: input.now },
          replacementLeaseId,
          replacementHolderId: input.automaticHolderId,
          replacementHostId: input.hostId,
          now: input.now,
          expiresAt: input.expiresAt,
        },
      );
      const resumedTakeover: NativeIdeSenderTakeoverProjectionV1 = {
        ...takeover,
        state: "automatic_resumed",
        automaticSender: "active",
        autoSenderLeaseEpoch: transferred.replacement.epoch,
      };
      const state: RoomConnectorIngestionStateV1 = {
        ...current,
        mode: current.mode === "stopped" ? "stopped" : "streaming",
        nativeWriterDetected: false,
        senderTakeover: resumedTakeover,
        lastModeAt: current.mode === "stopped"
          ? current.lastModeAt
          : latestTimestamp(current.lastModeAt, input.now),
        updatedAt: latestTimestamp(current.updatedAt, input.now),
      };
      await persistRoomConnectorIngestionState(tx, this.projectId, state, state.updatedAt!);
      return { takeover: resumedTakeover, senderLease: transferred.replacement };
    });
  }

  async recordConnectorIngestionMode(
    input: RecordRoomConnectorIngestionModeInput,
  ): Promise<RoomConnectorIngestionStateV1> {
    return this.layer.transactionImmediate(async (tx) => {
      await lockRoomConnectorIngestion(tx, this.projectId, input.bindingId);
      await requireRoomBinding(tx, this.projectId, input.roomId, input.bindingId);
      const current = await loadRoomConnectorIngestionState(
        tx,
        this.projectId,
        input.roomId,
        input.bindingId,
      );
      if (isEarlierTimestamp(input.occurredAt, current.lastModeAt)) return current;
      if (current.lastModeAt === input.occurredAt) {
        if (current.mode !== input.mode) {
          throw new RoomStoreError(
            "delivery_state_conflict",
            `Connector ingestion timestamp ${input.occurredAt} was replayed with a different mode`,
          );
        }
        return current;
      }
      const state: RoomConnectorIngestionStateV1 = {
        ...current,
        mode: input.mode,
        lastModeAt: input.occurredAt,
        updatedAt: latestTimestamp(current.updatedAt, input.occurredAt),
      };
      await persistRoomConnectorIngestionState(tx, this.projectId, state, state.updatedAt!);
      return state;
    });
  }

  async recordInboxReceipt(
    input: RecordRoomInboxReceiptInput,
  ): Promise<RoomInboxReceiptV1> {
    return this.layer.transactionImmediate(async (tx) => {
      await lockRoomConnectorIngestion(tx, this.projectId, input.bindingId);
      await requireRoomBinding(tx, this.projectId, input.roomId, input.bindingId);
      return (await insertRoomInboxReceipt(tx, this.projectId, normalizeInboxReceipt(input))).receipt;
    });
  }

  private publishCommittedEvent(event: RoomEventRecordV1): void {
    for (const listener of this.listeners) {
      queueMicrotask(() => {
        Promise.resolve(listener(event)).catch((error) => {
          try {
            this.options.onNotificationError?.(error, event);
          } catch {
            // A diagnostics hook must not turn notification failure into an
            // unhandled exception after the command has already committed.
          }
        });
      });
    }
  }
}

type LoadedEnqueueMessageResult = Omit<EnqueueRoomMessageResult, "replayed">;
type LoadedRouteOperatorMessageResult = Omit<RouteOperatorMessageResultV1, "replayed">;
type RouteOperatorMessageEnvelopeV1 = Omit<RoomControllerCommandEnvelopeV1, "command"> & {
  readonly command: Extract<
    RoomControllerCommandEnvelopeV1["command"],
    { readonly type: "route_message" }
  >;
};

interface ResolvedOperatorMessageSeat {
  readonly seatId: string;
  readonly bindingId: string;
}

async function loadInitialRoomCreationResult(
  handle: QueryHandle,
  projectId: string,
  roomId: string,
  eventId: string,
): Promise<RoomAggregateV1> {
  const eventRows = await handle
    .select()
    .from(roomEvents)
    .where(and(
      eq(roomEvents.projectId, projectId),
      eq(roomEvents.roomId, roomId),
      eq(roomEvents.id, eventId),
    ))
    .limit(1);
  const event = eventRows[0];
  if (!event || event.eventType !== "room_created" || Number(event.aggregateVersion) !== 0) {
    throw new RoomStoreError(
      "idempotency_result_missing",
      `Committed existing-Session Room creation event ${eventId} no longer exists or has the wrong type`,
    );
  }
  const payload = asRecord(event.payload);
  const projectionHash = typeof payload.initialProjectionHash === "string"
    ? payload.initialProjectionHash
    : null;
  if (!projectionHash || hashRoomValue(payload.initialProjection) !== projectionHash) {
    throw new RoomStoreError(
      "idempotency_result_missing",
      `Committed existing-Session Room creation event ${eventId} has no valid initial projection evidence`,
    );
  }
  let aggregate: RoomAggregateV1;
  try {
    aggregate = parseRoomAggregateProjection(payload.initialProjection);
  } catch {
    throw new RoomStoreError(
      "idempotency_result_missing",
      `Committed existing-Session Room creation event ${eventId} has an invalid initial projection`,
    );
  }
  if (
    aggregate.room.projectId !== projectId
    || aggregate.room.id !== roomId
    || aggregate.room.aggregateVersion !== 0
  ) {
    throw new RoomStoreError(
      "idempotency_result_missing",
      `Committed existing-Session Room creation event ${eventId} projection identity does not match the event`,
    );
  }
  return aggregate;
}

async function loadMembershipResult(
  handle: QueryHandle,
  projectId: string,
  eventId: string,
  expectedEventType: "membership_change_requested" | "membership_change_activated",
): Promise<RoomAggregateV1> {
  const eventRows = await handle
    .select()
    .from(roomEvents)
    .where(and(eq(roomEvents.projectId, projectId), eq(roomEvents.id, eventId)))
    .limit(1);
  const eventRow = eventRows[0];
  if (!eventRow || eventRow.eventType !== expectedEventType) {
    throw new RoomStoreError(
      "idempotency_result_missing",
      `Committed membership event ${eventId} no longer exists or has the wrong type`,
    );
  }
  const payload = asRecord(eventRow.payload);
  const projectionHash = typeof payload.projectionHash === "string"
    ? payload.projectionHash
    : null;
  if (!projectionHash || hashRoomValue(payload.projection) !== projectionHash) {
    throw new RoomStoreError(
      "idempotency_result_missing",
      `Committed membership event ${eventId} has no valid projection evidence`,
    );
  }
  let aggregate: RoomAggregateV1;
  try {
    aggregate = parseRoomAggregateProjection(payload.projection);
  } catch {
    throw new RoomStoreError(
      "idempotency_result_missing",
      `Committed membership event ${eventId} has an invalid projection`,
    );
  }
  if (
    aggregate.room.projectId !== projectId
    || aggregate.room.id !== eventRow.roomId
    || aggregate.room.aggregateVersion !== eventRow.aggregateVersion
  ) {
    throw new RoomStoreError(
      "idempotency_result_missing",
      `Committed membership event ${eventId} projection identity does not match the event`,
    );
  }
  return aggregate;
}

async function loadEnqueueMessageResult(
  handle: QueryHandle,
  projectId: string,
  eventId: string,
): Promise<LoadedEnqueueMessageResult> {
  const eventRows = await handle
    .select()
    .from(roomEvents)
    .where(and(eq(roomEvents.projectId, projectId), eq(roomEvents.id, eventId)))
    .limit(1);
  const eventRow = eventRows[0];
  if (!eventRow) {
    throw new RoomStoreError(
      "idempotency_result_missing",
      `Committed Room event ${eventId} no longer exists`,
    );
  }
  const payload = asRecord(eventRow.payload);
  const messageId = typeof payload.messageId === "string" ? payload.messageId : undefined;
  const outboxIds = asStringArray(payload.outboxIds);
  if (!messageId || outboxIds.length === 0) {
    throw new RoomStoreError(
      "idempotency_result_missing",
      `Room event ${eventId} does not identify its message and outbox rows`,
    );
  }

  const messageRows = await handle
    .select()
    .from(roomMessages)
    .where(
      and(
        eq(roomMessages.projectId, projectId),
        eq(roomMessages.roomId, eventRow.roomId),
        eq(roomMessages.id, messageId),
      ),
    )
    .limit(1);
  const messageRow = messageRows[0];
  if (!messageRow) {
    throw new RoomStoreError(
      "idempotency_result_missing",
      `Room message ${messageId} for event ${eventId} no longer exists`,
    );
  }

  const outboxRows = await handle
    .select()
    .from(roomOutbox)
    .where(
      and(
        eq(roomOutbox.projectId, projectId),
        eq(roomOutbox.roomId, eventRow.roomId),
        inArray(roomOutbox.id, outboxIds),
      ),
    );
  const byId = new Map(outboxRows.map((row) => [row.id, row]));
  const orderedRows = outboxIds.map((id) => byId.get(id));
  if (orderedRows.some((row) => row === undefined)) {
    throw new RoomStoreError(
      "idempotency_result_missing",
      `One or more outbox rows for Room event ${eventId} no longer exist`,
    );
  }

  return {
    message: rowToStoredMessage(messageRow),
    deliveries: orderedRows.map((row) => rowToOutboxRecord(row!)),
    event: rowToRoomEvent(eventRow),
  };
}

async function loadRouteOperatorMessageResult(
  handle: QueryHandle,
  projectId: string,
  eventId: string,
): Promise<LoadedRouteOperatorMessageResult> {
  const eventRows = await handle
    .select()
    .from(roomEvents)
    .where(and(eq(roomEvents.projectId, projectId), eq(roomEvents.id, eventId)))
    .limit(1);
  const eventRow = eventRows[0];
  if (!eventRow || eventRow.eventType !== "message_routed") {
    throw new RoomStoreError(
      "idempotency_result_missing",
      `Committed routed-message event ${eventId} no longer exists`,
    );
  }
  const payload = asRecord(eventRow.payload);
  const messageId = typeof payload.messageId === "string" ? payload.messageId : undefined;
  const targetIds = asStringArray(payload.targetIds);
  const outboxIds = asStringArray(payload.outboxIds);
  if (!messageId || targetIds.length === 0) {
    throw new RoomStoreError(
      "idempotency_result_missing",
      `Routed-message event ${eventId} does not identify its message and frozen targets`,
    );
  }

  const messageRows = await handle
    .select()
    .from(roomMessages)
    .where(and(
      eq(roomMessages.projectId, projectId),
      eq(roomMessages.roomId, eventRow.roomId),
      eq(roomMessages.id, messageId),
    ))
    .limit(1);
  const messageRow = messageRows[0];
  if (
    !messageRow
    || messageRow.idempotencyKey === null
    || messageRow.expectedAggregateVersion === null
  ) {
    throw new RoomStoreError(
      "idempotency_result_missing",
      `Routed Room message ${messageId} for event ${eventId} no longer exists`,
    );
  }

  const targetRows = await handle
    .select()
    .from(roomMessageTargets)
    .where(and(
      eq(roomMessageTargets.projectId, projectId),
      eq(roomMessageTargets.roomId, eventRow.roomId),
      eq(roomMessageTargets.messageId, messageId),
    ));
  const targetsById = new Map(targetRows.map((row) => [row.id, row]));
  const orderedTargetRows = targetIds.map((id) => targetsById.get(id));
  if (
    orderedTargetRows.some((row) => row === undefined)
    || targetRows.length !== targetIds.length
  ) {
    throw new RoomStoreError(
      "idempotency_result_missing",
      `One or more frozen targets for routed-message event ${eventId} no longer exist`,
    );
  }
  const targets = orderedTargetRows.map((row) => rowToDurableMessageTarget(row!));

  let deliveries: readonly RoomOutboxRecordV1[] = [];
  if (outboxIds.length > 0) {
    const outboxRows = await handle
      .select()
      .from(roomOutbox)
      .where(and(
        eq(roomOutbox.projectId, projectId),
        eq(roomOutbox.roomId, eventRow.roomId),
        inArray(roomOutbox.id, outboxIds),
      ));
    const outboxById = new Map(outboxRows.map((row) => [row.id, row]));
    const orderedOutboxRows = outboxIds.map((id) => outboxById.get(id));
    if (orderedOutboxRows.some((row) => row === undefined)) {
      throw new RoomStoreError(
        "idempotency_result_missing",
        `One or more outbox rows for routed-message event ${eventId} no longer exist`,
      );
    }
    deliveries = orderedOutboxRows.map((row) => rowToOutboxRecord(row!));
  }

  return {
    message: rowToStoredRoutedOperatorMessage(messageRow, targets),
    targets,
    deliveries,
    event: rowToRoomEvent(eventRow),
  };
}

async function loadDurableMessageTargets(
  handle: QueryHandle,
  projectId: string,
  roomId: string,
  messageId: string,
): Promise<DurableRoomMessageTargetV1[]> {
  const rows = await handle
    .select()
    .from(roomMessageTargets)
    .where(and(
      eq(roomMessageTargets.projectId, projectId),
      eq(roomMessageTargets.roomId, roomId),
      eq(roomMessageTargets.messageId, messageId),
    ))
    .orderBy(asc(roomMessageTargets.ordinal));
  return rows.map(rowToDurableMessageTarget);
}

function assertRouteOperatorMessageEnvelope(
  envelope: RoomControllerCommandEnvelopeV1,
  projectId: string,
): asserts envelope is RouteOperatorMessageEnvelopeV1 {
  const candidate = envelope as unknown;
  if (!isRuntimeRecord(candidate)) {
    throwInvalidRoutingCommand();
  }
  const authority = candidate.authority;
  const command = candidate.command;
  if (
    !isRuntimeRecord(authority)
    || !isRuntimeRecord(command)
    || candidate.contractVersion !== 1
    || candidate.apiVersion !== "room.v1"
    || command.type !== "route_message"
    || candidate.projectId !== projectId
    || authority.projectId !== projectId
    || authority.roomId !== candidate.roomId
    || authority.actorType !== "human"
    || !isUniqueNonBlankStringArray(authority.allowedActions)
    || !authority.allowedActions.includes("room:message:route")
    || !isNonBlankString(candidate.commandId)
    || !isNonBlankString(candidate.idempotencyKey)
    || !isNonBlankString(candidate.correlationId)
    || !isNonBlankString(candidate.roomId)
    || !isCanonicalUtcIsoTimestamp(candidate.issuedAt)
    || !isNonBlankString(authority.actorId)
    || !(authority.deviceId === null || isNonBlankString(authority.deviceId))
    || !isNonBlankString(authority.role)
    || !isUniqueNonBlankStringArray(authority.nodeIds)
    || !isUniqueNonBlankStringArray(authority.seatIds)
    || !isUniqueNonBlankStringArray(authority.evidenceRefs)
    || !Number.isSafeInteger(candidate.expectedAggregateVersion)
    || (candidate.expectedAggregateVersion as number) < 0
    || !isRoomMessageIntent(command.intent)
    || !isRoomMessageTarget(command.target)
    || typeof command.content !== "string"
    || !isNonBlankString(command.contentHash)
    || !(command.nodeId === null || isNonBlankString(command.nodeId))
  ) {
    throwInvalidRoutingCommand();
  }
  const routedCommand = envelope.command as RouteOperatorMessageEnvelopeV1["command"];
  if (hashRoomValue(routedCommand.content) !== routedCommand.contentHash) {
    throw new RoomStoreError(
      "routing_command_invalid",
      "Routed operator message content does not match its declared content hash",
    );
  }
  if (
    routedCommand.nodeId !== null
    && !envelope.authority.nodeIds.includes(routedCommand.nodeId)
  ) {
    throw new RoomStoreError(
      "authority_scope_violation",
      `Authority envelope does not permit routed messages for node ${routedCommand.nodeId}`,
    );
  }
}

const ROOM_MESSAGE_INTENTS = new Set<RoomMessageIntent>([
  "instruction",
  "proposal",
  "question",
  "critique",
  "challenge",
  "verdict",
  "handoff",
  "help_request",
]);

function throwInvalidRoutingCommand(): never {
  throw new RoomStoreError(
    "routing_command_invalid",
    "Routed operator message requires a canonical v1 timestamp, intent, target, authority, project, Room, action, actor, and aggregate version",
  );
}

function isRuntimeRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isUniqueNonBlankStringArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.every(isNonBlankString)
    && new Set(value).size === value.length;
}

function isCanonicalUtcIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isRoomMessageIntent(value: unknown): value is RoomMessageIntent {
  return typeof value === "string" && ROOM_MESSAGE_INTENTS.has(value as RoomMessageIntent);
}

function isRoomMessageTarget(value: unknown): value is RoomMessageTargetV1 {
  if (!isRuntimeRecord(value)) return false;
  if (value.kind === "controller" || value.kind === "all") return true;
  if (value.kind === "group") {
    return typeof value.groupId === "string" && /^role:[^:\s][^\s]*$/u.test(value.groupId);
  }
  if (value.kind === "seats") {
    return isUniqueNonBlankStringArray(value.seatIds) && value.seatIds.length > 0;
  }
  return false;
}

function resolveOperatorMessageTargets(
  aggregate: RoomAggregateV1,
  target: RoomMessageTargetV1,
): ResolvedOperatorMessageSeat[] {
  if (target.kind === "controller") return [];

  let seats: RoomAggregateV1["seats"];
  if (target.kind === "all") {
    seats = aggregate.seats.filter(isOperatorMessageSeatRoutable);
    if (seats.length === 0) {
      throw new RoomStoreError(
        "routing_target_not_found",
        `Room ${aggregate.room.id} has no routable seats`,
      );
    }
  } else if (target.kind === "group") {
    const role = target.groupId.slice("role:".length);
    seats = aggregate.seats.filter((seat) => isOperatorMessageSeatRoutable(seat) && seat.role === role);
    if (seats.length === 0) {
      throw new RoomStoreError(
        "routing_group_not_found",
        `Room ${aggregate.room.id} has no routable ${target.groupId} group`,
      );
    }
  } else {
    seats = target.seatIds.map((seatId) => {
      const seat = aggregate.seats.find((candidate) => candidate.id === seatId);
      if (!seat || !isOperatorMessageSeatRoutable(seat)) {
        throw new RoomStoreError(
          "routing_target_not_found",
          `Room ${aggregate.room.id} has no routable seat ${seatId}`,
        );
      }
      return seat;
    });
  }

  return seats.map((seat) => {
    const binding = seat.activeBindingId === null
      ? undefined
      : aggregate.bindings.find((candidate) => candidate.id === seat.activeBindingId);
    if (!binding || binding.seatId !== seat.id || binding.state !== "attached") {
      throw new RoomStoreError(
        "routing_target_not_found",
        `Active seat ${seat.id} has no attached current binding`,
      );
    }
    return { seatId: seat.id, bindingId: binding.id };
  });
}

function isOperatorMessageSeatRoutable(
  seat: RoomAggregateV1["seats"][number],
): boolean {
  // Exact existing Sessions are durably attached while their seats are still
  // ready. Allow operator priming before the first turn, but never route new
  // provider work to paused, waiting, lost, pending, or removed membership.
  return seat.state === "ready" || seat.state === "active";
}

function assertAuthoritySeatScope(
  authority: RoomAuthorityEnvelopeV1,
  targetSeatIds: readonly string[],
): void {
  const authorizedSeatIds = new Set(authority.seatIds);
  const unauthorizedSeatId = targetSeatIds.find((seatId) => !authorizedSeatIds.has(seatId));
  if (unauthorizedSeatId) {
    throw new RoomStoreError(
      "authority_scope_violation",
      `Authority envelope does not permit routed messages to seat ${unauthorizedSeatId}`,
    );
  }
}

function validateMessageDeliveries(
  aggregate: RoomAggregateV1,
  input: EnqueueRoomMessageInput,
): void {
  const targetSeatIds = [...input.message.targetSeatIds];
  const targetSeatSet = new Set(targetSeatIds);
  const deliveryIds = new Set(input.deliveries.map((delivery) => delivery.id));
  const bindingIds = new Set(input.deliveries.map((delivery) => delivery.bindingId));
  if (
    targetSeatIds.length === 0
    || targetSeatSet.size !== targetSeatIds.length
    || input.deliveries.length !== targetSeatIds.length
    || deliveryIds.size !== input.deliveries.length
    || bindingIds.size !== input.deliveries.length
  ) {
    throw new RoomStoreError(
      "delivery_target_conflict",
      "A Room message requires one unique attached binding and outbox row per unique target seat",
    );
  }

  const deliveredSeatIds = new Set<string>();
  for (const delivery of input.deliveries) {
    const binding = aggregate.bindings.find((candidate) => candidate.id === delivery.bindingId);
    if (!binding || binding.state !== "attached") {
      throw new RoomStoreError(
        "delivery_target_conflict",
        `Binding ${delivery.bindingId} is not attached to Room ${input.roomId}`,
      );
    }
    const seat = aggregate.seats.find((candidate) => candidate.id === binding.seatId);
    if (
      !seat
      || !targetSeatSet.has(seat.id)
      || seat.activeBindingId !== binding.id
      || seat.state === "lost"
      || seat.state === "removed"
    ) {
      throw new RoomStoreError(
        "delivery_target_conflict",
        `Binding ${binding.id} is not the active binding of a requested Room seat`,
      );
    }
    deliveredSeatIds.add(seat.id);
  }
  if (
    deliveredSeatIds.size !== targetSeatSet.size
    || [...targetSeatSet].some((seatId) => !deliveredSeatIds.has(seatId))
  ) {
    throw new RoomStoreError(
      "delivery_target_conflict",
      "Room message deliveries do not exactly match the target seat set",
    );
  }
}

function rowToStoredMessage(row: typeof roomMessages.$inferSelect): StoredRoomMessageV1 {
  const target = asRecord(row.target);
  return {
    contractVersion: 1,
    id: row.id,
    roomId: row.roomId,
    turnId: row.turnId,
    nodeId: row.nodeId,
    originType: row.originType as StoredRoomMessageV1["originType"],
    originId: row.originId,
    targetSeatIds: asStringArray(target.seatIds),
    intent: row.intent,
    contentHash: row.contentHash,
    authorityEnvelope: asRecord(row.authority),
    createdAt: row.createdAt,
    content: row.content,
  };
}

function rowToStoredRoutedOperatorMessage(
  row: typeof roomMessages.$inferSelect,
  targets: readonly DurableRoomMessageTargetV1[],
): StoredRoutedOperatorMessageV1 {
  if (row.idempotencyKey === null || row.expectedAggregateVersion === null) {
    throw new RoomStoreError(
      "idempotency_result_missing",
      `Room message ${row.id} is missing routed-command provenance`,
    );
  }
  return {
    contractVersion: 1,
    id: row.id,
    roomId: row.roomId,
    turnId: row.turnId,
    nodeId: row.nodeId,
    originType: row.originType as StoredRoutedOperatorMessageV1["originType"],
    originId: row.originId,
    targetSeatIds: targets
      .filter((target) => target.targetKind === "seat" && target.seatId !== null)
      .map((target) => target.seatId!),
    intent: row.intent,
    contentHash: row.contentHash,
    authorityEnvelope: asRecord(row.authority) as unknown as RoomAuthorityEnvelopeV1,
    createdAt: row.createdAt,
    content: row.content,
    target: asRecord(row.target) as unknown as RoomMessageTargetV1,
    idempotencyKey: row.idempotencyKey,
    expectedAggregateVersion: Number(row.expectedAggregateVersion),
  };
}

function rowToDurableMessageTarget(
  row: typeof roomMessageTargets.$inferSelect,
): DurableRoomMessageTargetV1 {
  return {
    contractVersion: 1,
    id: row.id,
    projectId: row.projectId,
    roomId: row.roomId,
    messageId: row.messageId,
    selectorKind: row.selectorKind as DurableRoomMessageTargetV1["selectorKind"],
    selectorRef: row.selectorRef,
    targetKind: row.targetKind as DurableRoomMessageTargetV1["targetKind"],
    seatId: row.seatId,
    bindingId: row.bindingId,
    ordinal: row.ordinal,
    createdAt: row.createdAt,
  };
}

function rowToBindingRecord(row: typeof roomBindings.$inferSelect): RoomBindingRecordV1 {
  return {
    contractVersion: 1,
    id: row.id,
    roomId: row.roomId,
    seatId: row.seatId,
    generation: row.generation,
    connectorId: row.connectorId,
    providerId: row.providerId,
    nativeSessionId: row.nativeSessionId,
    happierSessionId: row.happierSessionId,
    serverProfileId: row.serverProfileId,
    machineId: row.machineId,
    hostId: row.hostId,
    state: row.state as RoomBindingRecordV1["state"],
    attachedAt: row.attachedAt,
    detachedAt: row.detachedAt,
    replacedByBindingId: row.replacedByBindingId,
  };
}

function rowToOutboxRecord(row: typeof roomOutbox.$inferSelect): RoomOutboxRecordV1 {
  const acknowledgement = asRecord(row.nativeAcknowledgement);
  return {
    contractVersion: 1,
    id: row.id,
    roomId: row.roomId,
    logicalMessageId: row.logicalMessageId,
    localMessageId: row.localMessageId,
    bindingId: row.bindingId,
    idempotencyKey: row.idempotencyKey,
    payloadHash: row.payloadHash,
    state: row.deliveryState as RoomOutboxRecordV1["state"],
    attemptCount: row.attemptCount,
    connectorAcknowledgementId: typeof acknowledgement.connectorAcknowledgementId === "string"
      ? acknowledgement.connectorAcknowledgementId
      : typeof acknowledgement.id === "string"
        ? acknowledgement.id
        : null,
    nativeMessageId: typeof acknowledgement.nativeMessageId === "string"
      ? acknowledgement.nativeMessageId
      : null,
    nativeCursor: row.nativeCursor,
    reconciliationFromCursor: row.reconciliationFromCursor,
    reconciliationEvidenceRef: row.reconciliationEvidenceRef,
    lastErrorCode: row.lastErrorCode,
    nextAttemptAt: row.nextAttemptAt,
    updatedAt: row.updatedAt,
  };
}

function rowToInboxReceipt(row: typeof roomInboxReceipts.$inferSelect): RoomInboxReceiptV1 {
  return {
    id: row.id,
    roomId: row.roomId,
    bindingId: row.bindingId,
    nativeMessageId: row.nativeMessageId,
    logicalMessageId: row.logicalMessageId,
    nativeCursor: row.nativeCursor,
    payloadHash: row.payloadHash,
    role: row.role as RoomConnectorMessageRole,
    occurredAt: row.occurredAt,
    source: row.source as RoomConnectorTranscriptSource,
    receivedAt: row.receivedAt,
  };
}

interface NormalizedRoomInboxReceiptInput extends RoomInboxReceiptV1 {
  readonly dedupeKey: string;
}

function normalizeInboxReceipt(input: RecordRoomInboxReceiptInput): NormalizedRoomInboxReceiptInput {
  const normalized = {
    id: input.id,
    roomId: input.roomId,
    bindingId: input.bindingId,
    nativeMessageId: input.nativeMessageId,
    logicalMessageId: input.logicalMessageId ?? null,
    nativeCursor: input.nativeCursor,
    payloadHash: input.payloadHash,
    role: input.role ?? "unknown",
    occurredAt: input.occurredAt ?? input.receivedAt,
    source: input.source ?? "history",
    receivedAt: input.receivedAt,
  } satisfies RoomInboxReceiptV1;
  return { ...normalized, dedupeKey: buildInboxDedupeKey(normalized) };
}

function connectorTranscriptItemToReceipt(
  input: RecordRoomConnectorTranscriptBatchInput,
  item: RoomConnectorTranscriptItemV1,
): NormalizedRoomInboxReceiptInput {
  const dedupeKey = buildInboxDedupeKey(item);
  return {
    id: `room-inbox-${hashRoomValue({ bindingId: input.bindingId, dedupeKey })}`,
    roomId: input.roomId,
    bindingId: input.bindingId,
    nativeMessageId: item.nativeMessageId,
    logicalMessageId: item.logicalMessageId,
    nativeCursor: item.nativeCursor,
    payloadHash: item.payloadHash,
    dedupeKey,
    role: item.role,
    occurredAt: item.occurredAt,
    source: input.source,
    receivedAt: input.receivedAt,
  };
}

function buildInboxDedupeKey(
  item: Pick<RoomInboxReceiptV1, "nativeMessageId" | "payloadHash" | "role" | "occurredAt">,
): string {
  if (item.nativeMessageId) {
    return `native:${item.nativeMessageId}`;
  }
  return `fallback:${item.payloadHash}:${item.role}:${item.occurredAt}`;
}

async function insertRoomInboxReceipt(
  tx: DbTransaction,
  projectId: string,
  input: NormalizedRoomInboxReceiptInput,
): Promise<{ readonly receipt: RoomInboxReceiptV1; readonly inserted: boolean }> {
  const existing = await findMatchingInboxReceipt(tx, projectId, input);
  if (existing) {
    return {
      receipt: rowToInboxReceipt(
        await reconcileExistingInboxReceipt(tx, existing.row, input, existing.matchedBy),
      ),
      inserted: false,
    };
  }

  const inserted = await tx
    .insert(roomInboxReceipts)
    .values({
      id: input.id,
      projectId,
      roomId: input.roomId,
      bindingId: input.bindingId,
      nativeMessageId: input.nativeMessageId,
      logicalMessageId: input.logicalMessageId,
      nativeCursor: input.nativeCursor,
      payloadHash: input.payloadHash,
      dedupeKey: input.dedupeKey,
      role: input.role,
      occurredAt: input.occurredAt,
      source: input.source,
      legacyPlaceholder: false,
      receivedAt: input.receivedAt,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) return { receipt: rowToInboxReceipt(inserted[0]), inserted: true };

  const conflicted = await findMatchingInboxReceipt(tx, projectId, input);
  if (conflicted) {
    return {
      receipt: rowToInboxReceipt(
        await reconcileExistingInboxReceipt(tx, conflicted.row, input, conflicted.matchedBy),
      ),
      inserted: false,
    };
  }

  throw new RoomStoreError(
    "delivery_state_conflict",
    `Inbox receipt ${input.id} conflicted outside its native cursor and dedupe identity`,
  );
}

type InboxReceiptMatchKind = "dedupe" | "cursor" | "logical" | "legacy";

async function findMatchingInboxReceipt(
  tx: DbTransaction,
  projectId: string,
  input: NormalizedRoomInboxReceiptInput,
): Promise<{
  readonly row: typeof roomInboxReceipts.$inferSelect;
  readonly matchedBy: InboxReceiptMatchKind;
} | null> {
  const scope = [
    eq(roomInboxReceipts.projectId, projectId),
    eq(roomInboxReceipts.roomId, input.roomId),
    eq(roomInboxReceipts.bindingId, input.bindingId),
  ] as const;
  const dedupeRows = await tx.select().from(roomInboxReceipts)
    .where(and(...scope, eq(roomInboxReceipts.dedupeKey, input.dedupeKey)))
    .limit(1);
  if (dedupeRows[0]) return { row: dedupeRows[0], matchedBy: "dedupe" };

  const cursorRows = await tx.select().from(roomInboxReceipts)
    .where(and(...scope, eq(roomInboxReceipts.nativeCursor, input.nativeCursor)))
    .limit(1);
  if (cursorRows[0]) return { row: cursorRows[0], matchedBy: "cursor" };

  if (input.logicalMessageId !== null) {
    const logicalRows = await tx.select().from(roomInboxReceipts)
      .where(and(...scope, eq(roomInboxReceipts.logicalMessageId, input.logicalMessageId)))
      .limit(1);
    if (logicalRows[0]) return { row: logicalRows[0], matchedBy: "logical" };
  }

  const nativeIdentity = input.nativeMessageId === null
    ? isNull(roomInboxReceipts.nativeMessageId)
    : or(
      isNull(roomInboxReceipts.nativeMessageId),
      eq(roomInboxReceipts.nativeMessageId, input.nativeMessageId),
    );
  const logicalIdentity = input.logicalMessageId === null
    ? isNull(roomInboxReceipts.logicalMessageId)
    : or(
      isNull(roomInboxReceipts.logicalMessageId),
      eq(roomInboxReceipts.logicalMessageId, input.logicalMessageId),
    );
  const legacyRows = await tx.select().from(roomInboxReceipts)
    .where(and(
      ...scope,
      eq(roomInboxReceipts.legacyPlaceholder, true),
      eq(roomInboxReceipts.payloadHash, input.payloadHash),
      nativeIdentity,
      logicalIdentity,
    ))
    .limit(2);
  if (legacyRows.length > 1) {
    throw new RoomStoreError(
      "inbox_payload_conflict",
      "Legacy inbox replay matched more than one placeholder receipt",
    );
  }
  return legacyRows[0] ? { row: legacyRows[0], matchedBy: "legacy" } : null;
}

async function reconcileExistingInboxReceipt(
  tx: DbTransaction,
  existing: typeof roomInboxReceipts.$inferSelect,
  input: NormalizedRoomInboxReceiptInput,
  matchedBy: InboxReceiptMatchKind,
): Promise<typeof roomInboxReceipts.$inferSelect> {
  if (existing.payloadHash !== input.payloadHash) {
    throw new RoomStoreError(
      "inbox_payload_conflict",
      `Inbox connector message was replayed with a different payload hash`,
    );
  }
  if (
    existing.nativeMessageId !== null
    && input.nativeMessageId !== null
    && existing.nativeMessageId !== input.nativeMessageId
  ) {
    throw new RoomStoreError(
      "inbox_payload_conflict",
      `Inbox connector message was replayed with a different native message identity`,
    );
  }
  if (
    existing.logicalMessageId !== null
    && input.logicalMessageId !== null
    && existing.logicalMessageId !== input.logicalMessageId
  ) {
    throw new RoomStoreError(
      "inbox_payload_conflict",
      `Inbox connector message was replayed with a different logical message identity`,
    );
  }

  if (existing.legacyPlaceholder) {
    const updatedRows = await tx
      .update(roomInboxReceipts)
      .set({
        nativeMessageId: input.nativeMessageId ?? existing.nativeMessageId,
        logicalMessageId: input.logicalMessageId ?? existing.logicalMessageId,
        dedupeKey: input.dedupeKey,
        role: input.role,
        occurredAt: input.occurredAt,
        source: input.source,
        legacyPlaceholder: false,
      })
      .where(eq(roomInboxReceipts.id, existing.id))
      .returning();
    const updated = updatedRows[0];
    if (!updated) {
      throw new RoomStoreError(
        "delivery_state_conflict",
        `Legacy inbox receipt ${existing.id} disappeared during reconciliation`,
      );
    }
    return updated;
  }

  if (matchedBy === "cursor" && existing.dedupeKey !== input.dedupeKey) {
    throw new RoomStoreError(
      "inbox_payload_conflict",
      `Inbox native cursor ${input.nativeCursor} was reused for a different connector message identity`,
    );
  }
  if (existing.role !== input.role || existing.occurredAt !== input.occurredAt) {
    throw new RoomStoreError(
      "inbox_payload_conflict",
      `Inbox connector message was replayed with different immutable message facts`,
    );
  }
  if (existing.logicalMessageId === null && input.logicalMessageId !== null) {
    const updatedRows = await tx
      .update(roomInboxReceipts)
      .set({ logicalMessageId: input.logicalMessageId })
      .where(eq(roomInboxReceipts.id, existing.id))
      .returning();
    return updatedRows[0] ?? existing;
  }
  return existing;
}

function validateConnectorTranscriptBatchInput(input: RecordRoomConnectorTranscriptBatchInput): void {
  const invalid = (message: string): never => {
    throw new RoomStoreError("connector_batch_invalid", message);
  };
  if (!isNonEmptyString(input.roomId) || !isNonEmptyString(input.bindingId)) {
    invalid("Connector transcript batch requires non-empty Room and binding ids");
  }
  if (!isNonEmptyString(input.receivedAt)) {
    invalid("Connector transcript batch requires a receivedAt timestamp");
  }
  if (!isNullableNonEmptyString(input.fromCursor) || !isNullableNonEmptyString(input.nextCursor)) {
    invalid("Connector transcript cursors must be null or non-empty strings");
  }
  if (input.items.length > 250) {
    invalid("Connector transcript batches are limited to 250 items");
  }
  for (const item of input.items) {
    if (
      !isNonEmptyString(item.nativeCursor)
      || !isNonEmptyString(item.payloadHash)
      || !isNonEmptyString(item.occurredAt)
      || !isNullableNonEmptyString(item.nativeMessageId)
      || !isNullableNonEmptyString(item.logicalMessageId)
    ) {
      invalid("Connector transcript items require valid cursors, hashes, identities, and timestamps");
    }
  }
  if (input.items.length === 0 && input.nextCursor !== input.fromCursor) {
    invalid("An empty connector transcript batch cannot advance the durable cursor");
  }
  if (
    input.items.length > 0
    && input.nextCursor !== input.fromCursor
    && input.items[input.items.length - 1]?.nativeCursor !== input.nextCursor
  ) {
    invalid("A connector transcript batch that advances must end at its next cursor");
  }
}

async function classifyCompleteConnectorBatchReplay(
  tx: DbTransaction,
  projectId: string,
  input: RecordRoomConnectorTranscriptBatchInput,
): Promise<{
  readonly duplicateNativeMessageIdCount: number;
  readonly duplicatePayloadHashCount: number;
} | null> {
  let duplicateNativeMessageIdCount = 0;
  let duplicatePayloadHashCount = 0;
  for (const item of input.items) {
    const receipt = connectorTranscriptItemToReceipt(input, item);
    const existing = await findMatchingInboxReceipt(tx, projectId, receipt);
    if (!existing) return null;
    await reconcileExistingInboxReceipt(tx, existing.row, receipt, existing.matchedBy);
    if (item.nativeMessageId) duplicateNativeMessageIdCount += 1;
    else duplicatePayloadHashCount += 1;
  }
  return { duplicateNativeMessageIdCount, duplicatePayloadHashCount };
}

function isNullableNonEmptyString(value: string | null): boolean {
  return value === null || isNonEmptyString(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isEarlierTimestamp(candidate: string, current: string | null): boolean {
  return current !== null && compareTimestamp(candidate, current) < 0;
}

function latestTimestamp(current: string | null, candidate: string): string {
  return current === null || compareTimestamp(candidate, current) > 0 ? candidate : current;
}

function compareTimestamp(left: string, right: string): number {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (Number.isFinite(leftMs) && Number.isFinite(rightMs)) return leftMs - rightMs;
  return left.localeCompare(right);
}

function assertCanonicalIsoTimestamp(value: string, label: string): void {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new RoomStoreError(
      "delivery_state_conflict",
      `${label} must be a canonical UTC ISO timestamp`,
    );
  }
}

async function requireRoomBinding(
  handle: QueryHandle,
  projectId: string,
  roomId: string,
  bindingId: string,
): Promise<void> {
  const bindingRows = await handle
    .select({ id: roomBindings.id })
    .from(roomBindings)
    .where(
      and(
        eq(roomBindings.projectId, projectId),
        eq(roomBindings.roomId, roomId),
        eq(roomBindings.id, bindingId),
      ),
    )
    .limit(1);
  if (bindingRows.length !== 1) {
    throw new RoomStoreError(
      "delivery_target_conflict",
      `Binding ${bindingId} does not belong to Room ${roomId}`,
    );
  }
}

async function lockRoomConnectorIngestion(
  tx: DbTransaction,
  projectId: string,
  bindingId: string,
): Promise<void> {
  const lockKey = `fusion-room-connector-ingestion-v1:${projectId}:${bindingId}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
}

async function loadRoomConnectorIngestionState(
  handle: QueryHandle,
  projectId: string,
  roomId: string,
  bindingId: string,
): Promise<RoomConnectorIngestionStateV1> {
  const rows = await handle
    .select()
    .from(roomBindingIngestionState)
    .where(
      and(
        eq(roomBindingIngestionState.projectId, projectId),
        eq(roomBindingIngestionState.roomId, roomId),
        eq(roomBindingIngestionState.bindingId, bindingId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) {
    return {
      contractVersion: 1,
      roomId,
      bindingId,
      mode: "starting",
      transcriptCursor: null,
      statusCursor: null,
      lastNativeMessageId: null,
      lastPayloadHash: null,
      connectorStatus: null,
      nativeWriterDetected: false,
      senderTakeover: null,
      gapExpectedCursor: null,
      gapObservedCursor: null,
      gapDetectedAt: null,
      lastTranscriptAt: null,
      lastStatusAt: null,
      lastModeAt: null,
      updatedAt: null,
    };
  }
  return {
    contractVersion: 1,
    roomId: row.roomId,
    bindingId: row.bindingId,
    mode: row.mode as RoomConnectorIngestionMode,
    transcriptCursor: row.transcriptCursor,
    statusCursor: row.statusCursor,
    lastNativeMessageId: row.lastNativeMessageId,
    lastPayloadHash: row.lastPayloadHash,
    connectorStatus: row.connectorStatus as RoomConnectorStatus | null,
    nativeWriterDetected: row.nativeWriterDetected,
    senderTakeover: rowToNativeIdeSenderTakeover(row),
    gapExpectedCursor: row.gapExpectedCursor,
    gapObservedCursor: row.gapObservedCursor,
    gapDetectedAt: row.gapDetectedAt,
    lastTranscriptAt: row.lastTranscriptAt,
    lastStatusAt: row.lastStatusAt,
    lastModeAt: row.lastModeAt,
    updatedAt: row.updatedAt,
  };
}

const NATIVE_IDE_SENDER_TAKEOVER_STATES = new Set<NativeIdeSenderTakeoverProjectionV1["state"]>([
  "reconciling",
  "ready_for_transfer",
  "human_active",
  "releasing",
  "automatic_resumed",
  "blocked_delivery_uncertain",
]);

function rowToNativeIdeSenderTakeover(
  row: typeof roomBindingIngestionState.$inferSelect,
): NativeIdeSenderTakeoverProjectionV1 | null {
  const values = [
    row.takeoverId,
    row.takeoverEpoch,
    row.takeoverState,
    row.autoSenderLeaseEpoch,
  ];
  if (values.every((value) => value == null)) return null;
  if (values.some((value) => value == null)) {
    throw new RoomStoreError(
      "delivery_state_conflict",
      `Binding ${row.bindingId} has a partially persisted sender takeover`,
    );
  }
  const takeoverEpoch = Number(row.takeoverEpoch);
  const autoSenderLeaseEpoch = Number(row.autoSenderLeaseEpoch);
  const state = row.takeoverState as NativeIdeSenderTakeoverProjectionV1["state"];
  const blockedOutboxIds = asStringArray(row.blockedOutboxIds);
  const blockedOutboxPayloadIsExact = Array.isArray(row.blockedOutboxIds)
    && blockedOutboxIds.length === row.blockedOutboxIds.length
    && new Set(blockedOutboxIds).size === blockedOutboxIds.length;
  const nativeWriterStateIsInvalid = state === "releasing" || state === "automatic_resumed"
    ? row.nativeWriterDetected
    : state === "ready_for_transfer" || state === "human_active"
      ? !row.nativeWriterDetected
      : false;
  if (
    typeof row.takeoverId !== "string"
    || !row.takeoverId.trim()
    || !Number.isSafeInteger(takeoverEpoch)
    || takeoverEpoch < 1
    || !Number.isSafeInteger(autoSenderLeaseEpoch)
    || autoSenderLeaseEpoch < 1
    || !NATIVE_IDE_SENDER_TAKEOVER_STATES.has(state)
    || !blockedOutboxPayloadIsExact
    || nativeWriterStateIsInvalid
    || (state === "blocked_delivery_uncertain" && blockedOutboxIds.length === 0)
    || (state !== "blocked_delivery_uncertain" && blockedOutboxIds.length > 0)
    || ((state === "ready_for_transfer" || state === "human_active" || state === "automatic_resumed")
      && row.confirmedCursor === null)
  ) {
    throw new RoomStoreError(
      "delivery_state_conflict",
      `Binding ${row.bindingId} has an invalid sender takeover projection`,
    );
  }
  return {
    takeoverId: row.takeoverId,
    takeoverEpoch,
    state,
    automaticSender: state === "automatic_resumed" ? "active" : "paused",
    autoSenderLeaseEpoch,
    reconcileFromCursor: row.reconcileFromCursor,
    confirmedCursor: row.confirmedCursor,
    blockedOutboxIds,
  };
}

async function persistRoomConnectorIngestionState(
  tx: DbTransaction,
  projectId: string,
  state: RoomConnectorIngestionStateV1,
  updatedAt: string,
): Promise<void> {
  const values = {
    bindingId: state.bindingId,
    projectId,
    roomId: state.roomId,
    mode: state.mode,
    transcriptCursor: state.transcriptCursor,
    statusCursor: state.statusCursor,
    lastNativeMessageId: state.lastNativeMessageId,
    lastPayloadHash: state.lastPayloadHash,
    connectorStatus: state.connectorStatus,
    nativeWriterDetected: state.nativeWriterDetected,
    takeoverId: state.senderTakeover?.takeoverId ?? null,
    takeoverEpoch: state.senderTakeover?.takeoverEpoch ?? null,
    takeoverState: state.senderTakeover?.state ?? null,
    autoSenderLeaseEpoch: state.senderTakeover?.autoSenderLeaseEpoch ?? null,
    reconcileFromCursor: state.senderTakeover?.reconcileFromCursor ?? null,
    confirmedCursor: state.senderTakeover?.confirmedCursor ?? null,
    blockedOutboxIds: state.senderTakeover?.blockedOutboxIds ?? [],
    gapExpectedCursor: state.gapExpectedCursor,
    gapObservedCursor: state.gapObservedCursor,
    gapDetectedAt: state.gapDetectedAt,
    lastTranscriptAt: state.lastTranscriptAt,
    lastStatusAt: state.lastStatusAt,
    lastModeAt: state.lastModeAt,
    updatedAt,
  };
  await tx
    .insert(roomBindingIngestionState)
    .values(values)
    .onConflictDoUpdate({
      target: roomBindingIngestionState.bindingId,
      set: {
        mode: values.mode,
        transcriptCursor: values.transcriptCursor,
        statusCursor: values.statusCursor,
        lastNativeMessageId: values.lastNativeMessageId,
        lastPayloadHash: values.lastPayloadHash,
        connectorStatus: values.connectorStatus,
        nativeWriterDetected: values.nativeWriterDetected,
        takeoverId: values.takeoverId,
        takeoverEpoch: values.takeoverEpoch,
        takeoverState: values.takeoverState,
        autoSenderLeaseEpoch: values.autoSenderLeaseEpoch,
        reconcileFromCursor: values.reconcileFromCursor,
        confirmedCursor: values.confirmedCursor,
        blockedOutboxIds: values.blockedOutboxIds,
        gapExpectedCursor: values.gapExpectedCursor,
        gapObservedCursor: values.gapObservedCursor,
        gapDetectedAt: values.gapDetectedAt,
        lastTranscriptAt: values.lastTranscriptAt,
        lastStatusAt: values.lastStatusAt,
        lastModeAt: values.lastModeAt,
        updatedAt: values.updatedAt,
      },
    });
}

async function refreshBlockedSenderTakeoverAfterDeliveryResolution(
  tx: DbTransaction,
  projectId: string,
  roomId: string,
  bindingId: string,
  now: string,
): Promise<void> {
  await lockRoomConnectorIngestion(tx, projectId, bindingId);
  const current = await loadRoomConnectorIngestionState(tx, projectId, roomId, bindingId);
  const takeover = current.senderTakeover;
  if (takeover?.state !== "blocked_delivery_uncertain") return;

  const unresolvedRows = takeover.blockedOutboxIds.length === 0
    ? []
    : await tx
        .select({ id: roomOutbox.id })
        .from(roomOutbox)
        .where(and(
          eq(roomOutbox.projectId, projectId),
          eq(roomOutbox.roomId, roomId),
          eq(roomOutbox.bindingId, bindingId),
          inArray(roomOutbox.id, [...takeover.blockedOutboxIds]),
          inArray(roomOutbox.deliveryState, ["dispatching", "delivery_uncertain"]),
        ))
        .orderBy(asc(roomOutbox.id));
  const blockedOutboxIds = unresolvedRows.map((row) => row.id);
  const nextTakeover: NativeIdeSenderTakeoverProjectionV1 = blockedOutboxIds.length > 0
    ? { ...takeover, blockedOutboxIds }
    : !current.nativeWriterDetected
      ? takeover.confirmedCursor === null
        ? { ...takeover, state: "reconciling", blockedOutboxIds: [] }
        : {
            ...takeover,
            state: "automatic_resumed",
            automaticSender: "active",
            blockedOutboxIds: [],
          }
      : takeover.confirmedCursor === null
        ? { ...takeover, state: "reconciling", blockedOutboxIds: [] }
        : { ...takeover, state: "ready_for_transfer", blockedOutboxIds: [] };
  const state: RoomConnectorIngestionStateV1 = {
    ...current,
    senderTakeover: nextTakeover,
    updatedAt: latestTimestamp(current.updatedAt, now),
  };
  await persistRoomConnectorIngestionState(tx, projectId, state, state.updatedAt!);
}

function deliveryStateForOutcome(
  outcome: CompleteRoomDeliveryAttemptInput["outcome"],
  hasAcceptedEvidence = false,
): RoomOutboxRecordV1["state"] {
  switch (outcome) {
    case "confirmed":
      return "confirmed";
    case "delivery_uncertain":
      return "delivery_uncertain";
    case "retryable_failure":
      return hasAcceptedEvidence ? "delivery_uncertain" : "pending";
    case "rejected":
      return "rejected";
  }
}

function nativeIdeSenderLeaseId(
  projectId: string,
  roomId: string,
  bindingId: string,
  takeoverId: string,
  owner: "human" | "automatic",
): string {
  const digest = hashRoomValue({ projectId, roomId, bindingId, takeoverId, owner })
    .replace(/^sha256:/u, "");
  return `room-sender-${owner}-${digest}`;
}

async function assertPersistedRoomLeaseFenceIdentity(
  tx: DbTransaction,
  projectId: string,
  fence: Omit<AssertRoomLeaseFenceInput, "now">,
): Promise<StoredRoomLeaseV1> {
  const persisted = await loadRoomLeaseById(tx, projectId, fence.leaseId);
  if (
    !persisted
    || persisted.roomId !== fence.roomId
    || persisted.kind !== fence.kind
    || persisted.resourceId !== fence.resourceId
    || persisted.holderId !== fence.holderId
    || persisted.hostId !== fence.hostId
    || persisted.epoch !== fence.expectedEpoch
  ) {
    throw new RoomLeaseFenceError(
      `Lease ${fence.leaseId} does not match its persisted sender-fence identity`,
      null,
    );
  }
  return persisted;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const ROOM_HISTORY_EVIDENCE_REF_PATTERN = /^room-history:sha256:[a-f0-9]{64}$/u;
const ROOM_AUDIT_ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;

function assertSafeRoomAuditCode(errorCode: string | null, context: string): void {
  if (errorCode !== null && !ROOM_AUDIT_ERROR_CODE_PATTERN.test(errorCode)) {
    throw new RoomStoreError(
      "delivery_state_conflict",
      `${context} error code must be a bounded machine-readable identifier`,
    );
  }
}

const ACTIVE_ROOM_BINDING_STATES = [
  "pending",
  "attached",
  "paused",
  "authentication_blocked",
  "host_unavailable",
  "delivery_uncertain",
] as const;

function assertLegacyImportInput(input: ImportLegacyHappierBindingInput): void {
  const requiredValues = [
    ["room.id", input.room.id],
    ["room.objective", input.room.objective],
    ["room.protocolId", input.room.protocolId],
    ["seat.id", input.seat.id],
    ["seat.role", input.seat.role],
    ["bindingId", input.bindingId],
    ["source.taskId", input.source.taskId],
    ["source.cliSessionId", input.source.cliSessionId],
    ["source.nativeSessionId", input.source.nativeSessionId],
    ["source.happierSessionId", input.source.happierSessionId],
    ["source.machineId", input.source.machineId],
    ["source.hostId", input.source.hostId],
    ["source.serverProfileId", input.source.serverProfileId],
  ] as const;
  for (const [label, value] of requiredValues) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new RoomStoreError(
        "legacy_binding_integrity_conflict",
        `Legacy Happier import requires ${label}`,
      );
    }
  }
  if (
    !Number.isInteger(input.room.protocolVersion)
    || input.room.protocolVersion < 1
  ) {
    throw new RoomStoreError(
      "legacy_binding_integrity_conflict",
      "Legacy Happier import requires a positive integer protocol version",
    );
  }
  if (!isLegacyHappierProviderId(input.source.providerId)) {
    throw new RoomStoreError(
      "legacy_binding_integrity_conflict",
      `Unsupported legacy Happier provider ${String(input.source.providerId)}`,
    );
  }
  if (
    !isIsoTimestamp(input.source.linkedAt)
    || !isIsoTimestamp(input.source.cliSessionUpdatedAt)
    || !isIsoTimestamp(input.now)
  ) {
    throw new RoomStoreError(
      "legacy_binding_integrity_conflict",
      "Legacy Happier import timestamps must be valid ISO timestamps",
    );
  }
  if (
    input.seat.permissionScope.some((permission) => (
      typeof permission !== "string" || permission.trim().length === 0
    ))
    || new Set(input.seat.permissionScope).size !== input.seat.permissionScope.length
  ) {
    throw new RoomStoreError(
      "legacy_binding_integrity_conflict",
      "Legacy Happier import permissions must be unique non-empty strings",
    );
  }
}

function isLegacyHappierProviderId(value: unknown): value is LegacyHappierBindingProviderId {
  return value === "codex" || value === "claude" || value === "opencode";
}

function isIsoTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

async function lockLegacyHappierBindingSource(
  tx: DbTransaction,
  providerId: LegacyHappierBindingProviderId,
  nativeSessionId: string,
  happierSessionId: string,
): Promise<void> {
  await lockRoomBindingIdentity(tx, {
    connectorId: "happier",
    providerId,
    nativeSessionId,
    happierSessionId,
  });
}

async function verifyLegacyHappierBindingSource(
  tx: DbTransaction,
  projectId: string,
  source: LegacyHappierBindingSourceV1,
): Promise<void> {
  const rows = await tx
    .select()
    .from(cliSessions)
    .where(and(eq(cliSessions.projectId, projectId), eq(cliSessions.id, source.cliSessionId)))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new RoomStoreError(
      "legacy_binding_not_found",
      `Legacy Happier CLI Session ${source.cliSessionId} does not exist in project ${projectId}`,
    );
  }
  if (
    row.taskId !== source.taskId
    || row.purpose !== "execute"
    || row.adapterId !== "happier"
    || row.nativeSessionId !== source.happierSessionId
    || row.updatedAt !== source.cliSessionUpdatedAt
  ) {
    throw new RoomStoreError(
      "legacy_binding_integrity_conflict",
      `Legacy Happier CLI Session ${source.cliSessionId} changed or no longer owns the requested task/native Session`,
    );
  }

  let posture: unknown;
  try {
    posture = row.autonomyPosture ? JSON.parse(row.autonomyPosture) : null;
  } catch {
    throw new RoomStoreError(
      "legacy_binding_integrity_conflict",
      `Legacy Happier CLI Session ${source.cliSessionId} has invalid autonomy metadata`,
    );
  }
  const persisted = asRecord(asRecord(posture).happierDirectSession);
  if (persisted.schemaVersion !== undefined && persisted.schemaVersion !== 2) {
    throw new RoomStoreError(
      "legacy_binding_integrity_conflict",
      `Legacy Happier CLI Session ${source.cliSessionId} uses an unsupported metadata version`,
    );
  }
  const persistedSnapshot = persisted.schemaVersion === 2
    ? {
        cliSessionId: persisted.cliSessionId,
        happierSessionId: persisted.happierSessionId,
        providerId: persisted.providerId,
        nativeSessionId: persisted.nativeSessionId,
        machineId: persisted.machineId,
        serverProfileId: persisted.serverProfileId,
        linkedAt: persisted.linkedAt,
      }
    : {
        cliSessionId: persisted.cliSessionId,
        happierSessionId: persisted.nativeSessionId,
        providerId: persisted.providerId,
        nativeSessionId: persisted.remoteSessionId,
        machineId: persisted.machineId,
        serverProfileId: persisted.serverId,
        linkedAt: persisted.linkedAt,
      };
  const expectedSnapshot = {
    cliSessionId: source.cliSessionId,
    happierSessionId: source.happierSessionId,
    providerId: source.providerId,
    nativeSessionId: source.nativeSessionId,
    machineId: source.machineId,
    serverProfileId: source.serverProfileId,
    linkedAt: source.linkedAt,
  };
  if (hashRoomValue(persistedSnapshot) !== hashRoomValue(expectedSnapshot)) {
    throw new RoomStoreError(
      "legacy_binding_integrity_conflict",
      `Legacy Happier CLI Session ${source.cliSessionId} metadata does not match the import snapshot`,
    );
  }
}

export async function loadRoomAggregateProjection(
  handle: QueryHandle,
  projectId: string,
  roomId: string,
): Promise<RoomAggregateV1 | undefined> {
  const rooms = await handle
    .select()
    .from(operationalRooms)
    .where(and(eq(operationalRooms.id, roomId), eq(operationalRooms.projectId, projectId)))
    .limit(1);
  const row = rooms[0];
  if (!row) return undefined;

  const seatRows = await handle
    .select()
    .from(roomSeats)
    .where(and(eq(roomSeats.roomId, roomId), eq(roomSeats.projectId, projectId)))
    .orderBy(asc(roomSeats.createdAt), asc(roomSeats.id));
  const bindingRows = await handle
    .select()
    .from(roomBindings)
    .where(and(eq(roomBindings.roomId, roomId), eq(roomBindings.projectId, projectId)))
    .orderBy(asc(roomBindings.seatId), asc(roomBindings.generation));
  const turnRows = await handle
    .select()
    .from(roomTurns)
    .where(and(eq(roomTurns.roomId, roomId), eq(roomTurns.projectId, projectId)))
    .orderBy(asc(roomTurns.sequence));
  const membershipRows = await handle
    .select()
    .from(roomMembershipChanges)
    .where(
      and(
        eq(roomMembershipChanges.roomId, roomId),
        eq(roomMembershipChanges.projectId, projectId),
        eq(roomMembershipChanges.state, "waiting_turn_boundary"),
      ),
    )
    .orderBy(asc(roomMembershipChanges.requestedAt), asc(roomMembershipChanges.id));

  return {
    room: {
      contractVersion: 1,
      id: row.id,
      projectId: row.projectId,
      objective: row.objective,
      protocolId: row.protocolId,
      protocolVersion: row.protocolVersion,
      state: row.lifecycleState as RoomAggregateV1["room"]["state"],
      aggregateVersion: Number(row.aggregateVersion),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
    membershipVersion: Number(row.membershipVersion),
    activeTurnId: row.activeTurnId,
    seats: seatRows.map((seat) => ({
      contractVersion: 1,
      id: seat.id,
      roomId: seat.roomId,
      role: seat.role,
      state: seat.state as RoomAggregateV1["seats"][number]["state"],
      permissionScope: asStringArray(seat.permissionScope),
      activeBindingId: seat.activeBindingId,
      roleVersion: seat.roleVersion,
      createdAt: seat.createdAt,
      updatedAt: seat.updatedAt,
    })),
    bindings: bindingRows.map((binding) => ({
      contractVersion: 1,
      id: binding.id,
      roomId: binding.roomId,
      seatId: binding.seatId,
      generation: binding.generation,
      connectorId: binding.connectorId,
      providerId: binding.providerId,
      nativeSessionId: binding.nativeSessionId,
      happierSessionId: binding.happierSessionId,
      serverProfileId: binding.serverProfileId,
      machineId: binding.machineId,
      hostId: binding.hostId,
      state: binding.state as RoomAggregateV1["bindings"][number]["state"],
      attachedAt: binding.attachedAt,
      detachedAt: binding.detachedAt,
      replacedByBindingId: binding.replacedByBindingId,
    })),
    turns: turnRows.map((turn) => ({
      contractVersion: 1,
      id: turn.id,
      roomId: turn.roomId,
      sequence: Number(turn.sequence),
      protocolPhaseId: turn.protocolPhaseId,
      membershipVersion: Number(turn.membershipVersion),
      state: turn.state as RoomAggregateV1["turns"][number]["state"],
      startedAt: turn.startedAt,
      endedAt: turn.endedAt,
    })),
    pendingMembershipChanges: membershipRows.map(rowToPendingMembershipChange),
  };
}

const ROOM_TASK_NODE_STATES = new Set<RoomTaskNodeState>([
  "pending",
  "ready",
  "running",
  "waiting_dependency",
  "waiting_approval",
  "rate_limited",
  "retrying",
  "accepted",
  "blocked",
  "failed",
  "cancelled",
]);

const ROOM_TASK_EVENT_ACTOR_TYPES = new Set<RoomEventActorType>([
  "human",
  "controller",
  "seat",
  "system",
  "evolution",
]);
const MAX_TASK_GRAPH_MUTATIONS_PER_COMMAND = 64;
const MAX_TASK_GRAPH_RUNTIME_ARRAY_ENTRIES = 256;
const MAX_TASK_GRAPH_RUNTIME_OBJECT_KEYS = 32;
const MAX_TASK_GRAPH_RUNTIME_DEPTH = 16;
const MAX_TASK_GRAPH_RUNTIME_VALUES = 4_096;
const MAX_TASK_GRAPH_RUNTIME_STRING_CODE_UNITS = 262_144;
const MAX_TASK_GRAPH_TOPOLOGY_CHILDREN = 16;
const MAX_TASK_GRAPH_TOPOLOGY_REWIRES = 64;
const MAX_TASK_GRAPH_TOPOLOGY_AFFECTED_NODES = 32;

interface RetiredRoomTaskEdgeV1 extends RoomTaskEdgeProjectionV1 {
  readonly retiredAt: string;
  readonly retiredByOperationId: string;
}

interface AppliedRoomTaskGraphMutationsV1 {
  readonly projection: RoomTaskGraphProjectionV1;
  readonly retiredEdges: readonly RetiredRoomTaskEdgeV1[];
}

const ROOM_TASK_ALLOWED_TRANSITIONS: Readonly<Record<RoomTaskNodeState, ReadonlySet<RoomTaskNodeState>>> = {
  pending: new Set(["ready", "waiting_dependency", "cancelled"]),
  ready: new Set([
    "running",
    "waiting_dependency",
    "waiting_approval",
    "rate_limited",
    "retrying",
    "accepted",
    "blocked",
    "failed",
    "cancelled",
  ]),
  running: new Set([
    "waiting_dependency",
    "waiting_approval",
    "rate_limited",
    "retrying",
    "accepted",
    "blocked",
    "failed",
    "cancelled",
  ]),
  waiting_dependency: new Set(["ready", "waiting_approval", "blocked", "failed", "cancelled"]),
  waiting_approval: new Set(["ready", "running", "blocked", "failed", "cancelled"]),
  rate_limited: new Set(["ready", "retrying", "blocked", "failed", "cancelled"]),
  retrying: new Set([
    "ready",
    "running",
    "waiting_dependency",
    "waiting_approval",
    "rate_limited",
    "accepted",
    "blocked",
    "failed",
    "cancelled",
  ]),
  accepted: new Set(),
  blocked: new Set(["retrying", "failed", "cancelled"]),
  failed: new Set(["retrying", "cancelled"]),
  cancelled: new Set(),
};

interface TaskGraphRuntimeBudget {
  valueCount: number;
  stringCodeUnits: number;
}

function normalizeTaskGraphRuntimeCommand(
  rawInput: unknown,
  rawContext: unknown,
): { readonly input: MutateRoomTaskGraphInputV1; readonly context: RoomCommandContext } {
  try {
    const budget: TaskGraphRuntimeBudget = { valueCount: 0, stringCodeUnits: 0 };
    const inputValue = cloneTaskGraphRuntimeValue(rawInput, "input", budget, new WeakSet(), 0);
    const contextValue = cloneTaskGraphRuntimeValue(rawContext, "context", budget, new WeakSet(), 0);
    if (!isRuntimeRecord(inputValue) || !isRuntimeRecord(contextValue)) {
      throw new RoomStoreError(
        "task_graph_invalid_mutation",
        "Task-graph input and context must be plain objects",
      );
    }
    const input = inputValue as unknown as MutateRoomTaskGraphInputV1;
    const context = contextValue as unknown as RoomCommandContext;
    validateTaskGraphCommand(input, context);
    return { input, context };
  } catch (error) {
    if (error instanceof RoomStoreError) throw error;
    throw new RoomStoreError(
      "task_graph_invalid_mutation",
      "Task-graph input or context contains inaccessible or malformed runtime data",
    );
  }
}

function cloneTaskGraphRuntimeValue(
  value: unknown,
  label: string,
  budget: TaskGraphRuntimeBudget,
  ancestors: WeakSet<object>,
  depth: number,
): unknown {
  budget.valueCount += 1;
  if (budget.valueCount > MAX_TASK_GRAPH_RUNTIME_VALUES || depth > MAX_TASK_GRAPH_RUNTIME_DEPTH) {
    throw new RoomStoreError("task_graph_invalid_mutation", `${label} exceeds the command shape limit`);
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    budget.stringCodeUnits += value.length;
    if (budget.stringCodeUnits > MAX_TASK_GRAPH_RUNTIME_STRING_CODE_UNITS) {
      throw new RoomStoreError("task_graph_invalid_mutation", `${label} exceeds the command text limit`);
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new RoomStoreError("task_graph_invalid_mutation", `${label} must be a finite number`);
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new RoomStoreError("task_graph_invalid_mutation", `${label} contains an unsupported value`);
  }
  if (isProxy(value)) {
    throw new RoomStoreError("task_graph_invalid_mutation", `${label} must not contain a Proxy`);
  }
  if (ancestors.has(value)) {
    throw new RoomStoreError("task_graph_invalid_mutation", `${label} must not contain a cycle`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new RoomStoreError("task_graph_invalid_mutation", `${label} must be a plain array`);
      }
      if (value.length > MAX_TASK_GRAPH_RUNTIME_ARRAY_ENTRIES) {
        throw new RoomStoreError("task_graph_invalid_mutation", `${label} exceeds the array limit`);
      }
      const ownKeys = Reflect.ownKeys(value);
      if (
        ownKeys.length !== value.length + 1
        || ownKeys.some((key) =>
          typeof key !== "string"
          || (key !== "length" && !/^(0|[1-9]\d*)$/.test(key))
          || (key !== "length" && Number(key) >= value.length))
      ) {
        throw new RoomStoreError("task_graph_invalid_mutation", `${label} must not contain extra array properties`);
      }
      const cloned: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (
          !descriptor
          || !Object.hasOwn(descriptor, "value")
          || descriptor.enumerable !== true
        ) {
          throw new RoomStoreError(
            "task_graph_invalid_mutation",
            `${label} must contain only enumerable data entries and must not be sparse`,
          );
        }
        cloned.push(cloneTaskGraphRuntimeValue(
          descriptor.value,
          `${label}[${index}]`,
          budget,
          ancestors,
          depth + 1,
        ));
      }
      return cloned;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new RoomStoreError("task_graph_invalid_mutation", `${label} must be a plain object`);
    }
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length > MAX_TASK_GRAPH_RUNTIME_OBJECT_KEYS
      || ownKeys.some((key) => typeof key !== "string")
    ) {
      throw new RoomStoreError("task_graph_invalid_mutation", `${label} exceeds the object shape limit`);
    }
    const cloned = Object.create(null) as Record<string, unknown>;
    for (const key of ownKeys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new RoomStoreError(
          "task_graph_invalid_mutation",
          `${label}.${key} must be an enumerable data property`,
        );
      }
      cloned[key] = cloneTaskGraphRuntimeValue(
        descriptor.value,
        `${label}.${key}`,
        budget,
        ancestors,
        depth + 1,
      );
    }
    return cloned;
  } finally {
    ancestors.delete(value);
  }
}

function validateTaskGraphCommand(
  input: MutateRoomTaskGraphInputV1,
  context: RoomCommandContext,
): void {
  assertTaskGraphObjectKeys(input, [
    "roomId",
    "expectedAggregateVersion",
    "expectedDagVersion",
    "idempotencyKey",
    "mutations",
    "mutatedAt",
    ...(input.expectedNodeVersions === undefined ? [] : ["expectedNodeVersions"]),
  ], "input");
  assertTaskGraphObjectKeys(context, context.eventId === undefined
    ? ["actorType", "actorId", "correlationId", "causationId", "occurredAt"]
    : ["eventId", "actorType", "actorId", "correlationId", "causationId", "occurredAt"], "context");
  assertNonBlankTaskGraphString(input.roomId, "roomId");
  assertNonBlankTaskGraphString(input.idempotencyKey, "idempotencyKey");
  assertTaskGraphVersion(input.expectedAggregateVersion, "expectedAggregateVersion");
  assertTaskGraphVersion(input.expectedDagVersion, "expectedDagVersion");
  assertTaskGraphTimestamp(input.mutatedAt, "mutatedAt");
  if (!ROOM_TASK_EVENT_ACTOR_TYPES.has(context.actorType)) {
    throw new RoomStoreError("task_graph_invalid_mutation", "context.actorType is unsupported");
  }
  if (context.eventId !== undefined) assertNonBlankTaskGraphString(context.eventId, "context.eventId");
  assertNonBlankTaskGraphString(context.actorId, "context.actorId");
  assertNonBlankTaskGraphString(context.correlationId, "context.correlationId");
  assertNullableTaskGraphString(context.causationId, "context.causationId");
  assertTaskGraphTimestamp(context.occurredAt, "context.occurredAt");
  if (context.occurredAt !== input.mutatedAt) {
    throw new RoomStoreError(
      "task_graph_invalid_mutation",
      "Task-graph mutatedAt must equal the immutable Room event occurredAt",
    );
  }
  if (!Array.isArray(input.mutations) || input.mutations.length === 0) {
    throw new RoomStoreError(
      "task_graph_invalid_mutation",
      "A task-graph command must contain at least one mutation",
    );
  }
  if (input.mutations.length > MAX_TASK_GRAPH_MUTATIONS_PER_COMMAND) {
    throw new RoomStoreError(
      "task_graph_invalid_mutation",
      `A task-graph command may contain at most ${MAX_TASK_GRAPH_MUTATIONS_PER_COMMAND} mutations`,
    );
  }
  for (const [index, mutation] of input.mutations.entries()) {
    if (!isRuntimeRecord(mutation) || !isNonEmptyString(mutation.action)) {
      throw new RoomStoreError(
        "task_graph_invalid_mutation",
        `mutations[${index}] must be a typed object`,
      );
    }
    assertTaskGraphTopologyMutationRuntimeShape(
      mutation as unknown as RoomTaskGraphMutationV1,
      index,
    );
  }
  const exclusiveTopologyMutations = input.mutations.filter((mutation) =>
    mutation.action === "split_node"
    || mutation.action === "merge_nodes"
    || mutation.action === "cancel_node");
  const hasRemoveEdge = input.mutations.some((mutation) => mutation.action === "remove_edge");
  const hasTopologyMutation = exclusiveTopologyMutations.length > 0 || hasRemoveEdge;
  if (hasTopologyMutation) {
    if (exclusiveTopologyMutations.length > 0 && input.mutations.length !== 1) {
      throw new RoomStoreError(
        "task_graph_invalid_mutation",
        "split_node, merge_nodes, and cancel_node must each be the only mutation in their command",
      );
    }
    if (hasRemoveEdge) {
      if (input.mutations.some((mutation) =>
        mutation.action !== "remove_edge" && mutation.action !== "add_edge")) {
        throw new RoomStoreError(
          "task_graph_invalid_mutation",
          "remove_edge may pair only with add_edge",
        );
      }
      let reachedAdd = false;
      for (const mutation of input.mutations) {
        if (mutation.action === "add_edge") reachedAdd = true;
        if (mutation.action === "remove_edge" && reachedAdd) {
          throw new RoomStoreError(
            "task_graph_invalid_mutation",
            "remove_edge mutations must precede every paired add_edge",
          );
        }
      }
    }
    assertTaskGraphExpectedNodeVersions(input.expectedNodeVersions);
  } else if (input.expectedNodeVersions !== undefined) {
    throw new RoomStoreError(
      "task_graph_invalid_mutation",
      "expectedNodeVersions is reserved for topology commands",
    );
  }
}

function assertTaskGraphTopologyMutationRuntimeShape(
  mutation: RoomTaskGraphMutationV1,
  index: number,
): void {
  const label = `mutations[${index}]`;
  switch (mutation.action) {
    case "split_node": {
      assertTaskGraphMutationKeys(
        mutation,
        ["action", "nodeId", "children", "causalEvidenceIds", "reason"],
        label,
      );
      assertNonBlankTaskGraphString(mutation.nodeId, `${label}.nodeId`);
      assertNonBlankTaskGraphString(mutation.reason, `${label}.reason`);
      assertTaskGraphStringArray(mutation.causalEvidenceIds, `${label}.causalEvidenceIds`, false);
      if (!Array.isArray(mutation.children)) {
        throw new RoomStoreError("task_graph_invalid_mutation", `${label}.children must be an array`);
      }
      for (const [childIndex, child] of mutation.children.entries()) {
        if (!isRuntimeRecord(child)) {
          throw new RoomStoreError(
            "task_graph_invalid_mutation",
            `${label}.children[${childIndex}] must be an object`,
          );
        }
        assertNonBlankTaskGraphString(child.id, `${label}.children[${childIndex}].id`);
      }
      return;
    }
    case "merge_nodes": {
      assertTaskGraphMutationKeys(
        mutation,
        ["action", "nodeIds", "mergedNode", "causalEvidenceIds", "reason"],
        label,
      );
      assertTaskGraphStringArray(mutation.nodeIds, `${label}.nodeIds`, false);
      assertNonBlankTaskGraphString(mutation.reason, `${label}.reason`);
      assertTaskGraphStringArray(mutation.causalEvidenceIds, `${label}.causalEvidenceIds`, false);
      if (!isRuntimeRecord(mutation.mergedNode)) {
        throw new RoomStoreError("task_graph_invalid_mutation", `${label}.mergedNode must be an object`);
      }
      assertNonBlankTaskGraphString(mutation.mergedNode.id, `${label}.mergedNode.id`);
      return;
    }
    case "cancel_node":
      assertTaskGraphMutationKeys(
        mutation,
        ["action", "nodeId", "causalEvidenceIds", "reason"],
        label,
      );
      assertNonBlankTaskGraphString(mutation.nodeId, `${label}.nodeId`);
      assertNonBlankTaskGraphString(mutation.reason, `${label}.reason`);
      assertTaskGraphStringArray(mutation.causalEvidenceIds, `${label}.causalEvidenceIds`, false);
      return;
    case "remove_edge":
      assertTaskGraphMutationKeys(
        mutation,
        ["action", "edgeId", "causalEvidenceIds", "reason"],
        label,
      );
      assertNonBlankTaskGraphString(mutation.edgeId, `${label}.edgeId`);
      assertNonBlankTaskGraphString(mutation.reason, `${label}.reason`);
      assertTaskGraphStringArray(mutation.causalEvidenceIds, `${label}.causalEvidenceIds`, false);
      return;
    default:
      return;
  }
}

function buildTaskGraphTopologyOperationId(
  input: MutateRoomTaskGraphInputV1,
  commandHash: string,
): string | null {
  const topologyMutations = input.mutations.filter((mutation) =>
    mutation.action === "split_node"
    || mutation.action === "merge_nodes"
    || mutation.action === "cancel_node"
    || mutation.action === "remove_edge");
  if (topologyMutations.length === 0) return null;
  return `room-task-topology:${hashRoomValue({
    version: 1,
    commandHash,
    idempotencyKey: input.idempotencyKey,
    topology: topologyMutations.map((mutation) => mutation.action === "split_node"
      ? {
          action: mutation.action,
          nodeId: mutation.nodeId,
          childNodeIds: mutation.children.map((child) => child.id).sort(compareRoomText),
        }
      : mutation.action === "merge_nodes" ? {
          action: mutation.action,
          nodeIds: [...mutation.nodeIds].sort(compareRoomText),
          mergedNodeId: mutation.mergedNode.id,
        } : mutation.action === "cancel_node" ? {
          action: mutation.action,
          nodeId: mutation.nodeId,
        } : {
          action: mutation.action,
          edgeId: mutation.edgeId,
        }),
  })}`;
}

function collectTaskGraphTopologyCausalEvidenceIds(
  mutations: readonly RoomTaskGraphMutationV1[],
): readonly string[] {
  return [...new Set(mutations.flatMap((mutation) => {
    switch (mutation.action) {
      case "split_node":
      case "merge_nodes":
      case "cancel_node":
      case "remove_edge":
        return [...mutation.causalEvidenceIds];
      default:
        return [];
    }
  }))].sort(compareRoomText);
}

function buildTaskGraphDerivedEdgeId(
  operationId: string,
  edge: Pick<RoomTaskEdgeDefinitionV1, "fromNodeId" | "toNodeId" | "kind">,
  derivedFromEdgeIds: readonly string[],
): string {
  return `room-task-edge:${hashRoomValue({
    version: 1,
    operationId,
    topology: {
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
      kind: edge.kind,
    },
    derivedFromEdgeIds: [...derivedFromEdgeIds].sort(compareRoomText),
  })}`;
}

function assertTaskGraphExpectedNodeVersions(
  value: unknown,
): asserts value is Readonly<Record<string, number>> {
  if (!isRuntimeRecord(value)) {
    throw new RoomStoreError(
      "task_graph_invalid_mutation",
      "Topology commands require expectedNodeVersions",
    );
  }
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > MAX_TASK_GRAPH_TOPOLOGY_AFFECTED_NODES) {
    throw new RoomStoreError(
      "task_graph_invalid_mutation",
      `Topology commands require 1-${MAX_TASK_GRAPH_TOPOLOGY_AFFECTED_NODES} node versions`,
    );
  }
  for (const [nodeId, version] of entries) {
    assertNonBlankTaskGraphString(nodeId, "expectedNodeVersions nodeId");
    assertTaskGraphVersion(version, `expectedNodeVersions.${nodeId}`);
  }
}

function assertTaskGraphAffectedNodeVersions(
  expectedNodeVersions: Readonly<Record<string, number>> | undefined,
  affectedNodeIds: ReadonlySet<string>,
  nodes: ReadonlyMap<string, RoomTaskNodeProjectionV1>,
): void {
  assertTaskGraphExpectedNodeVersions(expectedNodeVersions);
  const expectedIds = Object.keys(expectedNodeVersions).sort(compareRoomText);
  const actualIds = [...affectedNodeIds].sort(compareRoomText);
  if (
    expectedIds.length !== actualIds.length
    || expectedIds.some((nodeId, index) => nodeId !== actualIds[index])
  ) {
    throw new RoomStoreError(
      "task_node_version_conflict",
      "Topology command must CAS every and only affected existing task node",
    );
  }
  for (const nodeId of actualIds) {
    const node = requireTaskGraphNode(nodes, nodeId);
    if (expectedNodeVersions[nodeId] !== node.nodeVersion) {
      throw new RoomStoreError(
        "task_node_version_conflict",
        `Task node ${nodeId} expected version ${String(expectedNodeVersions[nodeId])} but is ${node.nodeVersion}`,
      );
    }
  }
}

function assertTopologySourceMutable(
  source: RoomTaskNodeProjectionV1,
  action: "split" | "merge" | "cancel",
): void {
  if (["accepted", "cancelled", "running", "retrying"].includes(source.state)) {
    throw new RoomStoreError(
      source.state === "accepted" ? "accepted_node_frozen" : "task_graph_invalid_mutation",
      `Task node ${source.id} in state ${source.state} cannot be a ${action} source`,
    );
  }
}

function assertAcceptedIncidentNeighborsMutable(
  sourceNodeId: string,
  incidentEdges: readonly RoomTaskEdgeProjectionV1[],
  nodes: ReadonlyMap<string, RoomTaskNodeProjectionV1>,
  action: "split" | "merge" | "cancel",
): void {
  for (const edge of incidentEdges) {
    const neighborId = edge.fromNodeId === sourceNodeId ? edge.toNodeId : edge.fromNodeId;
    const neighbor = requireTaskGraphNode(nodes, neighborId);
    if (neighbor.state === "accepted") {
      throw new RoomStoreError(
        "accepted_node_frozen",
        `${action} would change accepted incident node ${neighbor.id}`,
      );
    }
  }
}

function normalizeTaskTopologyNodeDefinition(
  value: unknown,
  parentNodeId: string | null,
  label: string,
): RoomTaskNodeDefinitionV1 {
  const record = asRecord(value);
  assertTaskGraphObjectKeys(record, [
    "id",
    "objective",
    "inputRefs",
    "outputRefs",
    "roleRequirements",
    "capabilityRequirements",
    "resourceHints",
    "authorityScope",
    "acceptanceGateIds",
    "retryPolicy",
    "progressSignature",
  ], label);
  return normalizeTaskNodeDefinition({ ...record, parentNodeId }, label);
}

function applyTaskGraphMutations(
  current: RoomTaskGraphProjectionV1,
  input: MutateRoomTaskGraphInputV1,
  topologyOperationId: string | null,
): AppliedRoomTaskGraphMutationsV1 {
  const nextAggregateVersion = advanceTaskGraphVersion(
    current.aggregateVersion,
    "aggregateVersion",
  );
  const nextDagVersion = advanceTaskGraphVersion(current.dagVersion, "dagVersion");
  const nodes = new Map(
    current.nodes.map((node) => [node.id, cloneTaskGraphNode(node)] as const),
  );
  const edges = new Map(
    current.edges.map((edge) => [edge.id, {
      ...edge,
      derivedFromEdgeIds: [...edge.derivedFromEdgeIds],
    }] as const),
  );
  const originalEdgeIds = new Set(current.edges.map((edge) => edge.id));
  const originalNodeIds = new Set(nodes.keys());
  const directlyVersionedNodeIds = new Set<string>();
  const retiredEdges: RetiredRoomTaskEdgeV1[] = [];

  for (const rawMutation of input.mutations) {
    if (!rawMutation || typeof rawMutation !== "object" || !("action" in rawMutation)) {
      throw new RoomStoreError("task_graph_invalid_mutation", "Task-graph mutation must be a typed object");
    }
    const mutation = rawMutation as RoomTaskGraphMutationV1;
    switch (mutation.action) {
      case "add_node": {
        assertTaskGraphMutationKeys(mutation, ["action", "node"], "add_node");
        const definition = normalizeTaskNodeDefinition(mutation.node, "add_node.node");
        if (nodes.has(definition.id)) {
          throw new RoomStoreError(
            "task_graph_invalid_mutation",
            `Task node ${definition.id} already exists`,
          );
        }
        if (definition.parentNodeId) {
          const parent = nodes.get(definition.parentNodeId);
          if (!parent) {
            throw new RoomStoreError(
              "task_graph_unknown_node",
              `Task node ${definition.id} references unknown parent ${definition.parentNodeId}`,
            );
          }
          if (parent.terminalLineage !== null) {
            throw new RoomStoreError(
              "task_graph_invalid_mutation",
              `Terminal topology node ${parent.id} cannot receive new child topology`,
            );
          }
          if (parent.state === "accepted") {
            throw new RoomStoreError(
              "accepted_node_frozen",
              `Accepted parent node ${parent.id} cannot receive new child topology`,
            );
          }
        }
        nodes.set(definition.id, {
          ...definition,
          state: "pending",
          nodeVersion: 0,
          acceptedAt: null,
          acceptanceEvidenceIds: [],
          invalidatedByEvidenceId: null,
          reopenedByEvidenceId: null,
          origin: { kind: "created" },
          terminalLineage: null,
        });
        break;
      }
      case "add_edge": {
        assertTaskGraphMutationKeys(mutation, ["action", "edge"], "add_edge");
        const edge = normalizeTaskEdgeDefinition(mutation.edge, "add_edge.edge");
        if (edges.has(edge.id) || originalEdgeIds.has(edge.id)) {
          throw new RoomStoreError(
            "task_graph_invalid_mutation",
            `Task edge ${edge.id} already exists`,
          );
        }
        const from = nodes.get(edge.fromNodeId);
        const to = nodes.get(edge.toNodeId);
        if (!from || !to) {
          throw new RoomStoreError(
            "task_graph_unknown_node",
            `Task edge ${edge.id} references an unknown Room task node`,
          );
        }
        if (edge.fromNodeId === edge.toNodeId) {
          throw new RoomStoreError(
            "task_graph_self_edge",
            `Task edge ${edge.id} cannot reference the same node twice`,
          );
        }
        if (from.state === "accepted" || to.state === "accepted") {
          throw new RoomStoreError(
            "accepted_node_frozen",
            `Task edge ${edge.id} would change accepted-node topology`,
          );
        }
        if (from.terminalLineage !== null || to.terminalLineage !== null) {
          throw new RoomStoreError(
            "task_graph_invalid_mutation",
            `Task edge ${edge.id} cannot attach to a terminal topology tombstone`,
          );
        }
        if ([...edges.values()].some((candidate) =>
          candidate.fromNodeId === edge.fromNodeId
          && candidate.toNodeId === edge.toNodeId
          && candidate.kind === edge.kind
        )) {
          throw new RoomStoreError(
            "task_graph_invalid_mutation",
            `Task edge shape ${edge.fromNodeId}->${edge.toNodeId}:${edge.kind} already exists`,
          );
        }
        if (
          edge.kind === "requires"
          && !["pending", "ready", "waiting_dependency"].includes(to.state)
        ) {
          throw new RoomStoreError(
            "task_graph_invalid_mutation",
            `Unsatisfied requires edge ${edge.id} cannot target active task node ${to.id} in state ${to.state}`,
          );
        }
        edges.set(edge.id, { ...edge, createdByOperationId: null, derivedFromEdgeIds: [] });
        assertTaskGraphAcyclic(nodes, edges);
        break;
      }
      case "update_node": {
        assertTaskGraphMutationKeys(mutation, [
          "action",
          "nodeId",
          "expectedNodeVersion",
          "patch",
          "evidenceIds",
        ], "update_node");
        const node = requireTaskGraphNode(nodes, mutation.nodeId);
        assertTaskNodeVersion(node, mutation.expectedNodeVersion);
        if (node.state === "accepted") {
          throw new RoomStoreError(
            "accepted_node_frozen",
            `Accepted task node ${node.id} cannot be updated without causal reopen`,
          );
        }
        if (node.terminalLineage !== null) {
          throw new RoomStoreError(
            "task_graph_invalid_mutation",
            `Terminal topology node ${node.id} cannot be updated`,
          );
        }
        const patch = asRecord(mutation.patch);
        const patchKeys = Object.keys(patch);
        const allowedPatchKeys = new Set([
          "objective",
          "inputRefs",
          "outputRefs",
          "roleRequirements",
          "capabilityRequirements",
          "resourceHints",
          "authorityScope",
          "acceptanceGateIds",
          "retryPolicy",
          "progressSignature",
        ]);
        if (patchKeys.length === 0 || patchKeys.some((key) => !allowedPatchKeys.has(key))) {
          throw new RoomStoreError(
            "task_graph_invalid_mutation",
            `Task node ${node.id} update contains no supported patch`,
          );
        }
        assertTaskGraphStringArray(mutation.evidenceIds, "update_node.evidenceIds", false);
        const definition = normalizeTaskNodeDefinition({
          id: node.id,
          parentNodeId: node.parentNodeId,
          objective: patch.objective ?? node.objective,
          inputRefs: patch.inputRefs ?? node.inputRefs,
          outputRefs: patch.outputRefs ?? node.outputRefs,
          roleRequirements: patch.roleRequirements ?? node.roleRequirements,
          capabilityRequirements: patch.capabilityRequirements ?? node.capabilityRequirements,
          resourceHints: patch.resourceHints ?? node.resourceHints,
          authorityScope: patch.authorityScope ?? node.authorityScope,
          acceptanceGateIds: patch.acceptanceGateIds ?? node.acceptanceGateIds,
          retryPolicy: patch.retryPolicy ?? node.retryPolicy,
          progressSignature: patch.progressSignature ?? node.progressSignature,
        }, `update_node:${node.id}`);
        nodes.set(node.id, {
          ...node,
          ...definition,
          nodeVersion: advanceTaskGraphVersion(node.nodeVersion, `nodeVersion:${node.id}`),
        });
        directlyVersionedNodeIds.add(node.id);
        break;
      }
      case "transition_node": {
        assertTaskGraphMutationKeys(mutation, [
          "action",
          "nodeId",
          "expectedNodeVersion",
          "to",
          "acceptanceEvidenceIds",
          "progressSignature",
        ], "transition_node");
        const node = requireTaskGraphNode(nodes, mutation.nodeId);
        assertTaskNodeVersion(node, mutation.expectedNodeVersion);
        if (node.state === "accepted") {
          throw new RoomStoreError(
            "accepted_node_frozen",
            `Accepted task node ${node.id} requires explicit causal reopen`,
          );
        }
        if (!ROOM_TASK_NODE_STATES.has(mutation.to)) {
          throw new RoomStoreError(
            "task_graph_invalid_mutation",
            `Task node ${node.id} has unsupported target state ${String(mutation.to)}`,
          );
        }
        if (!ROOM_TASK_ALLOWED_TRANSITIONS[node.state].has(mutation.to)) {
          throw new RoomStoreError(
            "task_graph_invalid_mutation",
            `Task node ${node.id} cannot transition from ${node.state} to ${mutation.to}`,
          );
        }
        assertNonBlankTaskGraphString(mutation.progressSignature, "transition_node.progressSignature");
        const evidenceIds = assertTaskGraphStringArray(
          mutation.acceptanceEvidenceIds,
          "transition_node.acceptanceEvidenceIds",
          mutation.to !== "accepted",
        );
        if (mutation.to !== "accepted" && evidenceIds.length > 0) {
          throw new RoomStoreError(
            "task_graph_invalid_mutation",
            `Non-accepted task node ${node.id} cannot claim acceptance evidence`,
          );
        }
        if (mutation.to === "accepted" && !taskNodeDependenciesSatisfied(node.id, nodes, edges)) {
          throw new RoomStoreError(
            "task_graph_invalid_mutation",
            `Task node ${node.id} cannot be accepted before every required predecessor`,
          );
        }
        nodes.set(node.id, {
          ...node,
          state: mutation.to,
          nodeVersion: advanceTaskGraphVersion(node.nodeVersion, `nodeVersion:${node.id}`),
          progressSignature: mutation.progressSignature,
          acceptedAt: mutation.to === "accepted" ? input.mutatedAt : null,
          acceptanceEvidenceIds: mutation.to === "accepted" ? evidenceIds : [],
          invalidatedByEvidenceId: null,
        });
        directlyVersionedNodeIds.add(node.id);
        break;
      }
      case "invalidate_acceptance_evidence": {
        assertTaskGraphMutationKeys(mutation, [
          "action",
          "nodeId",
          "expectedNodeVersion",
          "acceptanceEvidenceId",
          "invalidatedByEvidenceId",
          "reason",
        ], "invalidate_acceptance_evidence");
        const node = requireTaskGraphNode(nodes, mutation.nodeId);
        assertTaskNodeVersion(node, mutation.expectedNodeVersion);
        assertNonBlankTaskGraphString(mutation.acceptanceEvidenceId, "acceptanceEvidenceId");
        assertNonBlankTaskGraphString(mutation.invalidatedByEvidenceId, "invalidatedByEvidenceId");
        assertNonBlankTaskGraphString(mutation.reason, "invalidation.reason");
        if (
          node.state !== "accepted"
          || !node.acceptanceEvidenceIds.includes(mutation.acceptanceEvidenceId)
          || node.invalidatedByEvidenceId !== null
        ) {
          throw new RoomStoreError(
            "task_graph_invalid_mutation",
            `Task node ${node.id} has no active accepted evidence ${mutation.acceptanceEvidenceId} to invalidate`,
          );
        }
        nodes.set(node.id, {
          ...node,
          nodeVersion: advanceTaskGraphVersion(node.nodeVersion, `nodeVersion:${node.id}`),
          invalidatedByEvidenceId: mutation.invalidatedByEvidenceId,
        });
        directlyVersionedNodeIds.add(node.id);
        break;
      }
      case "reopen_node": {
        assertTaskGraphMutationKeys(mutation, [
          "action",
          "nodeId",
          "expectedNodeVersion",
          "upstreamNodeId",
          "invalidatedByEvidenceId",
          "reason",
        ], "reopen_node");
        const node = requireTaskGraphNode(nodes, mutation.nodeId);
        const upstream = requireTaskGraphNode(nodes, mutation.upstreamNodeId);
        assertTaskNodeVersion(node, mutation.expectedNodeVersion);
        assertNonBlankTaskGraphString(mutation.invalidatedByEvidenceId, "reopen.invalidatedByEvidenceId");
        assertNonBlankTaskGraphString(mutation.reason, "reopen.reason");
        if (
          node.state !== "accepted"
          || upstream.invalidatedByEvidenceId !== mutation.invalidatedByEvidenceId
          || (upstream.id !== node.id && !hasRequiresPath(upstream.id, node.id, edges))
        ) {
          throw new RoomStoreError(
            "reopen_requires_invalidated_upstream",
            `Task node ${node.id} is not causally downstream of invalidated node ${upstream.id}`,
          );
        }
        nodes.set(node.id, {
          ...node,
          state: "waiting_dependency",
          nodeVersion: advanceTaskGraphVersion(node.nodeVersion, `nodeVersion:${node.id}`),
          acceptedAt: null,
          acceptanceEvidenceIds: [],
          invalidatedByEvidenceId: null,
          reopenedByEvidenceId: mutation.invalidatedByEvidenceId,
        });
        directlyVersionedNodeIds.add(node.id);
        break;
      }
      case "split_node": {
        assertTaskGraphMutationKeys(mutation, [
          "action",
          "nodeId",
          "children",
          "causalEvidenceIds",
          "reason",
        ], "split_node");
        if (!topologyOperationId) {
          throw new RoomStoreError(
            "task_graph_invalid_mutation",
            "split_node requires a deterministic topology operation",
          );
        }
        assertNonBlankTaskGraphString(mutation.reason, "split_node.reason");
        if (
          !Array.isArray(mutation.children)
          || mutation.children.length < 2
          || mutation.children.length > MAX_TASK_GRAPH_TOPOLOGY_CHILDREN
        ) {
          throw new RoomStoreError(
            "task_graph_invalid_mutation",
            `split_node requires 2-${MAX_TASK_GRAPH_TOPOLOGY_CHILDREN} explicit children`,
          );
        }
        const source = requireTaskGraphNode(nodes, mutation.nodeId);
        assertTopologySourceMutable(source, "split");
        const incidentEdges = [...edges.values()]
          .filter((edge) => edge.fromNodeId === source.id || edge.toNodeId === source.id)
          .sort((left, right) => compareRoomText(left.id, right.id));
        assertAcceptedIncidentNeighborsMutable(source.id, incidentEdges, nodes, "split");
        const affectedNodeIds = new Set<string>([source.id]);
        for (const edge of incidentEdges) {
          affectedNodeIds.add(edge.fromNodeId);
          affectedNodeIds.add(edge.toNodeId);
        }
        assertTaskGraphAffectedNodeVersions(input.expectedNodeVersions, affectedNodeIds, nodes);
        if (incidentEdges.length * mutation.children.length > MAX_TASK_GRAPH_TOPOLOGY_REWIRES) {
          throw new RoomStoreError(
            "task_graph_invalid_mutation",
            `split_node would exceed ${MAX_TASK_GRAPH_TOPOLOGY_REWIRES} derived edge rewires`,
          );
        }
        const childDefinitions = mutation.children.map((child, index) =>
          normalizeTaskTopologyNodeDefinition(child, source.id, `split_node.children[${index}]`));
        if (new Set(childDefinitions.map((child) => child.id)).size !== childDefinitions.length) {
          throw new RoomStoreError(
            "task_graph_invalid_mutation",
            "split_node child IDs must be unique",
          );
        }
        for (const child of childDefinitions) {
          if (nodes.has(child.id)) {
            throw new RoomStoreError(
              "task_graph_invalid_mutation",
              `split_node child ${child.id} already exists`,
            );
          }
        }
        const reasonHash = hashRoomValue(mutation.reason);
        nodes.set(source.id, {
          ...source,
          state: "cancelled",
          nodeVersion: advanceTaskGraphVersion(source.nodeVersion, `nodeVersion:${source.id}`),
          terminalLineage: {
            kind: "split",
            operationId: topologyOperationId,
            at: input.mutatedAt,
            reasonHash,
          },
        });
        directlyVersionedNodeIds.add(source.id);
        for (const child of childDefinitions) {
          nodes.set(child.id, {
            ...child,
            state: "pending",
            nodeVersion: 0,
            acceptedAt: null,
            acceptanceEvidenceIds: [],
            invalidatedByEvidenceId: null,
            reopenedByEvidenceId: null,
            origin: {
              kind: "split_child",
              operationId: topologyOperationId,
              sourceNodeIds: [source.id],
            },
            terminalLineage: null,
          });
        }
        for (const incident of incidentEdges) {
          edges.delete(incident.id);
          retiredEdges.push({
            ...incident,
            retiredAt: input.mutatedAt,
            retiredByOperationId: topologyOperationId,
          });
          for (const child of childDefinitions) {
            const derived = incident.fromNodeId === source.id
              ? {
                  fromNodeId: child.id,
                  toNodeId: incident.toNodeId,
                  kind: incident.kind,
                }
              : {
                  fromNodeId: incident.fromNodeId,
                  toNodeId: child.id,
                  kind: incident.kind,
                };
            const derivedFromEdgeIds = [incident.id];
            const edgeId = buildTaskGraphDerivedEdgeId(
              topologyOperationId,
              derived,
              derivedFromEdgeIds,
            );
            edges.set(edgeId, {
              id: edgeId,
              ...derived,
              createdByOperationId: topologyOperationId,
              derivedFromEdgeIds,
            });
          }
        }
        break;
      }
      case "merge_nodes": {
        assertTaskGraphMutationKeys(mutation, [
          "action",
          "nodeIds",
          "mergedNode",
          "causalEvidenceIds",
          "reason",
        ], "merge_nodes");
        if (!topologyOperationId) {
          throw new RoomStoreError(
            "task_graph_invalid_mutation",
            "merge_nodes requires a deterministic topology operation",
          );
        }
        assertNonBlankTaskGraphString(mutation.reason, "merge_nodes.reason");
        const sourceNodeIds = [...assertTaskGraphStringArray(
          mutation.nodeIds,
          "merge_nodes.nodeIds",
          false,
        )].sort(compareRoomText);
        if (
          sourceNodeIds.length < 2
          || sourceNodeIds.length > MAX_TASK_GRAPH_TOPOLOGY_CHILDREN
          || new Set(sourceNodeIds).size !== sourceNodeIds.length
        ) {
          throw new RoomStoreError(
            "task_graph_invalid_mutation",
            `merge_nodes requires 2-${MAX_TASK_GRAPH_TOPOLOGY_CHILDREN} unique source nodes`,
          );
        }
        const sources = sourceNodeIds.map((nodeId) => requireTaskGraphNode(nodes, nodeId));
        for (const source of sources) assertTopologySourceMutable(source, "merge");
        const commonParentNodeId = sources[0]!.parentNodeId;
        if (sources.some((source) => source.parentNodeId !== commonParentNodeId)) {
          throw new RoomStoreError(
            "task_graph_invalid_mutation",
            "merge_nodes sources must share the same parent",
          );
        }
        const commonParent = commonParentNodeId === null
          ? null
          : requireTaskGraphNode(nodes, commonParentNodeId);
        if (commonParent !== null && commonParent.terminalLineage !== null) {
          throw new RoomStoreError(
            "task_graph_invalid_mutation",
            `merge_nodes cannot add a result beneath terminal topology parent ${commonParent.id}`,
          );
        }
        if (commonParent?.state === "accepted") {
          throw new RoomStoreError(
            "accepted_node_frozen",
            `merge_nodes cannot add a result beneath accepted parent ${commonParent.id}`,
          );
        }
        const mergedDefinition = normalizeTaskTopologyNodeDefinition(
          mutation.mergedNode,
          commonParentNodeId,
          "merge_nodes.mergedNode",
        );
        if (nodes.has(mergedDefinition.id)) {
          throw new RoomStoreError(
            "task_graph_invalid_mutation",
            `merge_nodes result ${mergedDefinition.id} already exists`,
          );
        }
        const sourceSet = new Set(sourceNodeIds);
        const incidentEdges = [...edges.values()]
          .filter((edge) => sourceSet.has(edge.fromNodeId) || sourceSet.has(edge.toNodeId))
          .sort((left, right) => compareRoomText(left.id, right.id));
        for (const edge of incidentEdges) {
          for (const nodeId of [edge.fromNodeId, edge.toNodeId]) {
            if (!sourceSet.has(nodeId) && requireTaskGraphNode(nodes, nodeId).state === "accepted") {
              throw new RoomStoreError(
                "accepted_node_frozen",
                `merge would change accepted incident node ${nodeId}`,
              );
            }
          }
        }
        const affectedNodeIds = new Set(sourceNodeIds);
        if (commonParentNodeId !== null) affectedNodeIds.add(commonParentNodeId);
        for (const edge of incidentEdges) {
          affectedNodeIds.add(edge.fromNodeId);
          affectedNodeIds.add(edge.toNodeId);
        }
        assertTaskGraphAffectedNodeVersions(input.expectedNodeVersions, affectedNodeIds, nodes);
        if (incidentEdges.length > MAX_TASK_GRAPH_TOPOLOGY_REWIRES) {
          throw new RoomStoreError(
            "task_graph_invalid_mutation",
            `merge_nodes would exceed ${MAX_TASK_GRAPH_TOPOLOGY_REWIRES} edge rewires`,
          );
        }
        const reasonHash = hashRoomValue(mutation.reason);
        if (commonParent !== null) {
          nodes.set(commonParent.id, {
            ...commonParent,
            nodeVersion: advanceTaskGraphVersion(
              commonParent.nodeVersion,
              `nodeVersion:${commonParent.id}`,
            ),
          });
          directlyVersionedNodeIds.add(commonParent.id);
        }
        for (const source of sources) {
          nodes.set(source.id, {
            ...source,
            state: "cancelled",
            nodeVersion: advanceTaskGraphVersion(source.nodeVersion, `nodeVersion:${source.id}`),
            terminalLineage: {
              kind: "merge",
              operationId: topologyOperationId,
              at: input.mutatedAt,
              reasonHash,
            },
          });
          directlyVersionedNodeIds.add(source.id);
        }
        nodes.set(mergedDefinition.id, {
          ...mergedDefinition,
          state: "pending",
          nodeVersion: 0,
          acceptedAt: null,
          acceptanceEvidenceIds: [],
          invalidatedByEvidenceId: null,
          reopenedByEvidenceId: null,
          origin: {
            kind: "merge_result",
            operationId: topologyOperationId,
            sourceNodeIds,
          },
          terminalLineage: null,
        });
        const derivedShapes = new Map<string, {
          readonly fromNodeId: string;
          readonly toNodeId: string;
          readonly kind: RoomTaskEdgeKindV1;
          readonly derivedFromEdgeIds: string[];
        }>();
        for (const incident of incidentEdges) {
          edges.delete(incident.id);
          retiredEdges.push({
            ...incident,
            retiredAt: input.mutatedAt,
            retiredByOperationId: topologyOperationId,
          });
          if (sourceSet.has(incident.fromNodeId) && sourceSet.has(incident.toNodeId)) continue;
          const derived = sourceSet.has(incident.fromNodeId)
            ? {
                fromNodeId: mergedDefinition.id,
                toNodeId: incident.toNodeId,
                kind: incident.kind,
              }
            : {
                fromNodeId: incident.fromNodeId,
                toNodeId: mergedDefinition.id,
                kind: incident.kind,
              };
          const shape = `${derived.fromNodeId}\u0000${derived.toNodeId}\u0000${derived.kind}`;
          const grouped = derivedShapes.get(shape);
          if (grouped) {
            grouped.derivedFromEdgeIds.push(incident.id);
          } else {
            derivedShapes.set(shape, { ...derived, derivedFromEdgeIds: [incident.id] });
          }
        }
        for (const derived of [...derivedShapes.values()].sort((left, right) =>
          compareRoomText(
            `${left.fromNodeId}\u0000${left.toNodeId}\u0000${left.kind}`,
            `${right.fromNodeId}\u0000${right.toNodeId}\u0000${right.kind}`,
          ))) {
          derived.derivedFromEdgeIds.sort(compareRoomText);
          const edgeId = buildTaskGraphDerivedEdgeId(
            topologyOperationId,
            derived,
            derived.derivedFromEdgeIds,
          );
          edges.set(edgeId, {
            id: edgeId,
            ...derived,
            createdByOperationId: topologyOperationId,
          });
        }
        break;
      }
      case "cancel_node": {
        assertTaskGraphMutationKeys(
          mutation,
          ["action", "nodeId", "causalEvidenceIds", "reason"],
          "cancel_node",
        );
        if (!topologyOperationId) {
          throw new RoomStoreError(
            "task_graph_invalid_mutation",
            "cancel_node requires a deterministic topology operation",
          );
        }
        assertNonBlankTaskGraphString(mutation.reason, "cancel_node.reason");
        const source = requireTaskGraphNode(nodes, mutation.nodeId);
        assertTopologySourceMutable(source, "cancel");
        const incidentEdges = [...edges.values()]
          .filter((edge) => edge.fromNodeId === source.id || edge.toNodeId === source.id)
          .sort((left, right) => compareRoomText(left.id, right.id));
        assertAcceptedIncidentNeighborsMutable(source.id, incidentEdges, nodes, "cancel");
        const affectedNodeIds = new Set<string>([source.id]);
        for (const edge of incidentEdges) {
          affectedNodeIds.add(edge.fromNodeId);
          affectedNodeIds.add(edge.toNodeId);
        }
        assertTaskGraphAffectedNodeVersions(input.expectedNodeVersions, affectedNodeIds, nodes);
        nodes.set(source.id, {
          ...source,
          state: "cancelled",
          nodeVersion: advanceTaskGraphVersion(source.nodeVersion, `nodeVersion:${source.id}`),
          terminalLineage: {
            kind: "cancel",
            operationId: topologyOperationId,
            at: input.mutatedAt,
            reasonHash: hashRoomValue(mutation.reason),
          },
        });
        directlyVersionedNodeIds.add(source.id);
        break;
      }
      case "remove_edge": {
        assertTaskGraphMutationKeys(
          mutation,
          ["action", "edgeId", "causalEvidenceIds", "reason"],
          "remove_edge",
        );
        if (!topologyOperationId) {
          throw new RoomStoreError(
            "task_graph_invalid_mutation",
            "remove_edge requires a deterministic topology operation",
          );
        }
        assertNonBlankTaskGraphString(mutation.edgeId, "remove_edge.edgeId");
        assertNonBlankTaskGraphString(mutation.reason, "remove_edge.reason");
        const target = edges.get(mutation.edgeId);
        if (!target) {
          throw new RoomStoreError(
            "task_graph_invalid_mutation",
            `Task edge ${mutation.edgeId} is not active`,
          );
        }
        const from = requireTaskGraphNode(nodes, target.fromNodeId);
        const to = requireTaskGraphNode(nodes, target.toNodeId);
        if (from.state === "accepted" || to.state === "accepted") {
          throw new RoomStoreError(
            "accepted_node_frozen",
            `remove_edge ${target.id} cannot touch an accepted endpoint`,
          );
        }
        const affectedNodeIds = new Set<string>();
        for (const commandMutation of input.mutations) {
          if (commandMutation.action === "remove_edge") {
            const removed = current.edges.find((edge) => edge.id === commandMutation.edgeId);
            if (!removed) {
              throw new RoomStoreError(
                "task_graph_invalid_mutation",
                `Task edge ${commandMutation.edgeId} is not active`,
              );
            }
            affectedNodeIds.add(removed.fromNodeId);
            affectedNodeIds.add(removed.toNodeId);
          } else if (commandMutation.action === "add_edge") {
            const added = normalizeTaskEdgeDefinition(commandMutation.edge, "paired add_edge.edge");
            affectedNodeIds.add(added.fromNodeId);
            affectedNodeIds.add(added.toNodeId);
          }
        }
        assertTaskGraphAffectedNodeVersions(input.expectedNodeVersions, affectedNodeIds, nodes);
        edges.delete(target.id);
        retiredEdges.push({
          ...target,
          retiredAt: input.mutatedAt,
          retiredByOperationId: topologyOperationId,
        });
        break;
      }
      default:
        throw new RoomStoreError(
          "task_graph_invalid_mutation",
          `Unsupported task-graph mutation action ${String((mutation as { action?: unknown }).action)}`,
        );
    }
  }

  assertTaskGraphIntegrity(nodes, edges, false);
  deriveTaskDependencyStates(nodes, edges, originalNodeIds, directlyVersionedNodeIds);
  assertTaskGraphIntegrity(nodes, edges, true);
  return {
    projection: buildTaskGraphProjection(
      current.roomId,
      nextAggregateVersion,
      nextDagVersion,
      nodes,
      edges,
    ),
    retiredEdges,
  };
}

function buildTaskGraphCommandAudit(
  mutations: readonly RoomTaskGraphMutationV1[],
  topologyOperationId: string | null,
): Readonly<Record<string, unknown>> {
  return {
    version: 1,
    ...(topologyOperationId ? { topologyOperationId } : {}),
    mutationCount: mutations.length,
    mutations: mutations.map((mutation) => {
      switch (mutation.action) {
        case "add_node":
          return {
            action: mutation.action,
            nodeId: mutation.node.id,
            parentNodeId: mutation.node.parentNodeId,
            definitionHash: hashRoomValue(mutation.node),
          };
        case "add_edge":
          return {
            action: mutation.action,
            edgeId: mutation.edge.id,
            fromNodeId: mutation.edge.fromNodeId,
            toNodeId: mutation.edge.toNodeId,
            kind: mutation.edge.kind,
          };
        case "update_node":
          return {
            action: mutation.action,
            nodeId: mutation.nodeId,
            expectedNodeVersion: mutation.expectedNodeVersion,
            changedFields: Object.keys(mutation.patch).sort(compareRoomText),
            evidenceIds: [...mutation.evidenceIds].sort(compareRoomText),
            patchHash: hashRoomValue(mutation.patch),
          };
        case "transition_node":
          return {
            action: mutation.action,
            nodeId: mutation.nodeId,
            expectedNodeVersion: mutation.expectedNodeVersion,
            to: mutation.to,
            acceptanceEvidenceIds: [...mutation.acceptanceEvidenceIds].sort(compareRoomText),
            progressSignatureHash: hashRoomValue(mutation.progressSignature),
          };
        case "invalidate_acceptance_evidence":
          return {
            action: mutation.action,
            nodeId: mutation.nodeId,
            expectedNodeVersion: mutation.expectedNodeVersion,
            acceptanceEvidenceId: mutation.acceptanceEvidenceId,
            invalidatedByEvidenceId: mutation.invalidatedByEvidenceId,
            reasonHash: hashRoomValue(mutation.reason),
          };
        case "reopen_node":
          return {
            action: mutation.action,
            nodeId: mutation.nodeId,
            expectedNodeVersion: mutation.expectedNodeVersion,
            upstreamNodeId: mutation.upstreamNodeId,
            invalidatedByEvidenceId: mutation.invalidatedByEvidenceId,
            reasonHash: hashRoomValue(mutation.reason),
          };
        case "split_node":
          return {
            action: mutation.action,
            nodeId: mutation.nodeId,
            childNodeIds: mutation.children.map((child) => child.id).sort(compareRoomText),
            causalEvidenceIds: [...mutation.causalEvidenceIds].sort(compareRoomText),
            reasonHash: hashRoomValue(mutation.reason),
          };
        case "merge_nodes":
          return {
            action: mutation.action,
            nodeIds: [...mutation.nodeIds].sort(compareRoomText),
            mergedNodeId: mutation.mergedNode.id,
            mergedDefinitionHash: hashRoomValue(mutation.mergedNode),
            causalEvidenceIds: [...mutation.causalEvidenceIds].sort(compareRoomText),
            reasonHash: hashRoomValue(mutation.reason),
          };
        case "cancel_node":
          return {
            action: mutation.action,
            nodeId: mutation.nodeId,
            causalEvidenceIds: [...mutation.causalEvidenceIds].sort(compareRoomText),
            reasonHash: hashRoomValue(mutation.reason),
          };
        case "remove_edge":
          return {
            action: mutation.action,
            edgeId: mutation.edgeId,
            causalEvidenceIds: [...mutation.causalEvidenceIds].sort(compareRoomText),
            reasonHash: hashRoomValue(mutation.reason),
          };
      }
    }),
  };
}

function deriveTaskDependencyStates(
  nodes: Map<string, RoomTaskNodeProjectionV1>,
  edges: ReadonlyMap<string, RoomTaskEdgeDefinitionV1>,
  originalNodeIds: ReadonlySet<string>,
  directlyVersionedNodeIds: ReadonlySet<string>,
): void {
  for (const nodeId of [...nodes.keys()].sort(compareRoomText)) {
    const node = nodes.get(nodeId)!;
    if (!["pending", "ready", "waiting_dependency"].includes(node.state)) continue;
    const state: RoomTaskNodeState = taskNodeDependenciesSatisfied(node.id, nodes, edges)
      ? "ready"
      : "waiting_dependency";
    if (state === node.state) continue;
    nodes.set(node.id, {
      ...node,
      state,
      nodeVersion: originalNodeIds.has(node.id) && !directlyVersionedNodeIds.has(node.id)
        ? advanceTaskGraphVersion(node.nodeVersion, `nodeVersion:${node.id}`)
        : node.nodeVersion,
    });
  }
}

function taskNodeDependenciesSatisfied(
  nodeId: string,
  nodes: ReadonlyMap<string, RoomTaskNodeProjectionV1>,
  edges: ReadonlyMap<string, RoomTaskEdgeDefinitionV1>,
): boolean {
  return [...edges.values()]
    .filter((edge) => edge.kind === "requires" && edge.toNodeId === nodeId)
    .every((edge) => {
      const predecessor = nodes.get(edge.fromNodeId);
      return predecessor?.state === "accepted" && predecessor.invalidatedByEvidenceId === null;
    });
}

function hasRequiresPath(
  fromNodeId: string,
  toNodeId: string,
  edges: ReadonlyMap<string, RoomTaskEdgeDefinitionV1>,
): boolean {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges.values()) {
    if (edge.kind !== "requires") continue;
    const targets = adjacency.get(edge.fromNodeId) ?? [];
    targets.push(edge.toNodeId);
    adjacency.set(edge.fromNodeId, targets);
  }
  const queue = [fromNodeId];
  const visited = new Set<string>(queue);
  for (let index = 0; index < queue.length; index += 1) {
    const nodeId = queue[index]!;
    for (const target of adjacency.get(nodeId) ?? []) {
      if (target === toNodeId) return true;
      if (!visited.has(target)) {
        visited.add(target);
        queue.push(target);
      }
    }
  }
  return false;
}

function assertTaskGraphIntegrity(
  nodes: ReadonlyMap<string, RoomTaskNodeProjectionV1>,
  edges: ReadonlyMap<string, RoomTaskEdgeProjectionV1>,
  verifyDerivedStates: boolean,
): void {
  const shapes = new Set<string>();
  for (const edge of edges.values()) {
    assertTaskEdgeTopologyLineageShape(edge);
    if (!nodes.has(edge.fromNodeId) || !nodes.has(edge.toNodeId)) {
      throw new RoomStoreError(
        "task_graph_unknown_node",
        `Task edge ${edge.id} references an unknown node`,
      );
    }
    if (edge.fromNodeId === edge.toNodeId) {
      throw new RoomStoreError("task_graph_self_edge", `Task edge ${edge.id} is a self edge`);
    }
    const shape = `${edge.fromNodeId}\u0000${edge.toNodeId}\u0000${edge.kind}`;
    if (shapes.has(shape)) {
      throw new RoomStoreError("task_graph_invalid_mutation", `Duplicate task edge shape ${edge.id}`);
    }
    shapes.add(shape);
  }
  for (const node of nodes.values()) {
    if (node.parentNodeId !== null && !nodes.has(node.parentNodeId)) {
      throw new RoomStoreError(
        "task_graph_unknown_node",
        `Task node ${node.id} references unknown parent ${node.parentNodeId}`,
      );
    }
    assertTaskNodeProjectionState(node);
    if (verifyDerivedStates && ["pending", "ready", "waiting_dependency"].includes(node.state)) {
      const expected = taskNodeDependenciesSatisfied(node.id, nodes, edges)
        ? "ready"
        : "waiting_dependency";
      if (node.state !== expected) {
        throw new RoomStoreError(
          "task_graph_invalid_mutation",
          `Task node ${node.id} has stale derived state ${node.state}; expected ${expected}`,
        );
      }
    }
  }
  assertTaskTopologyLineageIntegrity(nodes);
  assertTaskGraphAcyclic(nodes, edges);
  const parentPairs = [...nodes.values()]
    .filter((node): node is RoomTaskNodeProjectionV1 & { parentNodeId: string } => node.parentNodeId !== null)
    .map((node) => [node.parentNodeId, node.id] as const);
  assertDirectedAcyclic([...nodes.keys()], parentPairs);
}

function assertTaskEdgeTopologyLineageShape(edge: RoomTaskEdgeProjectionV1): void {
  if (edge.derivedFromEdgeIds.length === 0) {
    if (edge.createdByOperationId !== null) {
      throw new RoomStoreError(
        "task_graph_invalid_mutation",
        `Task edge ${edge.id} has a topology operation without derived lineage`,
      );
    }
    return;
  }
  if (edge.createdByOperationId === null) {
    throw new RoomStoreError(
      "task_graph_invalid_mutation",
      `Task edge ${edge.id} has derived lineage without a topology operation`,
    );
  }
  if (edge.derivedFromEdgeIds.includes(edge.id)) {
    throw new RoomStoreError(
      "task_graph_invalid_mutation",
      `Task edge ${edge.id} cannot derive from itself`,
    );
  }
  const expectedId = buildTaskGraphDerivedEdgeId(
    edge.createdByOperationId,
    edge,
    edge.derivedFromEdgeIds,
  );
  if (edge.id !== expectedId) {
    throw new RoomStoreError(
      "task_graph_invalid_mutation",
      `Task edge ${edge.id} does not match its deterministic topology lineage`,
    );
  }
}

function assertPersistedTaskEdgeTopologyLineage(
  persistedEdges: ReadonlyMap<string, {
    readonly edge: RoomTaskEdgeProjectionV1;
    readonly retiredAt: string | null;
    readonly retiredByOperationId: string | null;
  }>,
): void {
  for (const { edge } of persistedEdges.values()) {
    assertTaskEdgeTopologyLineageShape(edge);
    if (edge.derivedFromEdgeIds.length === 0) continue;
    for (const sourceEdgeId of edge.derivedFromEdgeIds) {
      const source = persistedEdges.get(sourceEdgeId);
      if (
        !source
        || source.edge.id === edge.id
        || source.retiredAt === null
        || source.retiredByOperationId !== edge.createdByOperationId
      ) {
        throw new RoomStoreError(
          "task_graph_invalid_mutation",
          `Task edge ${edge.id} has forged or inconsistent persisted topology lineage`,
        );
      }
    }
  }

  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (edgeId: string): void => {
    if (visited.has(edgeId)) return;
    if (visiting.has(edgeId)) {
      throw new RoomStoreError(
        "task_graph_invalid_mutation",
        `Task edge ${edgeId} has cyclic persisted topology lineage`,
      );
    }
    visiting.add(edgeId);
    const edge = persistedEdges.get(edgeId)!.edge;
    for (const sourceEdgeId of edge.derivedFromEdgeIds) visit(sourceEdgeId);
    visiting.delete(edgeId);
    visited.add(edgeId);
  };
  for (const edgeId of persistedEdges.keys()) visit(edgeId);
}

function assertTaskTopologyLineageIntegrity(
  nodes: ReadonlyMap<string, RoomTaskNodeProjectionV1>,
): void {
  for (const node of nodes.values()) {
    const origin = node.origin;
    if (origin.kind === "created") continue;
    const sources = origin.sourceNodeIds.map((sourceNodeId) => {
      const source = nodes.get(sourceNodeId);
      if (!source || source.id === node.id) {
        throw new RoomStoreError(
          "task_graph_invalid_mutation",
          `Task node ${node.id} has unknown or self-referential topology lineage`,
        );
      }
      return source;
    });
    const expectedTerminalKind = origin.kind === "split_child" ? "split" : "merge";
    if (sources.some((source) =>
      source.terminalLineage?.kind !== expectedTerminalKind
      || source.terminalLineage.operationId !== origin.operationId
    )) {
      throw new RoomStoreError(
        "task_graph_invalid_mutation",
        `Task node ${node.id} has inconsistent topology operation lineage`,
      );
    }
    if (origin.kind === "split_child") {
      if (node.parentNodeId !== sources[0]!.id) {
        throw new RoomStoreError(
          "task_graph_invalid_mutation",
          `Split child ${node.id} must retain its source as parent`,
        );
      }
      continue;
    }
    const commonParentNodeId = sources[0]!.parentNodeId;
    if (
      node.parentNodeId !== commonParentNodeId
      || sources.some((source) => source.parentNodeId !== commonParentNodeId)
    ) {
      throw new RoomStoreError(
        "task_graph_invalid_mutation",
        `Merge result ${node.id} must retain the source parent lineage`,
      );
    }
  }
}

function assertTaskGraphAcyclic(
  nodes: ReadonlyMap<string, RoomTaskNodeProjectionV1>,
  edges: ReadonlyMap<string, RoomTaskEdgeDefinitionV1>,
): void {
  assertDirectedAcyclic(
    [...nodes.keys()],
    [...edges.values()].map((edge) => [edge.fromNodeId, edge.toNodeId] as const),
  );
}

function assertDirectedAcyclic(
  nodeIds: readonly string[],
  pairs: readonly (readonly [string, string])[],
): void {
  const indegree = new Map<string, number>(nodeIds.map((nodeId) => [nodeId, 0]));
  const adjacency = new Map<string, string[]>();
  for (const [from, to] of pairs) {
    indegree.set(to, (indegree.get(to) ?? 0) + 1);
    const targets = adjacency.get(from) ?? [];
    targets.push(to);
    adjacency.set(from, targets);
  }
  const queue = [...indegree.entries()]
    .filter(([, degree]) => degree === 0)
    .map(([nodeId]) => nodeId)
    .sort(compareRoomText);
  let visited = 0;
  for (let index = 0; index < queue.length; index += 1) {
    const nodeId = queue[index]!;
    visited += 1;
    for (const target of [...(adjacency.get(nodeId) ?? [])].sort(compareRoomText)) {
      const nextDegree = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, nextDegree);
      if (nextDegree === 0) queue.push(target);
    }
  }
  if (visited !== indegree.size) {
    throw new RoomStoreError("task_graph_cycle", "Room task graph must remain acyclic");
  }
}

async function loadRoomTaskGraphProjection(
  handle: QueryHandle,
  projectId: string,
  roomId: string,
): Promise<RoomTaskGraphProjectionV1 | null> {
  const roomRows = await handle
    .select({
      aggregateVersion: operationalRooms.aggregateVersion,
      dagVersion: operationalRooms.taskGraphVersion,
    })
    .from(operationalRooms)
    .where(and(
      eq(operationalRooms.projectId, projectId),
      eq(operationalRooms.id, roomId),
    ))
    .limit(1);
  const room = roomRows[0];
  if (!room) return null;
  assertTaskGraphVersion(room.aggregateVersion, "persisted aggregateVersion");
  assertTaskGraphVersion(room.dagVersion, "persisted dagVersion");

  const [nodeRows, edgeRows] = await Promise.all([
    handle
      .select()
      .from(roomTaskNodes)
      .where(and(
        eq(roomTaskNodes.projectId, projectId),
        eq(roomTaskNodes.roomId, roomId),
      ))
      .orderBy(asc(roomTaskNodes.id)),
    handle
      .select()
      .from(roomTaskEdges)
      .where(and(
        eq(roomTaskEdges.projectId, projectId),
        eq(roomTaskEdges.roomId, roomId),
      ))
      .orderBy(asc(roomTaskEdges.id)),
  ]);
  const nodes = new Map<string, RoomTaskNodeProjectionV1>();
  for (const row of nodeRows) {
    const node = rowToRoomTaskNodeProjection(row);
    if (nodes.has(node.id)) {
      throw new RoomStoreError("task_graph_invalid_mutation", `Duplicate persisted task node ${node.id}`);
    }
    nodes.set(node.id, node);
  }
  const edges = new Map<string, RoomTaskEdgeProjectionV1>();
  const persistedEdges = new Map<string, {
    readonly edge: RoomTaskEdgeProjectionV1;
    readonly retiredAt: string | null;
    readonly retiredByOperationId: string | null;
  }>();
  for (const row of edgeRows) {
    const edge = normalizeTaskEdgeProjection({
      id: row.id,
      fromNodeId: row.fromNodeId,
      toNodeId: row.toNodeId,
      kind: row.kind,
      createdByOperationId: row.createdByOperationId,
      derivedFromEdgeIds: row.derivedFromEdgeIds,
    }, `persisted edge ${row.id}`);
    if (persistedEdges.has(edge.id)) {
      throw new RoomStoreError("task_graph_invalid_mutation", `Duplicate persisted task edge ${edge.id}`);
    }
    persistedEdges.set(edge.id, {
      edge,
      retiredAt: row.retiredAt,
      retiredByOperationId: row.retiredByOperationId,
    });
    if (row.retiredAt === null) edges.set(edge.id, edge);
  }
  assertPersistedTaskEdgeTopologyLineage(persistedEdges);
  assertTaskGraphIntegrity(nodes, edges, true);
  return buildTaskGraphProjection(
    roomId,
    room.aggregateVersion,
    room.dagVersion,
    nodes,
    edges,
  );
}

async function persistRoomTaskGraphProjection(
  tx: DbTransaction,
  projectId: string,
  current: RoomTaskGraphProjectionV1,
  next: RoomTaskGraphProjectionV1,
  mutatedAt: string,
  retiredEdges: readonly RetiredRoomTaskEdgeV1[],
): Promise<void> {
  const currentNodes = new Map(current.nodes.map((node) => [node.id, node] as const));
  const nextNodes = new Map(next.nodes.map((node) => [node.id, node] as const));
  const newNodes = next.nodes.filter((node) => !currentNodes.has(node.id));
  const newNodeIds = newNodes.map((node) => node.id);
  if (newNodeIds.length > 0) {
    const collisions = await tx
      .select({ id: roomTaskNodes.id })
      .from(roomTaskNodes)
      .where(inArray(roomTaskNodes.id, newNodeIds));
    if (collisions.length > 0) {
      throw new RoomStoreError(
        "task_graph_invalid_mutation",
        "A new task-node identity is already owned by another Room",
      );
    }
    await tx.insert(roomTaskNodes).values(newNodes.map((node) => ({
      id: node.id,
      projectId,
      roomId: next.roomId,
      parentNodeId: node.parentNodeId,
      objective: node.objective,
      state: node.state,
      assignedSeatIds: [],
      inputRefs: [...node.inputRefs],
      outputRefs: [...node.outputRefs],
      roleRequirements: [...node.roleRequirements],
      capabilityRequirements: [...node.capabilityRequirements],
      resourceHints: node.resourceHints,
      authorityScope: node.authorityScope,
      requiredGateIds: [...node.acceptanceGateIds],
      retryPolicy: node.retryPolicy,
      progressSignature: node.progressSignature,
      nodeVersion: node.nodeVersion,
      acceptedAt: node.acceptedAt,
      acceptanceEvidenceIds: [...node.acceptanceEvidenceIds],
      invalidatedByEvidenceId: node.invalidatedByEvidenceId,
      reopenedByEvidenceId: node.reopenedByEvidenceId,
      origin: node.origin,
      terminalLineage: node.terminalLineage,
    })));
  }

  for (const previous of current.nodes) {
    const node = nextNodes.get(previous.id);
    if (!node) {
      throw new RoomStoreError(
        "task_graph_invalid_mutation",
        `Task graph command attempted to erase node ${previous.id}`,
      );
    }
    const updated = await tx
      .update(roomTaskNodes)
      .set({
        parentNodeId: node.parentNodeId,
        objective: node.objective,
        state: node.state,
        inputRefs: [...node.inputRefs],
        outputRefs: [...node.outputRefs],
        roleRequirements: [...node.roleRequirements],
        capabilityRequirements: [...node.capabilityRequirements],
        resourceHints: node.resourceHints,
        authorityScope: node.authorityScope,
        requiredGateIds: [...node.acceptanceGateIds],
        retryPolicy: node.retryPolicy,
        progressSignature: node.progressSignature,
        nodeVersion: node.nodeVersion,
        acceptedAt: node.acceptedAt,
        acceptanceEvidenceIds: [...node.acceptanceEvidenceIds],
        invalidatedByEvidenceId: node.invalidatedByEvidenceId,
        reopenedByEvidenceId: node.reopenedByEvidenceId,
        origin: node.origin,
        terminalLineage: node.terminalLineage,
      })
      .where(and(
        eq(roomTaskNodes.projectId, projectId),
        eq(roomTaskNodes.roomId, next.roomId),
        eq(roomTaskNodes.id, previous.id),
        eq(roomTaskNodes.nodeVersion, previous.nodeVersion),
      ))
      .returning({ id: roomTaskNodes.id });
    if (updated.length !== 1) {
      throw new RoomStoreError(
        "task_node_version_conflict",
        `Concurrent task-node update rejected for ${previous.id}`,
      );
    }
  }

  const retiredEdgeIds = new Set(retiredEdges.map((edge) => edge.id));
  for (const previous of current.edges) {
    if (!next.edges.some((edge) => edge.id === previous.id) && !retiredEdgeIds.has(previous.id)) {
      throw new RoomStoreError(
        "task_graph_invalid_mutation",
        `Task graph command attempted to erase edge ${previous.id} without retirement`,
      );
    }
  }
  for (const edge of retiredEdges) {
    const retired = await tx
      .update(roomTaskEdges)
      .set({
        retiredAt: edge.retiredAt,
        retiredByOperationId: edge.retiredByOperationId,
      })
      .where(and(
        eq(roomTaskEdges.projectId, projectId),
        eq(roomTaskEdges.roomId, next.roomId),
        eq(roomTaskEdges.id, edge.id),
        isNull(roomTaskEdges.retiredAt),
      ))
      .returning({ id: roomTaskEdges.id });
    if (retired.length !== 1) {
      throw new RoomStoreError(
        "dag_version_conflict",
        `Concurrent task-edge retirement rejected for ${edge.id}`,
      );
    }
  }

  const currentEdgeIds = new Set(current.edges.map((edge) => edge.id));
  const newEdges = next.edges.filter((edge) => !currentEdgeIds.has(edge.id));
  const newEdgeIds = newEdges.map((edge) => edge.id);
  if (newEdgeIds.length > 0) {
    const collisions = await tx
      .select({ id: roomTaskEdges.id })
      .from(roomTaskEdges)
      .where(inArray(roomTaskEdges.id, newEdgeIds));
    if (collisions.length > 0) {
      throw new RoomStoreError(
        "task_graph_invalid_mutation",
        "A new task-edge identity is already owned by another Room",
      );
    }
    await tx.insert(roomTaskEdges).values(newEdges.map((edge) => ({
      id: edge.id,
      projectId,
      roomId: next.roomId,
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
      kind: edge.kind,
      createdAt: mutatedAt,
      retiredAt: null,
      retiredByOperationId: null,
      createdByOperationId: edge.createdByOperationId,
      derivedFromEdgeIds: [...edge.derivedFromEdgeIds],
    })));
  }
}

async function loadTaskGraphMutationResult(
  handle: QueryHandle,
  projectId: string,
  roomId: string,
  eventId: string,
): Promise<RoomTaskGraphProjectionV1> {
  const rows = await handle
    .select({
      aggregateVersion: roomEvents.aggregateVersion,
      eventType: roomEvents.eventType,
      payload: roomEvents.payload,
    })
    .from(roomEvents)
    .where(and(
      eq(roomEvents.projectId, projectId),
      eq(roomEvents.roomId, roomId),
      eq(roomEvents.id, eventId),
    ))
    .limit(1);
  const row = rows[0];
  if (!row || row.eventType !== "room_task_graph_mutated") {
    throw new RoomStoreError(
      "idempotency_result_missing",
      `Task-graph result event ${eventId} is missing or has the wrong type`,
    );
  }
  const payload = asRecord(row.payload);
  if (payload.projectionVersion !== 1 || !isNonEmptyString(payload.projectionHash)) {
    throw new RoomStoreError(
      "idempotency_result_missing",
      `Task-graph result event ${eventId} has invalid projection metadata`,
    );
  }
  if (hashRoomValue(payload.projection) !== payload.projectionHash) {
    throw new RoomStoreError(
      "idempotency_result_missing",
      `Task-graph result event ${eventId} failed projection integrity validation`,
    );
  }
  const projection = parseStoredTaskGraphProjection(payload.projection, `event ${eventId}`);
  if (projection.roomId !== roomId || projection.aggregateVersion !== row.aggregateVersion) {
    throw new RoomStoreError(
      "idempotency_result_missing",
      `Task-graph result event ${eventId} does not match its Room aggregate`,
    );
  }
  return projection;
}

function buildTaskGraphProjection(
  roomId: string,
  aggregateVersion: number,
  dagVersion: number,
  nodes: ReadonlyMap<string, RoomTaskNodeProjectionV1>,
  edges: ReadonlyMap<string, RoomTaskEdgeProjectionV1>,
): RoomTaskGraphProjectionV1 {
  const sortedNodes = [...nodes.values()]
    .map(cloneTaskGraphNode)
    .sort((left, right) => compareRoomText(left.id, right.id));
  const sortedEdges = [...edges.values()]
    .map((edge) => ({ ...edge, derivedFromEdgeIds: [...edge.derivedFromEdgeIds] }))
    .sort((left, right) => compareRoomText(left.id, right.id));
  return {
    roomId,
    aggregateVersion,
    dagVersion,
    nodes: sortedNodes,
    edges: sortedEdges,
    readyNodeIds: sortedNodes
      .filter((node) => node.state === "ready")
      .map((node) => node.id),
    criticalPathNodeIds: computeTaskGraphCriticalPath(sortedNodes, sortedEdges),
  };
}

function computeTaskGraphCriticalPath(
  nodes: readonly RoomTaskNodeProjectionV1[],
  edges: readonly RoomTaskEdgeProjectionV1[],
): readonly string[] {
  if (nodes.length === 0) return [];
  const nodeById = new Map(nodes.map((node) => [node.id, node] as const));
  const requires = edges.filter((edge) => edge.kind === "requires");
  const indegree = new Map<string, number>(nodes.map((node) => [node.id, 0]));
  const adjacency = new Map<string, string[]>();
  for (const edge of requires) {
    indegree.set(edge.toNodeId, (indegree.get(edge.toNodeId) ?? 0) + 1);
    const targets = adjacency.get(edge.fromNodeId) ?? [];
    targets.push(edge.toNodeId);
    adjacency.set(edge.fromNodeId, targets);
  }
  const queue = [...indegree.entries()]
    .filter(([, degree]) => degree === 0)
    .map(([nodeId]) => nodeId)
    .sort(compareRoomText);
  const weights = new Map<string, number>();
  const paths = new Map<string, readonly string[]>();
  for (const node of nodes) {
    weights.set(node.id, node.resourceHints.estimatedDurationMs);
    paths.set(node.id, [node.id]);
  }
  for (let index = 0; index < queue.length; index += 1) {
    const nodeId = queue[index]!;
    for (const target of [...(adjacency.get(nodeId) ?? [])].sort(compareRoomText)) {
      const sourceWeight = weights.get(nodeId) ?? 0;
      const targetDuration = nodeById.get(target)!.resourceHints.estimatedDurationMs;
      if (sourceWeight > Number.MAX_SAFE_INTEGER - targetDuration) {
        throw new RoomStoreError(
          "task_graph_critical_path_overflow",
          `Task critical path through ${nodeId}->${target} exceeds the safe duration range`,
        );
      }
      const candidateWeight = sourceWeight + targetDuration;
      const candidatePath = [...(paths.get(nodeId) ?? [nodeId]), target];
      const currentWeight = weights.get(target) ?? 0;
      const currentPath = paths.get(target) ?? [target];
      if (
        candidateWeight > currentWeight
        || (candidateWeight === currentWeight && compareTaskGraphPaths(candidatePath, currentPath) < 0)
      ) {
        weights.set(target, candidateWeight);
        paths.set(target, candidatePath);
      }
      const nextDegree = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, nextDegree);
      if (nextDegree === 0) queue.push(target);
    }
  }
  let bestNodeId = nodes[0]!.id;
  for (const node of nodes.slice(1)) {
    const bestWeight = weights.get(bestNodeId) ?? 0;
    const candidateWeight = weights.get(node.id) ?? 0;
    if (
      candidateWeight > bestWeight
      || (
        candidateWeight === bestWeight
        && compareTaskGraphPaths(paths.get(node.id) ?? [node.id], paths.get(bestNodeId) ?? [bestNodeId]) < 0
      )
    ) {
      bestNodeId = node.id;
    }
  }
  return paths.get(bestNodeId) ?? [bestNodeId];
}

function compareTaskGraphPaths(left: readonly string[], right: readonly string[]): number {
  return compareRoomText(left.join("\u0000"), right.join("\u0000"));
}

function parseStoredTaskGraphProjection(value: unknown, label: string): RoomTaskGraphProjectionV1 {
  const record = asRecord(value);
  assertTaskGraphObjectKeys(record, [
    "roomId",
    "aggregateVersion",
    "dagVersion",
    "nodes",
    "edges",
    "readyNodeIds",
    "criticalPathNodeIds",
  ], label);
  assertNonBlankTaskGraphString(record.roomId, `${label}.roomId`);
  assertTaskGraphVersion(record.aggregateVersion, `${label}.aggregateVersion`);
  assertTaskGraphVersion(record.dagVersion, `${label}.dagVersion`);
  if (!Array.isArray(record.nodes) || !Array.isArray(record.edges)) {
    throw new RoomStoreError("task_graph_invalid_mutation", `${label} must contain node and edge arrays`);
  }
  const nodes = new Map<string, RoomTaskNodeProjectionV1>();
  for (const [index, rawNode] of record.nodes.entries()) {
    const node = normalizeTaskNodeProjection(rawNode, `${label}.nodes[${index}]`);
    if (nodes.has(node.id)) {
      throw new RoomStoreError("task_graph_invalid_mutation", `${label} contains duplicate node ${node.id}`);
    }
    nodes.set(node.id, node);
  }
  const edges = new Map<string, RoomTaskEdgeProjectionV1>();
  for (const [index, rawEdge] of record.edges.entries()) {
    const edge = normalizeTaskEdgeProjection(rawEdge, `${label}.edges[${index}]`);
    if (edges.has(edge.id)) {
      throw new RoomStoreError("task_graph_invalid_mutation", `${label} contains duplicate edge ${edge.id}`);
    }
    edges.set(edge.id, edge);
  }
  const readyNodeIds = assertTaskGraphStringArray(record.readyNodeIds, `${label}.readyNodeIds`, true);
  const criticalPathNodeIds = assertTaskGraphStringArray(
    record.criticalPathNodeIds,
    `${label}.criticalPathNodeIds`,
    true,
  );
  assertTaskGraphIntegrity(nodes, edges, true);
  const rebuilt = buildTaskGraphProjection(
    record.roomId,
    record.aggregateVersion,
    record.dagVersion,
    nodes,
    edges,
  );
  const parsed = { ...rebuilt, readyNodeIds, criticalPathNodeIds };
  if (hashRoomValue(parsed) !== hashRoomValue(rebuilt)) {
    throw new RoomStoreError("task_graph_invalid_mutation", `${label} contains stale derived graph fields`);
  }
  return rebuilt;
}

function rowToRoomTaskNodeProjection(
  row: typeof roomTaskNodes.$inferSelect,
): RoomTaskNodeProjectionV1 {
  return normalizeTaskNodeProjection({
    id: row.id,
    parentNodeId: row.parentNodeId,
    objective: row.objective,
    inputRefs: row.inputRefs,
    outputRefs: row.outputRefs,
    roleRequirements: row.roleRequirements,
    capabilityRequirements: row.capabilityRequirements,
    resourceHints: row.resourceHints,
    authorityScope: row.authorityScope,
    acceptanceGateIds: row.requiredGateIds,
    retryPolicy: row.retryPolicy,
    progressSignature: row.progressSignature,
    state: row.state,
    nodeVersion: row.nodeVersion,
    acceptedAt: row.acceptedAt,
    acceptanceEvidenceIds: row.acceptanceEvidenceIds,
    invalidatedByEvidenceId: row.invalidatedByEvidenceId,
    reopenedByEvidenceId: row.reopenedByEvidenceId,
    origin: row.origin,
    terminalLineage: row.terminalLineage,
  }, `persisted node ${row.id}`);
}

function normalizeTaskNodeProjection(value: unknown, label: string): RoomTaskNodeProjectionV1 {
  const record = asRecord(value);
  const hasTopologyLineage = record.origin !== undefined || record.terminalLineage !== undefined;
  if (hasTopologyLineage && (record.origin === undefined || !("terminalLineage" in record))) {
    throw new RoomStoreError(
      "task_graph_invalid_mutation",
      `${label} must contain complete topology lineage`,
    );
  }
  assertTaskGraphObjectKeys(record, [
    "id",
    "parentNodeId",
    "objective",
    "inputRefs",
    "outputRefs",
    "roleRequirements",
    "capabilityRequirements",
    "resourceHints",
    "authorityScope",
    "acceptanceGateIds",
    "retryPolicy",
    "progressSignature",
    "state",
    "nodeVersion",
    "acceptedAt",
    "acceptanceEvidenceIds",
    "invalidatedByEvidenceId",
    "reopenedByEvidenceId",
    ...(hasTopologyLineage ? ["origin", "terminalLineage"] : []),
  ], label);
  const definition = normalizeTaskNodeDefinition({
    id: record.id,
    parentNodeId: record.parentNodeId,
    objective: record.objective,
    inputRefs: record.inputRefs,
    outputRefs: record.outputRefs,
    roleRequirements: record.roleRequirements,
    capabilityRequirements: record.capabilityRequirements,
    resourceHints: record.resourceHints,
    authorityScope: record.authorityScope,
    acceptanceGateIds: record.acceptanceGateIds,
    retryPolicy: record.retryPolicy,
    progressSignature: record.progressSignature,
  }, label);
  if (!ROOM_TASK_NODE_STATES.has(record.state as RoomTaskNodeState)) {
    throw new RoomStoreError("task_graph_invalid_mutation", `${label}.state is unsupported`);
  }
  assertTaskGraphVersion(record.nodeVersion, `${label}.nodeVersion`);
  const acceptedAt = assertNullableTaskGraphString(record.acceptedAt, `${label}.acceptedAt`);
  if (acceptedAt !== null) assertTaskGraphTimestamp(acceptedAt, `${label}.acceptedAt`);
  const node: RoomTaskNodeProjectionV1 = {
    ...definition,
    state: record.state as RoomTaskNodeState,
    nodeVersion: record.nodeVersion,
    acceptedAt,
    acceptanceEvidenceIds: assertTaskGraphStringArray(
      record.acceptanceEvidenceIds,
      `${label}.acceptanceEvidenceIds`,
      true,
    ),
    invalidatedByEvidenceId: assertNullableTaskGraphString(
      record.invalidatedByEvidenceId,
      `${label}.invalidatedByEvidenceId`,
    ),
    reopenedByEvidenceId: assertNullableTaskGraphString(
      record.reopenedByEvidenceId,
      `${label}.reopenedByEvidenceId`,
    ),
    origin: hasTopologyLineage
      ? normalizeTaskNodeOrigin(record.origin, `${label}.origin`)
      : { kind: "created" },
    terminalLineage: hasTopologyLineage
      ? normalizeTaskNodeTerminalLineage(record.terminalLineage, `${label}.terminalLineage`)
      : null,
  };
  assertTaskNodeProjectionState(node);
  return node;
}

function normalizeTaskNodeDefinition(value: unknown, label: string): RoomTaskNodeDefinitionV1 {
  const record = asRecord(value);
  assertTaskGraphObjectKeys(record, [
    "id",
    "parentNodeId",
    "objective",
    "inputRefs",
    "outputRefs",
    "roleRequirements",
    "capabilityRequirements",
    "resourceHints",
    "authorityScope",
    "acceptanceGateIds",
    "retryPolicy",
    "progressSignature",
  ], label);
  assertNonBlankTaskGraphString(record.id, `${label}.id`);
  assertNonBlankTaskGraphString(record.objective, `${label}.objective`);
  assertNonBlankTaskGraphString(record.progressSignature, `${label}.progressSignature`);
  const parentNodeId = assertNullableTaskGraphString(record.parentNodeId, `${label}.parentNodeId`);
  const resourceHints = asRecord(record.resourceHints);
  assertTaskGraphObjectKeys(resourceHints, [
    "estimatedDurationMs",
    "concurrencyClass",
    "preferredProviderIds",
  ], `${label}.resourceHints`);
  assertTaskGraphVersion(resourceHints.estimatedDurationMs, `${label}.resourceHints.estimatedDurationMs`);
  if (resourceHints.concurrencyClass !== "serial" && resourceHints.concurrencyClass !== "parallel") {
    throw new RoomStoreError(
      "task_graph_invalid_mutation",
      `${label}.resourceHints.concurrencyClass is unsupported`,
    );
  }
  const authorityScope = asRecord(record.authorityScope);
  assertTaskGraphObjectKeys(authorityScope, ["allowedActions", "readPaths", "writePaths"], `${label}.authorityScope`);
  const retryPolicy = asRecord(record.retryPolicy);
  assertTaskGraphObjectKeys(retryPolicy, [
    "maxAttempts",
    "backoff",
    "baseDelayMs",
    "recoveryActions",
  ], `${label}.retryPolicy`);
  assertPositiveTaskGraphVersion(retryPolicy.maxAttempts, `${label}.retryPolicy.maxAttempts`);
  assertTaskGraphVersion(retryPolicy.baseDelayMs, `${label}.retryPolicy.baseDelayMs`);
  if (retryPolicy.backoff !== "fixed" && retryPolicy.backoff !== "exponential") {
    throw new RoomStoreError("task_graph_invalid_mutation", `${label}.retryPolicy.backoff is unsupported`);
  }
  return {
    id: record.id,
    parentNodeId,
    objective: record.objective,
    inputRefs: assertTaskGraphStringArray(record.inputRefs, `${label}.inputRefs`, true),
    outputRefs: assertTaskGraphStringArray(record.outputRefs, `${label}.outputRefs`, true),
    roleRequirements: assertTaskGraphStringArray(
      record.roleRequirements,
      `${label}.roleRequirements`,
      true,
    ),
    capabilityRequirements: assertTaskGraphStringArray(
      record.capabilityRequirements,
      `${label}.capabilityRequirements`,
      true,
    ),
    resourceHints: {
      estimatedDurationMs: resourceHints.estimatedDurationMs,
      concurrencyClass: resourceHints.concurrencyClass,
      preferredProviderIds: assertTaskGraphStringArray(
        resourceHints.preferredProviderIds,
        `${label}.resourceHints.preferredProviderIds`,
        true,
      ),
    },
    authorityScope: {
      allowedActions: assertTaskGraphStringArray(
        authorityScope.allowedActions,
        `${label}.authorityScope.allowedActions`,
        true,
      ),
      readPaths: assertTaskGraphStringArray(authorityScope.readPaths, `${label}.authorityScope.readPaths`, true),
      writePaths: assertTaskGraphStringArray(authorityScope.writePaths, `${label}.authorityScope.writePaths`, true),
    },
    acceptanceGateIds: assertTaskGraphStringArray(
      record.acceptanceGateIds,
      `${label}.acceptanceGateIds`,
      true,
    ),
    retryPolicy: {
      maxAttempts: retryPolicy.maxAttempts,
      backoff: retryPolicy.backoff,
      baseDelayMs: retryPolicy.baseDelayMs,
      recoveryActions: assertTaskGraphStringArray(
        retryPolicy.recoveryActions,
        `${label}.retryPolicy.recoveryActions`,
        true,
      ),
    },
    progressSignature: record.progressSignature,
  };
}

function normalizeTaskEdgeDefinition(value: unknown, label: string): RoomTaskEdgeDefinitionV1 {
  const record = asRecord(value);
  assertTaskGraphObjectKeys(record, ["id", "fromNodeId", "toNodeId", "kind"], label);
  assertNonBlankTaskGraphString(record.id, `${label}.id`);
  assertNonBlankTaskGraphString(record.fromNodeId, `${label}.fromNodeId`);
  assertNonBlankTaskGraphString(record.toNodeId, `${label}.toNodeId`);
  if (record.kind !== "requires" && record.kind !== "informs" && record.kind !== "invalidates") {
    throw new RoomStoreError("task_graph_invalid_mutation", `${label}.kind is unsupported`);
  }
  return {
    id: record.id,
    fromNodeId: record.fromNodeId,
    toNodeId: record.toNodeId,
    kind: record.kind,
  };
}

function normalizeTaskEdgeProjection(value: unknown, label: string): RoomTaskEdgeProjectionV1 {
  const record = asRecord(value);
  const hasDerivedLineage = record.derivedFromEdgeIds !== undefined;
  const hasCreationOperation = record.createdByOperationId !== undefined;
  assertTaskGraphObjectKeys(record, [
    "id",
    "fromNodeId",
    "toNodeId",
    "kind",
    ...(hasCreationOperation ? ["createdByOperationId"] : []),
    ...(hasDerivedLineage ? ["derivedFromEdgeIds"] : []),
  ], label);
  const edge = normalizeTaskEdgeDefinition({
    id: record.id,
    fromNodeId: record.fromNodeId,
    toNodeId: record.toNodeId,
    kind: record.kind,
  }, label);
  return {
    ...edge,
    createdByOperationId: hasCreationOperation
      ? assertNullableTaskGraphString(record.createdByOperationId, `${label}.createdByOperationId`)
      : null,
    derivedFromEdgeIds: hasDerivedLineage
      ? assertTaskGraphStringArray(record.derivedFromEdgeIds, `${label}.derivedFromEdgeIds`, true)
      : [],
  };
}

function normalizeTaskNodeOrigin(value: unknown, label: string): RoomTaskNodeOriginV1 {
  const record = asRecord(value);
  if (record.kind === "created") {
    assertTaskGraphObjectKeys(record, ["kind"], label);
    return { kind: "created" };
  }
  assertTaskGraphObjectKeys(record, ["kind", "operationId", "sourceNodeIds"], label);
  if (record.kind !== "split_child" && record.kind !== "merge_result") {
    throw new RoomStoreError("task_graph_invalid_mutation", `${label}.kind is unsupported`);
  }
  assertNonBlankTaskGraphString(record.operationId, `${label}.operationId`);
  const sourceNodeIds = assertTaskGraphStringArray(record.sourceNodeIds, `${label}.sourceNodeIds`, false);
  if (
    (record.kind === "split_child" && sourceNodeIds.length !== 1)
    || (record.kind === "merge_result" && sourceNodeIds.length < 2)
  ) {
    throw new RoomStoreError("task_graph_invalid_mutation", `${label} has invalid source lineage`);
  }
  return { kind: record.kind, operationId: record.operationId, sourceNodeIds };
}

function normalizeTaskNodeTerminalLineage(
  value: unknown,
  label: string,
): RoomTaskNodeTerminalLineageV1 | null {
  if (value === null) return null;
  const record = asRecord(value);
  assertTaskGraphObjectKeys(record, ["kind", "operationId", "at", "reasonHash"], label);
  if (record.kind !== "split" && record.kind !== "merge" && record.kind !== "cancel") {
    throw new RoomStoreError("task_graph_invalid_mutation", `${label}.kind is unsupported`);
  }
  assertNonBlankTaskGraphString(record.operationId, `${label}.operationId`);
  assertTaskGraphTimestamp(record.at, `${label}.at`);
  if (typeof record.reasonHash !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(record.reasonHash)) {
    throw new RoomStoreError("task_graph_invalid_mutation", `${label}.reasonHash is invalid`);
  }
  return {
    kind: record.kind,
    operationId: record.operationId,
    at: record.at,
    reasonHash: record.reasonHash,
  };
}

function assertTaskNodeProjectionState(node: RoomTaskNodeProjectionV1): void {
  if (node.terminalLineage !== null && node.state !== "cancelled") {
    throw new RoomStoreError(
      "task_graph_invalid_mutation",
      `Terminal task node ${node.id} must remain cancelled`,
    );
  }
  if (node.state === "accepted") {
    if (node.acceptedAt === null || node.acceptanceEvidenceIds.length === 0) {
      throw new RoomStoreError(
        "task_graph_invalid_mutation",
        `Accepted task node ${node.id} must retain acceptance time and evidence`,
      );
    }
    return;
  }
  if (
    node.acceptedAt !== null
    || node.acceptanceEvidenceIds.length > 0
    || node.invalidatedByEvidenceId !== null
  ) {
    throw new RoomStoreError(
      "task_graph_invalid_mutation",
      `Non-accepted task node ${node.id} contains stale acceptance projection`,
    );
  }
}

function cloneTaskGraphNode(node: RoomTaskNodeProjectionV1): RoomTaskNodeProjectionV1 {
  return {
    ...node,
    inputRefs: [...node.inputRefs],
    outputRefs: [...node.outputRefs],
    roleRequirements: [...node.roleRequirements],
    capabilityRequirements: [...node.capabilityRequirements],
    resourceHints: {
      ...node.resourceHints,
      preferredProviderIds: [...node.resourceHints.preferredProviderIds],
    },
    authorityScope: {
      allowedActions: [...node.authorityScope.allowedActions],
      readPaths: [...node.authorityScope.readPaths],
      writePaths: [...node.authorityScope.writePaths],
    },
    acceptanceGateIds: [...node.acceptanceGateIds],
    retryPolicy: {
      ...node.retryPolicy,
      recoveryActions: [...node.retryPolicy.recoveryActions],
    },
    acceptanceEvidenceIds: [...node.acceptanceEvidenceIds],
    origin: node.origin.kind === "created"
      ? { kind: "created" }
      : { ...node.origin, sourceNodeIds: [...node.origin.sourceNodeIds] },
    terminalLineage: node.terminalLineage ? { ...node.terminalLineage } : null,
  };
}

function requireTaskGraphNode(
  nodes: ReadonlyMap<string, RoomTaskNodeProjectionV1>,
  nodeId: string,
): RoomTaskNodeProjectionV1 {
  assertNonBlankTaskGraphString(nodeId, "nodeId");
  const node = nodes.get(nodeId);
  if (!node) {
    throw new RoomStoreError("task_graph_unknown_node", `Task node ${nodeId} does not exist`);
  }
  return node;
}

function assertTaskNodeVersion(node: RoomTaskNodeProjectionV1, expectedNodeVersion: number): void {
  if (
    !Number.isSafeInteger(expectedNodeVersion)
    || expectedNodeVersion < 0
    || node.nodeVersion !== expectedNodeVersion
  ) {
    throw new RoomStoreError(
      "task_node_version_conflict",
      `Task node ${node.id} expected version ${expectedNodeVersion} but is ${node.nodeVersion}`,
    );
  }
}

function assertTaskGraphMutationKeys(
  mutation: object,
  allowedKeys: readonly string[],
  label: string,
): void {
  assertTaskGraphObjectKeys(asRecord(mutation), allowedKeys, label);
}

function assertTaskGraphObjectKeys(
  record: object,
  allowedKeys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(record).sort(compareRoomText);
  const expected = [...allowedKeys].sort(compareRoomText);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new RoomStoreError(
      "task_graph_invalid_mutation",
      `${label} must contain exactly: ${expected.join(", ")}`,
    );
  }
}

function assertTaskGraphStringArray(
  value: unknown,
  label: string,
  allowEmpty: boolean,
): readonly string[] {
  if (!Array.isArray(value)) {
    throw new RoomStoreError("task_graph_invalid_mutation", `${label} must be an array`);
  }
  const strings = value.map((entry, index) => {
    assertNonBlankTaskGraphString(entry, `${label}[${index}]`);
    return entry;
  });
  if (!allowEmpty && strings.length === 0) {
    throw new RoomStoreError("task_graph_invalid_mutation", `${label} must not be empty`);
  }
  if (new Set(strings).size !== strings.length) {
    throw new RoomStoreError("task_graph_invalid_mutation", `${label} must contain unique values`);
  }
  return strings;
}

function assertNullableTaskGraphString(value: unknown, label: string): string | null {
  if (value === null) return null;
  assertNonBlankTaskGraphString(value, label);
  return value;
}

function assertNonBlankTaskGraphString(value: unknown, label: string): asserts value is string {
  if (!isNonEmptyString(value)) {
    throw new RoomStoreError("task_graph_invalid_mutation", `${label} must be a non-empty string`);
  }
}

function assertTaskGraphVersion(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RoomStoreError(
      "task_graph_invalid_mutation",
      `${label} must be a non-negative safe integer`,
    );
  }
}

function advanceTaskGraphVersion(value: number, label: string): number {
  assertTaskGraphVersion(value, label);
  if (value === Number.MAX_SAFE_INTEGER) {
    throw new RoomStoreError(
      "task_graph_version_overflow",
      `${label} cannot advance beyond Number.MAX_SAFE_INTEGER`,
    );
  }
  return value + 1;
}

function assertPositiveTaskGraphVersion(value: unknown, label: string): asserts value is number {
  assertTaskGraphVersion(value, label);
  if (value === 0) {
    throw new RoomStoreError("task_graph_invalid_mutation", `${label} must be greater than zero`);
  }
}

function assertTaskGraphTimestamp(value: unknown, label: string): asserts value is string {
  assertNonBlankTaskGraphString(value, label);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new RoomStoreError(
      "task_graph_invalid_mutation",
      `${label} must be a canonical UTC ISO timestamp`,
    );
  }
}

export async function loadRoomEvents(
  handle: QueryHandle,
  projectId: string,
  roomId: string,
  afterCursor?: string,
  options?: ListRoomEventsOptionsV1,
): Promise<RoomEventRecordV1[]> {
  const cursor = afterCursor === undefined ? undefined : Number(afterCursor);
  if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0)) {
    throw new Error(`Invalid Room event cursor: ${afterCursor}`);
  }
  const limit = normalizeRoomEventListLimit(options);
  const query = handle
    .select()
    .from(roomEvents)
    .where(cursor === undefined
      ? and(eq(roomEvents.projectId, projectId), eq(roomEvents.roomId, roomId))
      : and(
        eq(roomEvents.projectId, projectId),
        eq(roomEvents.roomId, roomId),
        gt(roomEvents.cursor, cursor),
      ))
    .orderBy(asc(roomEvents.cursor));
  const rows = limit === undefined ? await query : await query.limit(limit);
  return rows.map(rowToRoomEvent);
}

async function insertRoomEvent(
  tx: DbTransaction,
  aggregate: RoomAggregateV1,
  eventType: string,
  context: RoomCommandContext,
  payload: Readonly<Record<string, unknown>>,
): Promise<RoomEventRecordV1> {
  const id = context.eventId ?? `room-event-${randomUUID()}`;
  const inserted = await tx
    .insert(roomEvents)
    .values({
      id,
      projectId: aggregate.room.projectId,
      roomId: aggregate.room.id,
      aggregateVersion: aggregate.room.aggregateVersion,
      eventType,
      actorType: context.actorType,
      actorId: context.actorId,
      correlationId: context.correlationId,
      causationId: context.causationId,
      payload,
      occurredAt: context.occurredAt,
    })
    .returning({ cursor: roomEvents.cursor });
  const cursor = inserted[0]?.cursor;
  if (cursor === undefined) {
    throw new Error(`Room event ${id} did not return a durable cursor`);
  }
  return {
    contractVersion: 1,
    id,
    roomId: aggregate.room.id,
    projectId: aggregate.room.projectId,
    aggregateVersion: aggregate.room.aggregateVersion,
    eventType,
    actorType: context.actorType,
    actorId: context.actorId,
    correlationId: context.correlationId,
    causationId: context.causationId,
    payload,
    occurredAt: context.occurredAt,
    cursor: String(cursor),
  };
}

function validateMembershipChangeRequest(input: RequestRoomMembershipChangeInput): void {
  for (const [field, value] of Object.entries({
    roomId: input.roomId,
    changeId: input.changeId,
    idempotencyKey: input.idempotencyKey,
    reason: input.reason,
  })) {
    if (!value.trim()) {
      throw new RoomDomainError("membership_change_conflict", `${field} must not be empty`);
    }
  }
  if (input.activateAt !== "next_turn_boundary") {
    throw new RoomDomainError(
      "turn_boundary_required",
      "Membership changes must activate at the next durable turn boundary",
    );
  }
  for (const [field, value] of Object.entries({
    expectedAggregateVersion: input.expectedAggregateVersion,
    expectedMembershipVersion: input.expectedMembershipVersion,
  })) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RoomDomainError("membership_change_conflict", `${field} must be a non-negative safe integer`);
    }
  }
  if (!Number.isFinite(Date.parse(input.requestedAt))) {
    throw new RoomDomainError("membership_change_conflict", "requestedAt must be a valid timestamp");
  }
  if (input.mutation.action === "add") {
    if (!input.mutation.seat.id.trim() || !input.mutation.seat.role.trim()) {
      throw new RoomDomainError("membership_change_conflict", "Added seat identity and role are required");
    }
    if (
      input.mutation.seat.permissionScope.some((permission) => !permission.trim())
      || new Set(input.mutation.seat.permissionScope).size !== input.mutation.seat.permissionScope.length
    ) {
      throw new RoomDomainError("membership_change_conflict", "Added seat permissions must be unique non-empty strings");
    }
    validateMembershipBinding(input.mutation.binding);
  } else {
    if (!input.mutation.seatId.trim()) {
      throw new RoomDomainError("membership_change_conflict", "Membership seatId must not be empty");
    }
    if (input.mutation.action === "replace") validateMembershipBinding(input.mutation.replacement);
    if (input.mutation.action === "change_role" && !input.mutation.role.trim()) {
      throw new RoomDomainError("membership_change_conflict", "Replacement role must not be empty");
    }
  }
}

function validateMembershipBoundaryInput(
  input: ApplyRoomMembershipChangesAtTurnBoundaryInput,
): void {
  if (!input.roomId.trim() || !input.turnId.trim()) {
    throw new RoomDomainError("turn_boundary_required", "Room and turn identities are required");
  }
  if (!Number.isFinite(Date.parse(input.now))) {
    throw new RoomDomainError("turn_boundary_required", "Boundary time must be a valid timestamp");
  }
  for (const [field, value] of Object.entries({
    expectedAggregateVersion: input.expectedAggregateVersion,
    expectedMembershipVersion: input.expectedMembershipVersion,
  })) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RoomDomainError("membership_change_conflict", `${field} must be a non-negative safe integer`);
    }
  }
}

function validateMembershipBinding(binding: RoomBindingReplacementV1): void {
  for (const [field, value] of Object.entries({
    id: binding.id,
    connectorId: binding.connectorId,
    providerId: binding.providerId,
    nativeSessionId: binding.nativeSessionId,
    hostId: binding.hostId,
  })) {
    if (!value.trim()) {
      throw new RoomDomainError("binding_identity_conflict", `Binding ${field} must not be empty`);
    }
  }
}

function validateInitialExistingParticipants(
  participants: CreateRoomWithExistingBindingsInput["participants"],
): void {
  const seatIds = new Set<string>();
  const bindingIds = new Set<string>();
  const nativeIdentities = new Set<string>();
  const happierIdentities = new Set<string>();
  for (const participant of participants) {
    validateMembershipBinding(participant.binding);
    for (const [field, value] of Object.entries({
      happierSessionId: participant.binding.happierSessionId,
      serverProfileId: participant.binding.serverProfileId,
      machineId: participant.binding.machineId,
    })) {
      if (value !== null && !value.trim()) {
        throw new RoomDomainError(
          "binding_identity_conflict",
          `Initial existing-Session binding ${field} must be null or non-empty`,
        );
      }
    }
    if (!participant.seat.id.trim() || !participant.seat.role.trim()) {
      throw new RoomDomainError(
        "seat_identity_conflict",
        "Initial existing-Session seats require non-empty IDs and roles",
      );
    }
    if (
      participant.seat.permissionScope.some((permission) => !permission.trim())
      || new Set(participant.seat.permissionScope).size !== participant.seat.permissionScope.length
    ) {
      throw new RoomDomainError(
        "seat_identity_conflict",
        `Initial Room seat ${participant.seat.id} permissions must be unique non-empty strings`,
      );
    }
    if (seatIds.has(participant.seat.id)) {
      throw new RoomDomainError(
        "seat_identity_conflict",
        `Initial Room seat ${participant.seat.id} is duplicated`,
      );
    }
    if (bindingIds.has(participant.binding.id)) {
      throw new RoomDomainError(
        "binding_identity_conflict",
        `Initial Room binding ${participant.binding.id} is duplicated`,
      );
    }
    const nativeIdentity = `${participant.binding.providerId}\u0000${participant.binding.nativeSessionId}`;
    if (nativeIdentities.has(nativeIdentity)) {
      throw new RoomDomainError(
        "binding_identity_conflict",
        `Native Session ${participant.binding.providerId}:${participant.binding.nativeSessionId} is duplicated`,
      );
    }
    const happierIdentity = participant.binding.happierSessionId
      ? `${participant.binding.connectorId}\u0000${participant.binding.happierSessionId}`
      : null;
    if (happierIdentity && happierIdentities.has(happierIdentity)) {
      throw new RoomDomainError(
        "binding_identity_conflict",
        `Happier Session ${participant.binding.happierSessionId} is duplicated`,
      );
    }
    seatIds.add(participant.seat.id);
    bindingIds.add(participant.binding.id);
    nativeIdentities.add(nativeIdentity);
    if (happierIdentity) happierIdentities.add(happierIdentity);
  }
}

function assertMembershipVersions(
  aggregate: RoomAggregateV1,
  input: { readonly expectedAggregateVersion: number; readonly expectedMembershipVersion: number },
): void {
  if (aggregate.room.aggregateVersion !== input.expectedAggregateVersion) {
    throw new RoomDomainError(
      "aggregate_version_conflict",
      `Room ${aggregate.room.id} expected aggregate version ${input.expectedAggregateVersion} but is ${aggregate.room.aggregateVersion}`,
    );
  }
  if (aggregate.membershipVersion !== input.expectedMembershipVersion) {
    throw new RoomDomainError(
      "membership_version_conflict",
      `Room ${aggregate.room.id} expected membership version ${input.expectedMembershipVersion} but is ${aggregate.membershipVersion}`,
    );
  }
}

async function preparePendingMembershipChange(
  tx: DbTransaction,
  aggregate: RoomAggregateV1,
  input: RequestRoomMembershipChangeInput,
): Promise<PendingRoomMembershipChangeV1> {
  const existingIds = await tx
    .select({ id: roomMembershipChanges.id })
    .from(roomMembershipChanges)
    .where(eq(roomMembershipChanges.id, input.changeId))
    .limit(1);
  if (existingIds.length > 0 || aggregate.pendingMembershipChanges.some((change) => change.id === input.changeId)) {
    throw new RoomDomainError(
      "membership_change_conflict",
      `Membership change ${input.changeId} already exists`,
    );
  }
  const seatId = input.mutation.action === "add" ? input.mutation.seat.id : input.mutation.seatId;
  if (aggregate.pendingMembershipChanges.some((change) => change.seatId === seatId)) {
    throw new RoomDomainError(
      "membership_change_conflict",
      `Seat ${seatId} already has a pending membership change`,
    );
  }

  const base = {
    id: input.changeId,
    roomId: input.roomId,
    seatId,
    reason: input.reason,
    effectiveAfterTurnId: aggregate.activeTurnId,
    requestedAt: input.requestedAt,
    state: "waiting_turn_boundary" as const,
  };
  if (input.mutation.action === "add") {
    if (aggregate.seats.some((seat) => seat.id === seatId)) {
      throw new RoomDomainError("seat_identity_conflict", `Room seat ${seatId} already exists`);
    }
    await assertRoomBindingIdentityAvailable(tx, input.mutation.binding);
    return {
      ...base,
      kind: "add",
      seat: { ...input.mutation.seat, permissionScope: [...input.mutation.seat.permissionScope] },
      binding: { ...input.mutation.binding },
    };
  }

  const seat = aggregate.seats.find((candidate) => candidate.id === seatId);
  if (!seat || seat.state === "removed") {
    throw new RoomDomainError("seat_not_found", `Room seat ${seatId} does not exist or was removed`);
  }
  if (input.mutation.action !== "change_role" && !seat.activeBindingId) {
    throw new RoomDomainError("binding_not_found", `Seat ${seatId} has no active binding`);
  }
  switch (input.mutation.action) {
    case "remove":
      return { ...base, kind: "remove" };
    case "pause":
      return { ...base, kind: "pause" };
    case "replace":
      await assertRoomBindingIdentityAvailable(tx, input.mutation.replacement);
      return { ...base, kind: "replace", replacement: { ...input.mutation.replacement } };
    case "change_role":
      return { ...base, kind: "change_role", role: input.mutation.role };
  }
}

async function assertRoomBindingIdentityAvailable(
  tx: DbTransaction,
  binding: RoomBindingReplacementV1,
): Promise<void> {
  await lockRoomBindingIdentities(tx, [binding]);
  await assertRoomBindingIdentityAvailableAfterLock(tx, binding);
}

async function assertRoomBindingIdentityAvailableAfterLock(
  tx: DbTransaction,
  binding: RoomBindingReplacementV1,
): Promise<void> {
  const nativeRows = await tx
    .select({ id: roomBindings.id })
    .from(roomBindings)
    .where(and(
      eq(roomBindings.providerId, binding.providerId),
      eq(roomBindings.nativeSessionId, binding.nativeSessionId),
      inArray(roomBindings.state, ACTIVE_ROOM_BINDING_STATES),
    ))
    .limit(1);
  if (nativeRows.length > 0) {
    throw new RoomDomainError(
      "binding_identity_conflict",
      `Native Session ${binding.providerId}:${binding.nativeSessionId} already has an active Room binding`,
    );
  }
  const pendingNativeRows = await tx
    .select({ id: roomMembershipChanges.id })
    .from(roomMembershipChanges)
    .where(and(
      eq(roomMembershipChanges.reservedProviderId, binding.providerId),
      eq(roomMembershipChanges.reservedNativeSessionId, binding.nativeSessionId),
      eq(roomMembershipChanges.state, "waiting_turn_boundary"),
    ))
    .limit(1);
  if (pendingNativeRows.length > 0) {
    throw new RoomDomainError(
      "binding_identity_conflict",
      `Native Session ${binding.providerId}:${binding.nativeSessionId} already has a pending Room binding`,
    );
  }
  if (binding.happierSessionId) {
    const happierRows = await tx
      .select({ id: roomBindings.id })
      .from(roomBindings)
      .where(and(
        eq(roomBindings.connectorId, binding.connectorId),
        eq(roomBindings.happierSessionId, binding.happierSessionId),
        inArray(roomBindings.state, ACTIVE_ROOM_BINDING_STATES),
      ))
      .limit(1);
    if (happierRows.length > 0) {
      throw new RoomDomainError(
        "binding_identity_conflict",
        `Happier Session ${binding.happierSessionId} already has an active Room binding`,
      );
    }
    const pendingHappierRows = await tx
      .select({ id: roomMembershipChanges.id })
      .from(roomMembershipChanges)
      .where(and(
        eq(roomMembershipChanges.reservedConnectorId, binding.connectorId),
        eq(roomMembershipChanges.reservedHappierSessionId, binding.happierSessionId),
        eq(roomMembershipChanges.state, "waiting_turn_boundary"),
      ))
      .limit(1);
    if (pendingHappierRows.length > 0) {
      throw new RoomDomainError(
        "binding_identity_conflict",
        `Happier Session ${binding.happierSessionId} already has a pending Room binding`,
      );
    }
  }
}

async function lockRoomBindingIdentity(
  tx: DbTransaction,
  binding: {
    readonly connectorId: string;
    readonly providerId: string;
    readonly nativeSessionId: string;
    readonly happierSessionId?: string | null;
  },
): Promise<void> {
  await lockRoomBindingIdentities(tx, [binding]);
}

async function lockRoomBindingIdentities(
  tx: DbTransaction,
  bindings: readonly {
    readonly connectorId: string;
    readonly providerId: string;
    readonly nativeSessionId: string;
    readonly happierSessionId?: string | null;
  }[],
  additionalLockKeys: readonly string[] = [],
): Promise<void> {
  const lockKeys = [...new Set([
    ...additionalLockKeys,
    ...bindings.flatMap((binding) => [
      `fusion-room-native-session-v2:${binding.providerId}:${binding.nativeSessionId}`,
      ...(binding.happierSessionId
        ? [`fusion-room-happier-session-v2:${binding.connectorId}:${binding.happierSessionId}`]
        : []),
    ]),
  ])].sort();
  for (const lockKey of lockKeys) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
  }
}

function membershipChangePayload(
  change: PendingRoomMembershipChangeV1,
): Readonly<Record<string, unknown>> {
  return {
    seat: change.seat,
    binding: change.binding,
    replacement: change.replacement,
    role: change.role,
  };
}

function applyPendingMembershipChange(
  aggregate: RoomAggregateV1,
  change: PendingRoomMembershipChangeV1,
  now: string,
): RoomAggregateV1 {
  if (change.kind === "add") {
    if (!change.seat || !change.binding) {
      throw new RoomDomainError("membership_change_conflict", `Add change ${change.id} is incomplete`);
    }
    const seat = {
      contractVersion: 1 as const,
      id: change.seat.id,
      roomId: aggregate.room.id,
      role: change.seat.role,
      state: "active" as const,
      permissionScope: [...change.seat.permissionScope],
      activeBindingId: change.binding.id,
      roleVersion: 1,
      createdAt: now,
      updatedAt: now,
    };
    const binding = createMembershipBindingRecord(
      aggregate.room.id,
      seat.id,
      1,
      change.binding,
      now,
    );
    return { ...aggregate, seats: [...aggregate.seats, seat], bindings: [...aggregate.bindings, binding] };
  }

  const seat = aggregate.seats.find((candidate) => candidate.id === change.seatId);
  if (!seat) throw new RoomDomainError("seat_not_found", `Room seat ${change.seatId} does not exist`);
  const oldBinding = seat.activeBindingId
    ? aggregate.bindings.find((binding) => binding.id === seat.activeBindingId)
    : undefined;
  if (change.kind !== "change_role" && !oldBinding) {
    throw new RoomDomainError("binding_not_found", `Seat ${seat.id} has no active binding`);
  }
  if (change.kind === "pause") {
    return {
      ...aggregate,
      seats: aggregate.seats.map((candidate) => candidate.id === seat.id
        ? { ...candidate, state: "paused" as const, updatedAt: now }
        : candidate),
      bindings: aggregate.bindings.map((binding) => binding.id === oldBinding!.id
        ? { ...binding, state: "paused" as const }
        : binding),
    };
  }
  if (change.kind === "remove") {
    return {
      ...aggregate,
      seats: aggregate.seats.map((candidate) => candidate.id === seat.id
        ? { ...candidate, state: "removed" as const, activeBindingId: null, updatedAt: now }
        : candidate),
      bindings: aggregate.bindings.map((binding) => binding.id === oldBinding!.id
        ? { ...binding, state: "detached" as const, detachedAt: now }
        : binding),
    };
  }
  if (change.kind === "change_role") {
    if (!change.role) {
      throw new RoomDomainError("membership_change_conflict", `Role change ${change.id} has no role`);
    }
    return {
      ...aggregate,
      seats: aggregate.seats.map((candidate) => candidate.id === seat.id
        ? { ...candidate, role: change.role!, roleVersion: candidate.roleVersion + 1, updatedAt: now }
        : candidate),
    };
  }
  if (!change.replacement) {
    throw new RoomDomainError("membership_change_conflict", `Replacement ${change.id} is incomplete`);
  }
  const generation = aggregate.bindings.reduce(
    (highest, binding) => binding.seatId === seat.id ? Math.max(highest, binding.generation) : highest,
    0,
  ) + 1;
  const replacement = createMembershipBindingRecord(
    aggregate.room.id,
    seat.id,
    generation,
    change.replacement,
    now,
  );
  return {
    ...aggregate,
    seats: aggregate.seats.map((candidate) => candidate.id === seat.id
      ? { ...candidate, state: "active" as const, activeBindingId: replacement.id, updatedAt: now }
      : candidate),
    bindings: [
      ...aggregate.bindings.map((binding) => binding.id === oldBinding!.id
        ? {
            ...binding,
            state: "replaced" as const,
            detachedAt: now,
            replacedByBindingId: replacement.id,
          }
        : binding),
      replacement,
    ],
  };
}

function createMembershipBindingRecord(
  roomId: string,
  seatId: string,
  generation: number,
  binding: RoomBindingReplacementV1,
  now: string,
) {
  return {
    contractVersion: 1 as const,
    id: binding.id,
    roomId,
    seatId,
    generation,
    connectorId: binding.connectorId,
    providerId: binding.providerId,
    nativeSessionId: binding.nativeSessionId,
    happierSessionId: binding.happierSessionId,
    serverProfileId: binding.serverProfileId,
    machineId: binding.machineId,
    hostId: binding.hostId,
    state: "attached" as const,
    attachedAt: now,
    detachedAt: null,
    replacedByBindingId: null,
  };
}

async function persistAppliedMembershipChange(
  tx: DbTransaction,
  projectId: string,
  before: RoomAggregateV1,
  after: RoomAggregateV1,
  change: PendingRoomMembershipChangeV1,
  now: string,
): Promise<void> {
  const oldSeat = before.seats.find((seat) => seat.id === change.seatId);
  const newSeat = after.seats.find((seat) => seat.id === change.seatId);
  if (!newSeat) throw new RoomDomainError("seat_not_found", `Seat ${change.seatId} disappeared during activation`);
  if (change.kind === "add") {
    const binding = after.bindings.find((candidate) => candidate.id === newSeat.activeBindingId);
    if (!binding) throw new RoomDomainError("binding_not_found", `Added seat ${newSeat.id} has no binding`);
    await tx.insert(roomSeats).values({
      id: newSeat.id,
      projectId,
      roomId: newSeat.roomId,
      role: newSeat.role,
      roleVersion: newSeat.roleVersion,
      roleHistory: [],
      permissionScope: [...newSeat.permissionScope],
      state: newSeat.state,
      activeBindingId: newSeat.activeBindingId,
      createdAt: newSeat.createdAt,
      updatedAt: newSeat.updatedAt,
    });
    await tx.insert(roomBindings).values({
      ...binding,
      projectId,
      replacementReason: null,
    });
    return;
  }
  if (!oldSeat) throw new RoomDomainError("seat_not_found", `Seat ${change.seatId} has no prior lineage`);
  if (change.kind === "change_role") {
    const rows = await tx
      .select({ roleHistory: roomSeats.roleHistory })
      .from(roomSeats)
      .where(and(eq(roomSeats.projectId, projectId), eq(roomSeats.id, oldSeat.id)))
      .limit(1);
    const roleHistory = Array.isArray(rows[0]?.roleHistory) ? rows[0]!.roleHistory : [];
    await tx
      .update(roomSeats)
      .set({
        role: newSeat.role,
        roleVersion: newSeat.roleVersion,
        roleHistory: [...roleHistory, { role: oldSeat.role, roleVersion: oldSeat.roleVersion, endedAt: now }],
        updatedAt: now,
      })
      .where(and(eq(roomSeats.projectId, projectId), eq(roomSeats.id, oldSeat.id)));
    return;
  }
  const oldBinding = oldSeat.activeBindingId
    ? before.bindings.find((binding) => binding.id === oldSeat.activeBindingId)
    : undefined;
  if (!oldBinding) throw new RoomDomainError("binding_not_found", `Seat ${oldSeat.id} has no prior binding`);
  const nextOldBinding = after.bindings.find((binding) => binding.id === oldBinding.id);
  if (!nextOldBinding) throw new RoomDomainError("binding_not_found", `Binding ${oldBinding.id} lost its lineage`);
  await tx
    .update(roomSeats)
    .set({
      state: newSeat.state,
      activeBindingId: newSeat.activeBindingId,
      updatedAt: newSeat.updatedAt,
    })
    .where(and(eq(roomSeats.projectId, projectId), eq(roomSeats.id, oldSeat.id)));
  await tx
    .update(roomBindings)
    .set({
      state: nextOldBinding.state,
      detachedAt: nextOldBinding.detachedAt,
      replacedByBindingId: nextOldBinding.replacedByBindingId,
      replacementReason: change.kind === "replace" ? change.reason : null,
    })
    .where(and(eq(roomBindings.projectId, projectId), eq(roomBindings.id, oldBinding.id)));
  if (change.kind === "replace") {
    const replacement = after.bindings.find((binding) => binding.id === newSeat.activeBindingId);
    if (!replacement) throw new RoomDomainError("binding_not_found", `Replacement for seat ${newSeat.id} was not created`);
    await tx.insert(roomBindings).values({
      ...replacement,
      projectId,
      replacementReason: null,
    });
  }
}

function rowToPendingMembershipChange(
  row: typeof roomMembershipChanges.$inferSelect,
): PendingRoomMembershipChangeV1 {
  const payload = asRecord(row.payload);
  const common = {
    id: row.id,
    roomId: row.roomId,
    seatId: row.seatId,
    reason: row.reason,
    effectiveAfterTurnId: row.effectiveAfterTurnId,
    requestedAt: row.requestedAt,
    state: "waiting_turn_boundary" as const,
  };
  switch (row.kind) {
    case "add": {
      const seat = asRecord(payload.seat);
      const binding = payload.binding as RoomBindingReplacementV1 | undefined;
      if (!binding || typeof seat.id !== "string" || typeof seat.role !== "string") {
        throw new Error(`Room membership add change ${row.id} has an invalid payload`);
      }
      return {
        ...common,
        kind: "add",
        seat: {
          id: seat.id,
          role: seat.role,
          permissionScope: asStringArray(seat.permissionScope),
        },
        binding,
      };
    }
    case "remove":
      return { ...common, kind: "remove" };
    case "pause":
      return { ...common, kind: "pause" };
    case "replace": {
      const replacement = payload.replacement as RoomBindingReplacementV1 | undefined;
      if (!replacement) throw new Error(`Room membership replacement ${row.id} has no payload`);
      return { ...common, kind: "replace", replacement };
    }
    case "change_role":
      if (typeof payload.role !== "string") {
        throw new Error(`Room membership role change ${row.id} has no role payload`);
      }
      return { ...common, kind: "change_role", role: payload.role };
    default:
      throw new Error(`Room membership change ${row.id} has unsupported kind ${row.kind}`);
  }
}

function rowToRoomEvent(row: typeof roomEvents.$inferSelect): RoomEventRecordV1 {
  return {
    contractVersion: 1,
    id: row.id,
    roomId: row.roomId,
    projectId: row.projectId,
    aggregateVersion: Number(row.aggregateVersion),
    eventType: row.eventType,
    actorType: row.actorType as RoomEventActorType,
    actorId: row.actorId,
    correlationId: row.correlationId,
    causationId: row.causationId,
    payload: (row.payload ?? {}) as Readonly<Record<string, unknown>>,
    occurredAt: row.occurredAt,
    cursor: String(row.cursor),
  };
}

function asStringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}
