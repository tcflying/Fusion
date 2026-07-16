import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

import {
  RoomDomainError,
  createRoomAggregate,
  transitionRoomLifecycle,
  type CreateRoomAggregateInput,
  type PendingRoomMembershipChangeV1,
  type RoomAggregateV1,
  type RoomBindingReplacementV1,
  type TransitionRoomLifecycleInput,
} from "./room-domain.js";
import type {
  RoomEventRecordV1,
  RoomMessageRecordV1,
  RoomOutboxRecordV1,
} from "./room-contracts/storage.js";
import type { AsyncDataLayer, DbTransaction } from "./postgres/data-layer.js";
import { compareRoomText, hashRoomValue } from "./room-integrity.js";
import { cliSessions } from "./postgres/schema/project.js";
import {
  operationalRooms,
  roomBindings,
  roomEvents,
  roomIdempotencyKeys,
  roomInboxReceipts,
  roomMembershipChanges,
  roomMessages,
  roomOutbox,
  roomOutboxAttempts,
  roomSeats,
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

export type RoomCommittedEventListener = (
  event: RoomEventRecordV1,
) => void | Promise<void>;

export interface AsyncRoomStoreOptions {
  readonly projectId?: string;
  readonly onCommittedEvent?: RoomCommittedEventListener;
  readonly onNotificationError?: (error: unknown, event: RoomEventRecordV1) => void;
}

export type RoomStoreErrorCode =
  | "idempotency_conflict"
  | "idempotency_result_missing"
  | "delivery_target_conflict"
  | "delivery_state_conflict"
  | "delivery_attempt_conflict"
  | "inbox_payload_conflict"
  | "legacy_binding_not_found"
  | "legacy_binding_integrity_conflict"
  | "legacy_binding_already_imported";

export class RoomStoreError extends Error {
  readonly code: RoomStoreErrorCode;

  constructor(code: RoomStoreErrorCode, message: string) {
    super(message);
    this.name = "RoomStoreError";
    this.code = code;
  }
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

export interface EnqueueRoomMessageResult {
  readonly message: StoredRoomMessageV1;
  readonly deliveries: readonly RoomOutboxRecordV1[];
  readonly event: RoomEventRecordV1;
  readonly replayed: boolean;
}

export interface BeginRoomDeliveryAttemptInput {
  readonly outboxId: string;
  readonly attemptId: string;
  readonly now: string;
}

export interface CompleteRoomDeliveryAttemptInput {
  readonly outboxId: string;
  readonly attemptId: string;
  readonly outcome: "confirmed" | "delivery_uncertain" | "retryable_failure" | "rejected";
  readonly connectorAcknowledgementId: string | null;
  readonly nativeCursor: string | null;
  readonly errorCode: string | null;
  readonly nextAttemptAt: string | null;
  readonly now: string;
}

export interface RecordRoomInboxReceiptInput {
  readonly id: string;
  readonly roomId: string;
  readonly bindingId: string;
  readonly nativeMessageId: string | null;
  readonly nativeCursor: string;
  readonly payloadHash: string;
  readonly receivedAt: string;
}

export type RoomInboxReceiptV1 = RecordRoomInboxReceiptInput;

export type LegacyHappierBindingProviderId = "codex" | "claude" | "opencode";

export interface LegacyHappierBindingSourceV1 {
  readonly taskId: string;
  readonly cliSessionId: string;
  /** Legacy field: stores the Happier linked Session id, not the provider id. */
  readonly nativeSessionId: string;
  readonly providerId: LegacyHappierBindingProviderId;
  /** Official Happier remoteSessionId: the provider-native Session id. */
  readonly remoteSessionId: string;
  readonly machineId: string;
  readonly serverId: string;
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
    // FNXC:LegacyHappierIdentity 2026-07-17-05:03:
    // The old task bridge persisted Happier's `sessionId` in its misleading
    // `nativeSessionId` field and the actual provider id in `remoteSessionId`.
    // Normalize only at the Room boundary; never rewrite the legacy row that
    // the existing AgentRuntime still uses to address Happier CLI operations.
    const providerNativeSessionId = input.source.remoteSessionId;
    const happierSessionId = input.source.nativeSessionId;
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
        nativeSessionId: providerNativeSessionId,
        happierSessionId,
        serverProfileId: input.source.serverId,
        hostId: input.source.machineId,
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
        this.projectId,
        input.source.providerId,
        providerNativeSessionId,
      );
      await verifyLegacyHappierBindingSource(tx, this.projectId, input.source);

      const activeNativeOwners = await tx
        .select({ roomId: roomBindings.roomId, bindingId: roomBindings.id })
        .from(roomBindings)
        .where(and(
          eq(roomBindings.projectId, this.projectId),
          eq(roomBindings.providerId, input.source.providerId),
          eq(roomBindings.nativeSessionId, providerNativeSessionId),
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
          eq(roomBindings.projectId, this.projectId),
          eq(roomBindings.connectorId, "happier"),
          eq(roomBindings.happierSessionId, happierSessionId),
          inArray(roomBindings.state, ACTIVE_ROOM_BINDING_STATES),
        ))
        .limit(1);
      const activeHappierOwner = activeHappierOwners[0];
      if (activeHappierOwner) {
        throw new RoomStoreError(
          "legacy_binding_integrity_conflict",
          `Happier Session ${happierSessionId} already belongs to Room ${activeHappierOwner.roomId} as binding ${activeHappierOwner.bindingId}`,
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
        nativeSessionId: providerNativeSessionId,
        happierSessionId,
        serverProfileId: input.source.serverId,
        hostId: input.source.machineId,
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

  async listEvents(roomId: string, afterCursor?: string): Promise<RoomEventRecordV1[]> {
    return loadRoomEvents(this.layer.db, this.projectId, roomId, afterCursor);
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

      const outboxValues = input.deliveries.map((delivery) => ({
        id: delivery.id,
        projectId: this.projectId,
        roomId: input.roomId,
        messageId: input.message.id,
        bindingId: delivery.bindingId,
        logicalMessageId: input.message.id,
        idempotencyKey: `${input.idempotencyKey}:${delivery.bindingId}`,
        payloadHash: contentHash,
        deliveryState: "pending",
        nativeAcknowledgement: null,
        nativeCursor: null,
        attemptCount: 0,
        lastErrorCode: null,
        nextAttemptAt: null,
        createdAt: input.message.createdAt,
        updatedAt: input.message.createdAt,
      }));
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
    return this.layer.transactionImmediate(async (tx) => {
      const rows = await tx
        .select()
        .from(roomOutbox)
        .where(and(eq(roomOutbox.projectId, this.projectId), eq(roomOutbox.id, input.outboxId)))
        .limit(1);
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

      const attempt = current.attemptCount + 1;
      const updated = await tx
        .update(roomOutbox)
        .set({
          deliveryState: "dispatching",
          attemptCount: attempt,
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

  async completeDeliveryAttempt(
    input: CompleteRoomDeliveryAttemptInput,
  ): Promise<RoomOutboxRecordV1> {
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

      const nextState = deliveryStateForOutcome(input.outcome);
      const updated = await tx
        .update(roomOutbox)
        .set({
          deliveryState: nextState,
          nativeAcknowledgement: input.connectorAcknowledgementId
            ? { id: input.connectorAcknowledgementId }
            : null,
          nativeCursor: input.nativeCursor,
          lastErrorCode: input.errorCode,
          nextAttemptAt: input.outcome === "retryable_failure" ? input.nextAttemptAt : null,
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
      return rowToOutboxRecord(updatedRow);
    });
  }

  async recordInboxReceipt(
    input: RecordRoomInboxReceiptInput,
  ): Promise<RoomInboxReceiptV1> {
    return this.layer.transactionImmediate(async (tx) => {
      const bindingRows = await tx
        .select({ id: roomBindings.id })
        .from(roomBindings)
        .where(
          and(
            eq(roomBindings.projectId, this.projectId),
            eq(roomBindings.roomId, input.roomId),
            eq(roomBindings.id, input.bindingId),
          ),
        )
        .limit(1);
      if (bindingRows.length !== 1) {
        throw new RoomStoreError(
          "delivery_target_conflict",
          `Binding ${input.bindingId} does not belong to Room ${input.roomId}`,
        );
      }

      const inserted = await tx
        .insert(roomInboxReceipts)
        .values({
          id: input.id,
          projectId: this.projectId,
          roomId: input.roomId,
          bindingId: input.bindingId,
          nativeMessageId: input.nativeMessageId,
          nativeCursor: input.nativeCursor,
          payloadHash: input.payloadHash,
          receivedAt: input.receivedAt,
        })
        .onConflictDoNothing()
        .returning();
      if (inserted[0]) return rowToInboxReceipt(inserted[0]);

      const existingRows = await tx
        .select()
        .from(roomInboxReceipts)
        .where(
          and(
            eq(roomInboxReceipts.projectId, this.projectId),
            eq(roomInboxReceipts.roomId, input.roomId),
            eq(roomInboxReceipts.bindingId, input.bindingId),
            eq(roomInboxReceipts.nativeCursor, input.nativeCursor),
          ),
        )
        .limit(1);
      const existing = existingRows[0];
      if (!existing) {
        throw new RoomStoreError(
          "delivery_state_conflict",
          `Inbox receipt ${input.id} conflicted outside its native cursor`,
        );
      }
      if (existing.payloadHash !== input.payloadHash) {
        throw new RoomStoreError(
          "inbox_payload_conflict",
          `Inbox native cursor ${input.nativeCursor} was replayed with a different payload hash`,
        );
      }
      return rowToInboxReceipt(existing);
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

function rowToOutboxRecord(row: typeof roomOutbox.$inferSelect): RoomOutboxRecordV1 {
  const acknowledgement = asRecord(row.nativeAcknowledgement);
  return {
    contractVersion: 1,
    id: row.id,
    roomId: row.roomId,
    logicalMessageId: row.logicalMessageId,
    bindingId: row.bindingId,
    idempotencyKey: row.idempotencyKey,
    payloadHash: row.payloadHash,
    state: row.deliveryState as RoomOutboxRecordV1["state"],
    attemptCount: row.attemptCount,
    connectorAcknowledgementId:
      typeof acknowledgement.id === "string" ? acknowledgement.id : null,
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
    nativeCursor: row.nativeCursor,
    payloadHash: row.payloadHash,
    receivedAt: row.receivedAt,
  };
}

function deliveryStateForOutcome(
  outcome: CompleteRoomDeliveryAttemptInput["outcome"],
): RoomOutboxRecordV1["state"] {
  switch (outcome) {
    case "confirmed":
      return "confirmed";
    case "delivery_uncertain":
      return "delivery_uncertain";
    case "retryable_failure":
      return "pending";
    case "rejected":
      return "rejected";
  }
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
    ["source.remoteSessionId", input.source.remoteSessionId],
    ["source.machineId", input.source.machineId],
    ["source.serverId", input.source.serverId],
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
  projectId: string,
  providerId: LegacyHappierBindingProviderId,
  nativeSessionId: string,
): Promise<void> {
  const lockKey = `fusion-room-native-session-v1:${projectId}:${providerId}:${nativeSessionId}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
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
    || row.nativeSessionId !== source.nativeSessionId
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
  const persistedSnapshot = {
    cliSessionId: persisted.cliSessionId,
    nativeSessionId: persisted.nativeSessionId,
    providerId: persisted.providerId,
    remoteSessionId: persisted.remoteSessionId,
    machineId: persisted.machineId,
    serverId: persisted.serverId,
    linkedAt: persisted.linkedAt,
  };
  const expectedSnapshot = {
    cliSessionId: source.cliSessionId,
    nativeSessionId: source.nativeSessionId,
    providerId: source.providerId,
    remoteSessionId: source.remoteSessionId,
    machineId: source.machineId,
    serverId: source.serverId,
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

export async function loadRoomEvents(
  handle: QueryHandle,
  projectId: string,
  roomId: string,
  afterCursor?: string,
): Promise<RoomEventRecordV1[]> {
  const cursor = afterCursor === undefined ? undefined : Number(afterCursor);
  if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0)) {
    throw new Error(`Invalid Room event cursor: ${afterCursor}`);
  }
  const rows = await handle
    .select()
    .from(roomEvents)
    .where(and(eq(roomEvents.projectId, projectId), eq(roomEvents.roomId, roomId)))
    .orderBy(asc(roomEvents.cursor));
  return rows
    .filter((row) => cursor === undefined || Number(row.cursor) > cursor)
    .map(rowToRoomEvent);
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

function rowToPendingMembershipChange(
  row: typeof roomMembershipChanges.$inferSelect,
): PendingRoomMembershipChangeV1 {
  const payload = row.payload as { replacement?: RoomBindingReplacementV1 };
  if (!payload.replacement) {
    throw new Error(`Room membership change ${row.id} has no replacement payload`);
  }
  return {
    id: row.id,
    roomId: row.roomId,
    seatId: row.seatId,
    kind: "replace_binding",
    replacement: payload.replacement,
    reason: row.reason,
    effectiveAfterTurnId: row.effectiveAfterTurnId,
    requestedAt: row.requestedAt,
    state: "waiting_turn_boundary",
  };
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
