import {
  SESSION_CONNECTOR_CAPABILITIES,
  addRoomSeat,
  attachRoomBinding,
  buildRoomConnectorLocalMessageId,
  createRoomAggregate,
  hashRoomValue,
  type BeginRoomDeliveryAttemptInput,
  type CompleteRoomDeliveryAttemptInput,
  type CreateRoomAggregateInput,
  type CreateRoomWithExistingBindingsInput,
  type GetRoomConnectorIngestionStateInput,
  type ReconcileRoomDeliveryInput,
  type RecordRoomConnectorIngestionModeInput,
  type RecordRoomConnectorStatusInput,
  type RecordRoomConnectorTranscriptBatchInput,
  type RoomAggregateV1,
  type RoomAuthorityEnvelopeV1,
  type RoomBindingRecordV1,
  type RoomBindingReplacementV1,
  type RoomCommandContext,
  type RoomControllerCommandEnvelopeV1,
  type RoomConnectorIngestionStateV1,
  type RoomConnectorTranscriptBatchResultV1,
  type RoomInboxReceiptV1,
  type RoomMessageIntent,
  type RoomOutboxRecordV1,
  type RouteOperatorMessageResultV1,
  type SessionConnectorCapabilitiesV1,
  type SessionConnectorCapabilityName,
  type SessionConnectorCapabilityState,
  type SessionConnectorDeepLinksV1,
  type SessionConnectorEventV1,
  type SessionConnectorHealthV1,
  type SessionConnectorHistoryItemV1,
  type SessionConnectorIdentityV1,
  type SessionConnectorResultV1,
  type SessionConnectorSendReceiptV1,
  type SessionConnectorV1,
} from "@fusion/core";
import { describe, expect, it, vi } from "vitest";

import {
  RoomExistingSessionSpine as ProductionRoomExistingSessionSpine,
} from "../room-existing-session-spine.js";
import { SessionConnectorRegistry } from "../session-connector-registry.js";

const NOW = "2026-07-17T12:00:00.000Z";
const PROJECT_ID = "project-existing-session-spine";
const ROOM_ID = "room-existing-session-spine";
const CONNECTOR_ID = "happier-deterministic-double";

const EXISTING_SESSIONS = [
  {
    seatId: "seat-codex",
    bindingId: "binding-codex-generation-1",
    role: "implementer",
    canonicalSessionUri: "codex://threads/codex-existing-thread-1",
    identity: {
      connectorId: CONNECTOR_ID,
      providerId: "codex",
      nativeSessionId: "codex-existing-thread-1",
      happierSessionId: "happier-codex-existing-1",
      serverProfileId: "server-profile-existing-spine",
      machineId: "machine-existing-spine",
      hostId: "windows-host-existing-spine",
    },
  },
  {
    seatId: "seat-claude",
    bindingId: "binding-claude-generation-1",
    role: "reviewer",
    canonicalSessionUri: "claude://sessions/claude-existing-session-2",
    identity: {
      connectorId: CONNECTOR_ID,
      providerId: "claude",
      nativeSessionId: "claude-existing-session-2",
      happierSessionId: "happier-claude-existing-2",
      serverProfileId: "server-profile-existing-spine",
      machineId: "machine-existing-spine",
      hostId: "windows-host-existing-spine",
    },
  },
] as const satisfies readonly {
  readonly seatId: string;
  readonly bindingId: string;
  readonly role: string;
  readonly canonicalSessionUri: string;
  readonly identity: SessionConnectorIdentityV1;
}[];

function ok<T>(value: T): SessionConnectorResultV1<T> {
  return { ok: true, value };
}

function unavailable(message: string): SessionConnectorResultV1<never> {
  return {
    ok: false,
    error: { code: "unavailable", message, retryable: false },
  };
}

function ensuredExisting(
  identity: SessionConnectorIdentityV1,
): SessionConnectorResultV1<{
  readonly identity: SessionConnectorIdentityV1;
  readonly createdLink: false;
  readonly providerTurnStarted: false;
  readonly attachedAt: string;
  readonly capabilities: SessionConnectorCapabilitiesV1;
}> {
  return ok({
    identity,
    createdLink: false,
    providerTurnStarted: false,
    attachedAt: NOW,
    capabilities: capabilityMatrix(),
  });
}

function capabilityMatrix(): SessionConnectorCapabilitiesV1 {
  const capabilities = Object.fromEntries(
    SESSION_CONNECTOR_CAPABILITIES.map((name) => {
      const state: SessionConnectorCapabilityState = name === "create"
        ? "unavailable"
        : "verified";
      return [name, {
        state,
        evidenceRef: state === "verified"
          ? `deterministic-connector-double://${name}`
          : null,
        reasonCode: state === "verified" ? null : "operation_unavailable",
        lastVerifiedAt: state === "verified" ? NOW : null,
      }];
    }),
  ) as unknown as SessionConnectorCapabilitiesV1["capabilities"];
  return {
    contractVersion: 1,
    connectorId: CONNECTOR_ID,
    connectorVersion: "deterministic-test-double-v1",
    sourceRevision: "deterministic-test-double-not-live-provider",
    verifiedAt: NOW,
    capabilities,
  };
}

function healthCapabilities(): SessionConnectorHealthV1["capabilities"] {
  return Object.fromEntries(
    SESSION_CONNECTOR_CAPABILITIES.map((name) => [
      name,
      name === "create" ? "unavailable" : "verified",
    ]),
  ) as SessionConnectorHealthV1["capabilities"];
}

function createDeterministicConnectorDouble(): SessionConnectorV1 {
  const byUri = new Map(
    EXISTING_SESSIONS.map((session) => [session.canonicalSessionUri, session.identity]),
  );
  const eventsByNativeSession = new Map<string, readonly SessionConnectorEventV1[]>();
  const ensureExisting = vi.fn<SessionConnectorV1["ensureExisting"]>(async (input) => {
    const identity = byUri.get(input.canonicalSessionUri);
    if (!identity) return unavailable("Unknown deterministic existing Session URI");
    return ok({
      identity,
      createdLink: false,
      providerTurnStarted: false,
      attachedAt: NOW,
      capabilities: capabilityMatrix(),
    });
  });

  return {
    contractVersion: 1,
    id: CONNECTOR_ID,
    version: "deterministic-test-double-v1",
    getCapabilities: vi.fn(async () => capabilityMatrix()),
    ensureExisting,
    create: vi.fn(async () => unavailable("Creation is forbidden in this existing-Session proof")),
    getStatus: vi.fn(async (identity) => ok({
      identity,
      state: "idle",
      lastActivityAt: NOW,
      connectorCursor: null,
      nativeWriterDetected: false,
    })),
    readHistory: vi.fn(async (input) => ok({
      items: [],
      nextCursor: input.afterCursor,
      completeThroughCursor: input.afterCursor,
    })),
    subscribeEvents: vi.fn(async (identity) => {
      const events = eventsByNativeSession.get(identity.nativeSessionId) ?? [];
      return ok((async function* deterministicEvents() {
        for (const event of events) yield event;
      })());
    }),
    send: vi.fn(async (input) => {
      const responseCursor = `cursor-${input.identity.providerId}-response-1`;
      const statusCursor = `status-${input.identity.providerId}-idle-1`;
      const response: SessionConnectorHistoryItemV1 = {
        nativeMessageId: `native-${input.identity.providerId}-response-1`,
        logicalMessageId: input.logicalMessageId,
        role: "assistant",
        contentHash: hashRoomValue(`deterministic-${input.identity.providerId}-response`),
        occurredAt: NOW,
        cursor: responseCursor,
      };
      eventsByNativeSession.set(input.identity.nativeSessionId, [
        {
          connectorEventId: `event-${input.identity.providerId}-response-1`,
          identity: input.identity,
          eventType: "message",
          cursor: responseCursor,
          occurredAt: NOW,
          payload: {
            type: "transcript_delta",
            fromCursor: null,
            nextCursor: responseCursor,
            completeThroughCursor: responseCursor,
            truncated: false,
            items: [response],
          },
        },
        {
          connectorEventId: `event-${input.identity.providerId}-status-1`,
          identity: input.identity,
          eventType: "status",
          cursor: statusCursor,
          occurredAt: NOW,
          payload: {
            type: "status",
            state: "idle",
            lastActivityAt: NOW,
            connectorCursor: responseCursor,
            nativeWriterDetected: false,
          },
        },
      ]);
      return ok<SessionConnectorSendReceiptV1>({
        outcome: "confirmed",
        connectorAcknowledgementId: `ack-${input.identity.providerId}-request-1`,
        nativeMessageId: `native-${input.identity.providerId}-request-1`,
        cursor: `cursor-${input.identity.providerId}-request-1`,
        acceptedAt: NOW,
      });
    }),
    interrupt: vi.fn(async () => unavailable("Not used by this deterministic proof")),
    resume: vi.fn(async () => unavailable("Not used by this deterministic proof")),
    takeover: vi.fn(async () => unavailable("Not used by this deterministic proof")),
    getHealth: vi.fn(async (hostId) => ({
      connectorId: CONNECTOR_ID,
      hostId,
      state: "healthy",
      checkedAt: NOW,
      authentication: "authenticated",
      daemon: "running",
      server: "reachable",
      backend: "ready",
      rateLimit: "clear",
      host: "reachable",
      capabilities: healthCapabilities(),
      reasonCodes: [],
      retryAfterMs: null,
    })),
    getDeepLinks: vi.fn(async (input) => ok<SessionConnectorDeepLinksV1>({
      contractVersion: 1,
      bindingId: input.bindingId,
      ...input.identity,
      happierUrl: null,
      nativeSessionUrl: null,
    })),
  };
}

interface AttachExactExistingSeatInput {
  readonly roomId: string;
  readonly expectedAggregateVersion: number;
  readonly seat: {
    readonly id: string;
    readonly role: string;
    readonly permissionScope: readonly string[];
  };
  readonly binding: RoomBindingReplacementV1;
  readonly now: string;
}

class DurableExistingSessionRoomStore {
  private readonly rooms = new Map<string, RoomAggregateV1>();
  private readonly deliveries = new Map<string, RoomOutboxRecordV1>();
  private readonly histories = new Map<string, RoomInboxReceiptV1[]>();
  private readonly ingestionStates = new Map<string, RoomConnectorIngestionStateV1>();
  readonly createInputs: CreateRoomWithExistingBindingsInput[] = [];
  readonly routeInputs: RoomControllerCommandEnvelopeV1[] = [];
  readonly beginDeliveryInputs: BeginRoomDeliveryAttemptInput[] = [];
  private eventCursor = 0;

  async createRoomWithExistingBindings(
    input: CreateRoomWithExistingBindingsInput,
    _context: RoomCommandContext,
  ): Promise<RoomAggregateV1> {
    this.createInputs.push(input);
    if (this.rooms.has(input.room.id)) throw new Error(`Room ${input.room.id} already exists`);
    let aggregate = createRoomAggregate({
      ...input.room,
      projectId: PROJECT_ID,
      now: input.now,
    });
    for (const participant of input.participants) {
      aggregate = addRoomSeat(aggregate, {
        ...participant.seat,
        expectedAggregateVersion: aggregate.room.aggregateVersion,
        now: input.now,
      });
      aggregate = attachRoomBinding(aggregate, {
        ...participant.binding,
        seatId: participant.seat.id,
        expectedAggregateVersion: aggregate.room.aggregateVersion,
        now: input.now,
      });
    }
    const committed = {
      ...aggregate,
      room: { ...aggregate.room, aggregateVersion: 0 },
      membershipVersion: 1,
    };
    this.rooms.set(input.room.id, committed);
    return committed;
  }

  async createRoom(
    input: CreateRoomAggregateInput,
    _context: RoomCommandContext,
  ): Promise<RoomAggregateV1> {
    const aggregate = createRoomAggregate(input);
    this.rooms.set(input.id, aggregate);
    return aggregate;
  }

  async attachExactExistingSeat(
    input: AttachExactExistingSeatInput,
    _context: RoomCommandContext,
  ): Promise<RoomAggregateV1> {
    const current = this.rooms.get(input.roomId);
    if (!current) throw new Error(`Room ${input.roomId} is not durable`);
    const withSeat = addRoomSeat(current, {
      id: input.seat.id,
      role: input.seat.role,
      permissionScope: input.seat.permissionScope,
      expectedAggregateVersion: input.expectedAggregateVersion,
      now: input.now,
    });
    const withBinding = attachRoomBinding(withSeat, {
      ...input.binding,
      seatId: input.seat.id,
      expectedAggregateVersion: withSeat.room.aggregateVersion,
      now: input.now,
    });
    const committed = {
      ...withBinding,
      membershipVersion: current.membershipVersion + 1,
    };
    this.rooms.set(input.roomId, committed);
    return committed;
  }

  async getRoom(roomId: string): Promise<RoomAggregateV1 | undefined> {
    return this.rooms.get(roomId);
  }

  async routeOperatorMessage(
    envelope: RoomControllerCommandEnvelopeV1,
  ): Promise<RouteOperatorMessageResultV1> {
    this.routeInputs.push(envelope);
    if (envelope.command.type !== "route_message") throw new Error("Expected a route_message command");
    const current = this.rooms.get(envelope.roomId);
    if (!current) throw new Error(`Room ${envelope.roomId} is not durable`);
    if (current.room.aggregateVersion !== envelope.expectedAggregateVersion) {
      throw new Error(`Room ${envelope.roomId} aggregate version drifted`);
    }
    if (
      envelope.authority.actorType !== "human"
      || !envelope.authority.allowedActions.includes("room:message:route")
      || envelope.command.target.kind !== "seats"
      || envelope.command.target.seatIds.length !== 1
    ) {
      throw Object.assign(new Error("Invalid deterministic route command"), { code: "routing_command_invalid" });
    }
    const seatId = envelope.command.target.seatIds[0]!;
    if (!envelope.authority.seatIds.includes(seatId)) {
      throw Object.assign(new Error("Authority excludes the targeted seat"), { code: "authority_scope_violation" });
    }
    const seat = current.seats.find((candidate) => candidate.id === seatId);
    const binding = current.bindings.find((candidate) => candidate.id === seat?.activeBindingId);
    if (!seat || !binding || binding.state !== "attached") {
      throw Object.assign(new Error("Target seat has no attached binding"), { code: "routing_target_not_found" });
    }
    const messageId = `routed-message:${envelope.commandId}`;
    const targetId = `routed-target:${envelope.commandId}`;
    const outboxId = `routed-outbox:${envelope.commandId}`;
    const next: RoomAggregateV1 = {
      ...current,
      room: {
        ...current.room,
        aggregateVersion: current.room.aggregateVersion + 1,
        updatedAt: envelope.issuedAt,
      },
    };
    this.rooms.set(envelope.roomId, next);
    const idempotencyKey = `${envelope.idempotencyKey}:${binding.id}`;
    const localIdentity = {
      logicalMessageId: messageId,
      bindingId: binding.id,
      idempotencyKey,
      payloadHash: envelope.command.contentHash,
    };
    const delivery: RoomOutboxRecordV1 = {
      contractVersion: 1,
      id: outboxId,
      roomId: envelope.roomId,
      ...localIdentity,
      localMessageId: buildRoomConnectorLocalMessageId(localIdentity),
      state: "pending",
      attemptCount: 0,
      connectorAcknowledgementId: null,
      nativeMessageId: null,
      nativeCursor: null,
      reconciliationFromCursor: null,
      reconciliationEvidenceRef: null,
      lastErrorCode: null,
      nextAttemptAt: null,
      updatedAt: envelope.issuedAt,
    };
    this.deliveries.set(delivery.id, delivery);
    const context: RoomCommandContext = {
      eventId: `routed-event:${envelope.commandId}`,
      actorType: "human",
      actorId: envelope.authority.actorId,
      correlationId: envelope.correlationId,
      causationId: envelope.commandId,
      occurredAt: envelope.issuedAt,
    };
    const event = this.roomEvent(next, "message_routed", context, {
      messageId,
      targetIds: [targetId],
      outboxIds: [outboxId],
    });
    return {
      message: {
        contractVersion: 1,
        id: messageId,
        roomId: envelope.roomId,
        turnId: current.activeTurnId,
        nodeId: envelope.command.nodeId,
        originType: "operator",
        originId: envelope.authority.actorId,
        targetSeatIds: [seatId],
        intent: envelope.command.intent,
        contentHash: envelope.command.contentHash,
        authorityEnvelope: envelope.authority,
        createdAt: envelope.issuedAt,
        content: envelope.command.content,
        target: envelope.command.target,
        idempotencyKey: envelope.idempotencyKey,
        expectedAggregateVersion: envelope.expectedAggregateVersion,
      },
      targets: [{
        contractVersion: 1,
        id: targetId,
        projectId: PROJECT_ID,
        roomId: envelope.roomId,
        messageId,
        selectorKind: "seats",
        selectorRef: null,
        targetKind: "seat",
        seatId,
        bindingId: binding.id,
        ordinal: 0,
        createdAt: envelope.issuedAt,
      }],
      deliveries: [delivery],
      event,
      replayed: false,
    };
  }

  async getDelivery(outboxId: string): Promise<RoomOutboxRecordV1 | null> {
    return this.deliveries.get(outboxId) ?? null;
  }

  async getBinding(bindingId: string): Promise<RoomBindingRecordV1 | null> {
    for (const room of this.rooms.values()) {
      const binding = room.bindings.find((candidate) => candidate.id === bindingId);
      if (binding) return binding;
    }
    return null;
  }

  async beginDeliveryAttempt(
    input: BeginRoomDeliveryAttemptInput,
  ): Promise<RoomOutboxRecordV1> {
    this.beginDeliveryInputs.push(input);
    const current = this.requireDelivery(input.outboxId);
    if (current.state !== "pending") throw new Error(`Outbox ${input.outboxId} is not pending`);
    const next: RoomOutboxRecordV1 = {
      ...current,
      state: "dispatching",
      attemptCount: current.attemptCount + 1,
      connectorAcknowledgementId: null,
      nativeMessageId: null,
      nativeCursor: null,
      reconciliationFromCursor: input.reconciliationFromCursor,
      reconciliationEvidenceRef: null,
      lastErrorCode: null,
      nextAttemptAt: null,
      updatedAt: input.now,
    };
    this.deliveries.set(next.id, next);
    return next;
  }

  async completeDeliveryAttempt(
    input: CompleteRoomDeliveryAttemptInput,
  ): Promise<RoomOutboxRecordV1> {
    const current = this.requireDelivery(input.outboxId);
    if (current.state !== "dispatching") {
      throw new Error(`Outbox ${input.outboxId} is not dispatching`);
    }
    const state: RoomOutboxRecordV1["state"] = input.outcome === "confirmed"
      ? "confirmed"
      : input.outcome === "rejected"
        ? "rejected"
        : input.outcome === "retryable_failure"
          ? "pending"
          : "delivery_uncertain";
    const next: RoomOutboxRecordV1 = {
      ...current,
      state,
      connectorAcknowledgementId: input.connectorAcknowledgementId,
      nativeMessageId: input.nativeMessageId,
      nativeCursor: input.nativeCursor,
      lastErrorCode: input.errorCode,
      nextAttemptAt: input.nextAttemptAt,
      updatedAt: input.now,
    };
    this.deliveries.set(next.id, next);
    return next;
  }

  async reconcileDelivery(input: ReconcileRoomDeliveryInput): Promise<RoomOutboxRecordV1> {
    const current = this.requireDelivery(input.outboxId);
    const next: RoomOutboxRecordV1 = {
      ...current,
      state: input.outcome,
      connectorAcknowledgementId: input.connectorAcknowledgementId,
      nativeMessageId: input.nativeMessageId,
      nativeCursor: input.nativeCursor,
      reconciliationEvidenceRef: input.evidenceRef,
      lastErrorCode: input.errorCode,
      updatedAt: input.now,
    };
    this.deliveries.set(next.id, next);
    return next;
  }

  async getConnectorIngestionState(
    input: GetRoomConnectorIngestionStateInput,
  ): Promise<RoomConnectorIngestionStateV1> {
    return this.ingestionStates.get(input.bindingId)
      ?? this.initialIngestionState(input.roomId, input.bindingId);
  }

  async recordConnectorTranscriptBatch(
    input: RecordRoomConnectorTranscriptBatchInput,
  ): Promise<RoomConnectorTranscriptBatchResultV1> {
    const current = await this.getConnectorIngestionState(input);
    if (current.transcriptCursor !== input.fromCursor) {
      const gapState = {
        ...current,
        mode: "reconciling" as const,
        gapExpectedCursor: current.transcriptCursor,
        gapObservedCursor: input.fromCursor,
        gapDetectedAt: input.receivedAt,
        updatedAt: input.receivedAt,
      };
      this.ingestionStates.set(input.bindingId, gapState);
      return {
        state: gapState,
        insertedCount: 0,
        duplicateCount: 0,
        duplicateNativeMessageIdCount: 0,
        duplicatePayloadHashCount: 0,
        gapDetected: true,
      };
    }
    const history = this.histories.get(input.bindingId) ?? [];
    let insertedCount = 0;
    let duplicateNativeMessageIdCount = 0;
    let duplicatePayloadHashCount = 0;
    for (const item of input.items) {
      if (item.nativeMessageId && history.some((entry) => entry.nativeMessageId === item.nativeMessageId)) {
        duplicateNativeMessageIdCount += 1;
        continue;
      }
      if (history.some((entry) => entry.payloadHash === item.payloadHash)) {
        duplicatePayloadHashCount += 1;
        continue;
      }
      history.push({
        id: `receipt-${input.bindingId}-${item.nativeCursor}`,
        roomId: input.roomId,
        bindingId: input.bindingId,
        nativeMessageId: item.nativeMessageId,
        logicalMessageId: item.logicalMessageId,
        nativeCursor: item.nativeCursor,
        payloadHash: item.payloadHash,
        role: item.role,
        occurredAt: item.occurredAt,
        source: input.source,
        receivedAt: input.receivedAt,
      });
      insertedCount += 1;
    }
    this.histories.set(input.bindingId, history);
    const last = input.items.at(-1);
    const state: RoomConnectorIngestionStateV1 = {
      ...current,
      mode: input.modeAfterCommit,
      transcriptCursor: input.nextCursor,
      lastNativeMessageId: last?.nativeMessageId ?? current.lastNativeMessageId,
      lastPayloadHash: last?.payloadHash ?? current.lastPayloadHash,
      gapExpectedCursor: null,
      gapObservedCursor: null,
      gapDetectedAt: null,
      lastTranscriptAt: input.receivedAt,
      updatedAt: input.receivedAt,
    };
    this.ingestionStates.set(input.bindingId, state);
    return {
      state,
      insertedCount,
      duplicateCount: duplicateNativeMessageIdCount + duplicatePayloadHashCount,
      duplicateNativeMessageIdCount,
      duplicatePayloadHashCount,
      gapDetected: false,
    };
  }

  async recordConnectorStatus(
    input: RecordRoomConnectorStatusInput,
  ): Promise<RoomConnectorIngestionStateV1> {
    const current = await this.getConnectorIngestionState(input);
    const state: RoomConnectorIngestionStateV1 = {
      ...current,
      statusCursor: input.statusCursor,
      connectorStatus: input.state,
      nativeWriterDetected: input.nativeWriterDetected,
      lastStatusAt: input.occurredAt,
      updatedAt: input.occurredAt,
    };
    this.ingestionStates.set(input.bindingId, state);
    return state;
  }

  async recordConnectorIngestionMode(
    input: RecordRoomConnectorIngestionModeInput,
  ): Promise<RoomConnectorIngestionStateV1> {
    const current = await this.getConnectorIngestionState(input);
    const state: RoomConnectorIngestionStateV1 = {
      ...current,
      mode: input.mode,
      lastModeAt: input.occurredAt,
      updatedAt: input.occurredAt,
    };
    this.ingestionStates.set(input.bindingId, state);
    return state;
  }

  listPersistedHistory(bindingId: string): readonly RoomInboxReceiptV1[] {
    return this.histories.get(bindingId) ?? [];
  }

  private requireDelivery(outboxId: string): RoomOutboxRecordV1 {
    const delivery = this.deliveries.get(outboxId);
    if (!delivery) throw new Error(`Outbox ${outboxId} is not durable`);
    return delivery;
  }

  private initialIngestionState(roomId: string, bindingId: string): RoomConnectorIngestionStateV1 {
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
      gapExpectedCursor: null,
      gapObservedCursor: null,
      gapDetectedAt: null,
      lastTranscriptAt: null,
      lastStatusAt: null,
      lastModeAt: null,
      updatedAt: null,
    };
  }

  private roomEvent(
    aggregate: RoomAggregateV1,
    eventType: string,
    context: RoomCommandContext,
    payload: Readonly<Record<string, unknown>>,
  ) {
    this.eventCursor += 1;
    return {
      contractVersion: 1 as const,
      id: context.eventId ?? `event-${this.eventCursor}`,
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
      cursor: String(this.eventCursor),
    };
  }
}

interface ExactExistingSessionSeatRequest {
  readonly seatId: string;
  readonly bindingId: string;
  readonly role: string;
  readonly permissionScope: readonly string[];
  readonly connectorId: string;
  readonly canonicalSessionUri: string;
  readonly requiredHostId: string;
  readonly requiredMachineId: string;
  readonly idempotencyKey: string;
}

interface RoomExistingSessionSpineOptions {
  readonly projectId: string;
  readonly roomStore: DurableExistingSessionRoomStore;
  readonly connectorRegistry: SessionConnectorRegistry;
  readonly now: () => string;
  readonly ingestionLimits: {
    readonly historyPageSize: number;
    readonly maxHistoryPagesPerReconciliation: number;
    readonly maxEvents: number;
    readonly maxStreamReconnects: number;
    readonly maxDegradedPolls: number;
  };
}

interface RoomExistingSessionSpineApi {
  createRoomWithExistingSessions(input: {
    readonly room: Omit<CreateRoomAggregateInput, "projectId" | "now">;
    readonly sessions: readonly ExactExistingSessionSeatRequest[];
  }): Promise<RoomAggregateV1>;
  sendToSeat(input: {
    readonly roomId: string;
    readonly seatId: string;
    readonly expectedAggregateVersion: number;
    readonly commandId: string;
    readonly correlationId: string;
    readonly idempotencyKey: string;
    readonly intent: RoomMessageIntent;
    readonly content: string;
    readonly authorityEnvelope: RoomAuthorityEnvelopeV1;
  }): Promise<RoomOutboxRecordV1>;
  ingestSeat(input: {
    readonly roomId: string;
    readonly seatId: string;
  }): Promise<unknown>;
  restoreRoom(roomId: string): Promise<RoomAggregateV1>;
}

type RoomExistingSessionSpineConstructor = new (
  options: RoomExistingSessionSpineOptions,
) => RoomExistingSessionSpineApi;

function requireRoomExistingSessionSpine(): RoomExistingSessionSpineConstructor {
  expect(
    ProductionRoomExistingSessionSpine,
    "Task 4.6 requires a production RoomExistingSessionSpine orchestration seam",
  ).toBeTypeOf("function");
  return ProductionRoomExistingSessionSpine as RoomExistingSessionSpineConstructor;
}

function createHarness() {
  const connector = createDeterministicConnectorDouble();
  const registry = new SessionConnectorRegistry({ now: () => Date.parse(NOW) });
  const requireVerified = vi.spyOn(registry, "requireVerified");
  registry.register(connector);
  return {
    connector,
    registry,
    requireVerified,
    roomStore: new DurableExistingSessionRoomStore(),
  };
}

function createInput() {
  return {
    room: {
      id: ROOM_ID,
      objective: "Continue two exact existing native Sessions",
      protocolId: "implementation",
      protocolVersion: 1,
    },
    sessions: EXISTING_SESSIONS.map((session) => ({
      seatId: session.seatId,
      bindingId: session.bindingId,
      role: session.role,
      permissionScope: ["room:message", "session:send"],
      connectorId: CONNECTOR_ID,
      canonicalSessionUri: session.canonicalSessionUri,
      requiredHostId: session.identity.hostId,
      requiredMachineId: session.identity.machineId!,
      idempotencyKey: `ensure:${session.identity.providerId}:${session.identity.nativeSessionId}`,
    })),
  };
}

function operatorAuthority(seatIds: readonly string[]): RoomAuthorityEnvelopeV1 {
  return {
    actorType: "human",
    actorId: "operator-existing-spine",
    deviceId: "device-existing-spine",
    role: "owner",
    allowedActions: ["room:message:route"],
    projectId: PROJECT_ID,
    roomId: ROOM_ID,
    nodeIds: [],
    seatIds,
    evidenceRefs: ["evidence://operator-command"],
  };
}

/*
FNXC:SessionRoomExistingSpine 2026-07-17-20:46:
Task 4.6 needs one backend-owned orchestration seam that composes the durable
Room store with SessionConnectorRegistry for two or more exact existing native
Sessions. The RED suite uses deterministic connector doubles only: it is not a
live Happier/provider certification, and Task 12.1 remains incomplete.

FNXC:SessionRoomExistingSpine 2026-07-17-20:46:
The spine must work in the Vitest Node environment with no window, document,
dashboard, browser client, or UI callback. Browser state is neither a transport
dependency nor an owner of Room creation, sending, ingestion, or restoration.
*/
describe("Room existing-Session vertical spine (deterministic connector double)", () => {
  it("creates a browser-independent Room with exact Codex and Claude existing Sessions via registry ensure", async () => {
    expect(Reflect.has(globalThis, "window")).toBe(false);
    expect(Reflect.has(globalThis, "document")).toBe(false);
    const harness = createHarness();
    const RoomExistingSessionSpine = requireRoomExistingSessionSpine();
    const controller = new RoomExistingSessionSpine({
      projectId: PROJECT_ID,
      roomStore: harness.roomStore,
      connectorRegistry: harness.registry,
      now: () => NOW,
      ingestionLimits: {
        historyPageSize: 50,
        maxHistoryPagesPerReconciliation: 2,
        maxEvents: 10,
        maxStreamReconnects: 0,
        maxDegradedPolls: 0,
      },
    });

    const room = await controller.createRoomWithExistingSessions(createInput());

    expect(room.room).toMatchObject({
      id: ROOM_ID,
      projectId: PROJECT_ID,
      objective: "Continue two exact existing native Sessions",
    });
    expect(room.seats.map((seat) => [seat.id, seat.activeBindingId])).toEqual([
      ["seat-codex", "binding-codex-generation-1"],
      ["seat-claude", "binding-claude-generation-1"],
    ]);
    expect(room.bindings.map((binding) => ({
      id: binding.id,
      providerId: binding.providerId,
      nativeSessionId: binding.nativeSessionId,
      happierSessionId: binding.happierSessionId,
      hostId: binding.hostId,
      generation: binding.generation,
    }))).toEqual(EXISTING_SESSIONS.map((session) => ({
      id: session.bindingId,
      providerId: session.identity.providerId,
      nativeSessionId: session.identity.nativeSessionId,
      happierSessionId: session.identity.happierSessionId,
      hostId: session.identity.hostId,
      generation: 1,
    })));
    expect(harness.requireVerified).toHaveBeenCalledTimes(2);
    for (const session of EXISTING_SESSIONS) {
      expect(harness.requireVerified).toHaveBeenCalledWith({
        connectorId: CONNECTOR_ID,
        capability: "ensureExisting" satisfies SessionConnectorCapabilityName,
        requiredHostId: session.identity.hostId,
      });
      expect(harness.connector.ensureExisting).toHaveBeenCalledWith({
        contractVersion: 1,
        canonicalSessionUri: session.canonicalSessionUri,
        requiredHostId: session.identity.hostId,
        requiredMachineId: session.identity.machineId,
        idempotencyKey: `ensure:${session.identity.providerId}:${session.identity.nativeSessionId}`,
      });
    }
    expect(harness.connector.create).not.toHaveBeenCalled();
    expect(Reflect.has(globalThis, "window")).toBe(false);
    expect(Reflect.has(globalThis, "document")).toBe(false);
  });

  it("targets immutable bindings, ingests response deltas, and restores durable identities and cursors", async () => {
    expect(Reflect.has(globalThis, "window")).toBe(false);
    expect(Reflect.has(globalThis, "document")).toBe(false);
    const harness = createHarness();
    const RoomExistingSessionSpine = requireRoomExistingSessionSpine();
    const options: RoomExistingSessionSpineOptions = {
      projectId: PROJECT_ID,
      roomStore: harness.roomStore,
      connectorRegistry: harness.registry,
      now: () => NOW,
      ingestionLimits: {
        historyPageSize: 50,
        maxHistoryPagesPerReconciliation: 2,
        maxEvents: 10,
        maxStreamReconnects: 0,
        maxDegradedPolls: 0,
      },
    };
    const firstController = new RoomExistingSessionSpine(options);
    let room = await firstController.createRoomWithExistingSessions(createInput());

    const deliveries: RoomOutboxRecordV1[] = [];
    for (const session of EXISTING_SESSIONS) {
      const content = `Target only ${session.seatId}.`;
      deliveries.push(await firstController.sendToSeat({
        roomId: ROOM_ID,
        seatId: session.seatId,
        expectedAggregateVersion: room.room.aggregateVersion,
        commandId: `message-${session.identity.providerId}-1`,
        correlationId: `correlation-${session.identity.providerId}-1`,
        idempotencyKey: `route:${session.seatId}:1`,
        intent: "instruction",
        content,
        authorityEnvelope: operatorAuthority([session.seatId]),
      }));
      const committed = await harness.roomStore.getRoom(ROOM_ID);
      if (!committed) throw new Error("Room disappeared after targeted send");
      room = committed;
    }

    expect(deliveries).toEqual(EXISTING_SESSIONS.map((session) => expect.objectContaining({
      roomId: ROOM_ID,
      bindingId: session.bindingId,
      logicalMessageId: `routed-message:message-${session.identity.providerId}-1`,
      state: "pending",
    })));
    expect(harness.connector.send).not.toHaveBeenCalled();
    expect(harness.roomStore.routeInputs.map((input) => input.command)).toEqual(
      EXISTING_SESSIONS.map((session) => expect.objectContaining({
        type: "route_message",
        target: { kind: "seats", seatIds: [session.seatId] },
      })),
    );
    expect(harness.roomStore.beginDeliveryInputs).toEqual([]);

    // Task 4.7 owns the production sender lease and dispatch loop. Produce
    // deterministic connector events only after proving this spine did not
    // create an unfenced second sender.
    for (const [index, session] of EXISTING_SESSIONS.entries()) {
      const delivery = deliveries[index]!;
      const result = await harness.connector.send({
        contractVersion: 1,
        bindingId: session.bindingId,
        identity: session.identity,
        logicalMessageId: delivery.logicalMessageId,
        localMessageId: delivery.localMessageId,
        idempotencyKey: delivery.idempotencyKey,
        contentHash: delivery.payloadHash,
        content: `Target only ${session.seatId}.`,
      });
      expect(result.ok).toBe(true);
    }
    expect(harness.connector.send).toHaveBeenCalledTimes(2);
    EXISTING_SESSIONS.forEach((session, index) => {
      expect(harness.connector.send).toHaveBeenNthCalledWith(index + 1, expect.objectContaining({
        bindingId: session.bindingId,
        identity: session.identity,
        logicalMessageId: `routed-message:message-${session.identity.providerId}-1`,
        content: `Target only ${session.seatId}.`,
      }));
    });

    for (const session of EXISTING_SESSIONS) {
      await firstController.ingestSeat({ roomId: ROOM_ID, seatId: session.seatId });
      const state = await harness.roomStore.getConnectorIngestionState({
        roomId: ROOM_ID,
        bindingId: session.bindingId,
      });
      expect(state).toMatchObject({
        transcriptCursor: `cursor-${session.identity.providerId}-response-1`,
        statusCursor: `status-${session.identity.providerId}-idle-1`,
        lastNativeMessageId: `native-${session.identity.providerId}-response-1`,
        connectorStatus: "idle",
      });
      expect(harness.roomStore.listPersistedHistory(session.bindingId)).toEqual([
        expect.objectContaining({
          bindingId: session.bindingId,
          nativeMessageId: `native-${session.identity.providerId}-response-1`,
          logicalMessageId: `routed-message:message-${session.identity.providerId}-1`,
          nativeCursor: `cursor-${session.identity.providerId}-response-1`,
          role: "assistant",
          source: "event",
        }),
      ]);
    }

    const persistedCursorStates = await Promise.all(EXISTING_SESSIONS.map((session) =>
      harness.roomStore.getConnectorIngestionState({
        roomId: ROOM_ID,
        bindingId: session.bindingId,
      })
    ));
    const connectorCallsBeforeRestore = {
      ensureExisting: vi.mocked(harness.connector.ensureExisting).mock.calls.length,
      readHistory: vi.mocked(harness.connector.readHistory).mock.calls.length,
      subscribeEvents: vi.mocked(harness.connector.subscribeEvents).mock.calls.length,
      send: vi.mocked(harness.connector.send).mock.calls.length,
    };
    const restoredController = new RoomExistingSessionSpine(options);
    const restored = await restoredController.restoreRoom(ROOM_ID);
    expect(restored.bindings.map((binding) => ({
      id: binding.id,
      providerId: binding.providerId,
      nativeSessionId: binding.nativeSessionId,
      happierSessionId: binding.happierSessionId,
      hostId: binding.hostId,
      generation: binding.generation,
    }))).toEqual(EXISTING_SESSIONS.map((session) => ({
      id: session.bindingId,
      providerId: session.identity.providerId,
      nativeSessionId: session.identity.nativeSessionId,
      happierSessionId: session.identity.happierSessionId,
      hostId: session.identity.hostId,
      generation: 1,
    })));
    expect(await Promise.all(EXISTING_SESSIONS.map((session) =>
      harness.roomStore.getConnectorIngestionState({
        roomId: ROOM_ID,
        bindingId: session.bindingId,
      })
    ))).toEqual(persistedCursorStates);
    expect({
      ensureExisting: vi.mocked(harness.connector.ensureExisting).mock.calls.length,
      readHistory: vi.mocked(harness.connector.readHistory).mock.calls.length,
      subscribeEvents: vi.mocked(harness.connector.subscribeEvents).mock.calls.length,
      send: vi.mocked(harness.connector.send).mock.calls.length,
    }).toEqual(connectorCallsBeforeRestore);
    expect(harness.roomStore.createInputs).toHaveLength(1);
    expect(harness.connector.ensureExisting).toHaveBeenCalledTimes(2);
    expect(harness.connector.create).not.toHaveBeenCalled();
    expect(Reflect.has(globalThis, "window")).toBe(false);
    expect(Reflect.has(globalThis, "document")).toBe(false);
  });

  /*
  FNXC:SessionRoomExistingSpine 2026-07-18-10:28:
  Hostile inputs must fail before any Room/outbox mutation: undersized or
  duplicate initial sets, wrong connector affinity, partial ensure failure,
  cross-seat authority/fences, and foreign connector events cannot weaken the
  exact immutable binding selected by durable membership.
  */
  it("fails closed before persistence for undersized sets and wrong returned host affinity", async () => {
    const harness = createHarness();
    const RoomExistingSessionSpine = requireRoomExistingSessionSpine();
    const controller = new RoomExistingSessionSpine({
      projectId: PROJECT_ID,
      roomStore: harness.roomStore,
      connectorRegistry: harness.registry,
      now: () => NOW,
      ingestionLimits: {
        historyPageSize: 50,
        maxHistoryPagesPerReconciliation: 2,
        maxEvents: 10,
        maxStreamReconnects: 0,
        maxDegradedPolls: 0,
      },
    });

    await expect(controller.createRoomWithExistingSessions({
      ...createInput(),
      sessions: createInput().sessions.slice(0, 1),
    })).rejects.toMatchObject({
      code: "ROOM_EXISTING_SESSION_INVALID_REQUEST",
    });
    expect(harness.connector.ensureExisting).not.toHaveBeenCalled();

    vi.mocked(harness.connector.ensureExisting).mockResolvedValueOnce(ensuredExisting({
      ...EXISTING_SESSIONS[0].identity,
      hostId: "attacker-controlled-host",
    }));
    await expect(controller.createRoomWithExistingSessions(createInput())).rejects.toMatchObject({
      code: "ROOM_EXISTING_SESSION_IDENTITY_CONFLICT",
    });
    expect(harness.roomStore.createInputs).toHaveLength(0);
    expect(await harness.roomStore.getRoom(ROOM_ID)).toBeUndefined();
    expect(harness.connector.create).not.toHaveBeenCalled();
  });

  it("does not persist a partial Room when a later exact ensure fails", async () => {
    const harness = createHarness();
    vi.mocked(harness.connector.ensureExisting)
      .mockResolvedValueOnce(ensuredExisting(EXISTING_SESSIONS[0].identity))
      .mockResolvedValueOnce(unavailable("Second exact Session is unavailable"));
    const RoomExistingSessionSpine = requireRoomExistingSessionSpine();
    const controller = new RoomExistingSessionSpine({
      projectId: PROJECT_ID,
      roomStore: harness.roomStore,
      connectorRegistry: harness.registry,
      now: () => NOW,
      ingestionLimits: {
        historyPageSize: 50,
        maxHistoryPagesPerReconciliation: 2,
        maxEvents: 10,
        maxStreamReconnects: 0,
        maxDegradedPolls: 0,
      },
    });

    await expect(controller.createRoomWithExistingSessions(createInput())).rejects.toMatchObject({
      code: "ROOM_EXISTING_SESSION_ENSURE_FAILED",
    });
    expect(harness.connector.ensureExisting).toHaveBeenCalledTimes(2);
    expect(harness.roomStore.createInputs).toHaveLength(0);
    expect(await harness.roomStore.getRoom(ROOM_ID)).toBeUndefined();
    expect(harness.connector.create).not.toHaveBeenCalled();
  });

  it("rejects cross-seat authority before outbox enqueue or dispatch", async () => {
    const harness = createHarness();
    const RoomExistingSessionSpine = requireRoomExistingSessionSpine();
    const controller = new RoomExistingSessionSpine({
      projectId: PROJECT_ID,
      roomStore: harness.roomStore,
      connectorRegistry: harness.registry,
      now: () => NOW,
      ingestionLimits: {
        historyPageSize: 50,
        maxHistoryPagesPerReconciliation: 2,
        maxEvents: 10,
        maxStreamReconnects: 0,
        maxDegradedPolls: 0,
      },
    });
    const room = await controller.createRoomWithExistingSessions(createInput());
    const codex = EXISTING_SESSIONS[0];
    const baseSend = {
      roomId: ROOM_ID,
      seatId: codex.seatId,
      expectedAggregateVersion: room.room.aggregateVersion,
      commandId: "message-hostile-target",
      correlationId: "correlation-hostile-target",
      idempotencyKey: "route:hostile-target",
      intent: "instruction",
      content: "This must reach only the Codex seat.",
      authorityEnvelope: operatorAuthority([EXISTING_SESSIONS[1].seatId]),
    };

    await expect(controller.sendToSeat(baseSend)).rejects.toMatchObject({
      code: "authority_scope_violation",
    });
    expect(harness.roomStore.routeInputs).toHaveLength(1);
    expect(await harness.roomStore.getDelivery("routed-outbox:message-hostile-target")).toBeNull();
    expect(harness.roomStore.beginDeliveryInputs).toHaveLength(0);
    expect(harness.connector.send).not.toHaveBeenCalled();
  });

  it("rejects a foreign-identity connector event without persisting it to the targeted binding", async () => {
    const harness = createHarness();
    const RoomExistingSessionSpine = requireRoomExistingSessionSpine();
    const controller = new RoomExistingSessionSpine({
      projectId: PROJECT_ID,
      roomStore: harness.roomStore,
      connectorRegistry: harness.registry,
      now: () => NOW,
      ingestionLimits: {
        historyPageSize: 50,
        maxHistoryPagesPerReconciliation: 2,
        maxEvents: 10,
        maxStreamReconnects: 0,
        maxDegradedPolls: 0,
      },
    });
    await controller.createRoomWithExistingSessions(createInput());
    const foreignEvent: SessionConnectorEventV1 = {
      connectorEventId: "event-foreign-identity",
      identity: EXISTING_SESSIONS[1].identity,
      eventType: "message",
      cursor: "cursor-foreign-identity",
      occurredAt: NOW,
      payload: {
        type: "transcript_delta",
        fromCursor: null,
        nextCursor: "cursor-foreign-identity",
        completeThroughCursor: "cursor-foreign-identity",
        truncated: false,
        items: [{
          nativeMessageId: "native-foreign-identity",
          logicalMessageId: null,
          role: "assistant",
          contentHash: hashRoomValue("foreign identity payload"),
          occurredAt: NOW,
          cursor: "cursor-foreign-identity",
        }],
      },
    };
    vi.mocked(harness.connector.subscribeEvents).mockResolvedValueOnce(ok(
      (async function* foreignEvents() {
        yield foreignEvent;
      })(),
    ));

    const result = await controller.ingestSeat({ roomId: ROOM_ID, seatId: EXISTING_SESSIONS[0].seatId });
    expect(result).toMatchObject({
      outcome: "contract_failure",
      error: { code: "invalid_event_payload" },
    });
    expect(harness.roomStore.listPersistedHistory(EXISTING_SESSIONS[0].bindingId)).toEqual([]);
    expect(await harness.roomStore.getConnectorIngestionState({
      roomId: ROOM_ID,
      bindingId: EXISTING_SESSIONS[0].bindingId,
    })).toMatchObject({ transcriptCursor: null, statusCursor: null });
  });
});
