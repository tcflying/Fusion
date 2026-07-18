import type {
  AsyncRoomStore,
  CreateRoomWithExistingBindingsInput,
  RoomAggregateV1,
  RoomBindingRecordV1,
  RoomCommandContext,
  RoomOutboxRecordV1,
  SessionConnectorIdentityV1,
} from "@fusion/core";

import {
  RoomSessionConnectorIngestionPersistence,
  type RoomConnectorIngestionStore,
} from "./room-session-connector-ingestion-persistence.js";
import {
  runSessionConnectorIngestion,
  type SessionConnectorIngestionLimits,
  type SessionConnectorIngestionResult,
} from "./session-connector-ingestion.js";
import type { SessionConnectorRegistry } from "./session-connector-registry.js";

export type RoomExistingSessionSpineErrorCode =
  | "ROOM_EXISTING_SESSION_INVALID_REQUEST"
  | "ROOM_EXISTING_SESSION_ENSURE_FAILED"
  | "ROOM_EXISTING_SESSION_IDENTITY_CONFLICT"
  | "ROOM_EXISTING_SESSION_NOT_FOUND"
  | "ROOM_EXISTING_SESSION_SEAT_NOT_FOUND"
  | "ROOM_EXISTING_SESSION_BINDING_NOT_FOUND"
  | "ROOM_EXISTING_SESSION_AUTHORITY_CONFLICT"
  | "ROOM_EXISTING_SESSION_DELIVERY_CONFLICT";

export class RoomExistingSessionSpineError extends Error {
  constructor(
    readonly code: RoomExistingSessionSpineErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RoomExistingSessionSpineError";
  }
}

export type RoomExistingSessionStore = Pick<
  AsyncRoomStore,
  "createRoomWithExistingBindings" | "getRoom" | "enqueueMessage"
> & RoomConnectorIngestionStore;

export interface ExactExistingSessionSeatRequest {
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

export interface CreateRoomWithExistingSessionsInput {
  readonly room: CreateRoomWithExistingBindingsInput["room"];
  readonly sessions: readonly ExactExistingSessionSeatRequest[];
}

export interface SendToRoomSeatInput {
  readonly roomId: string;
  readonly seatId: string;
  readonly expectedAggregateVersion: number;
  readonly messageId: string;
  readonly outboxId: string;
  readonly idempotencyKey: string;
  readonly intent: string;
  readonly content: string;
  readonly authorityEnvelope: Readonly<Record<string, unknown>>;
}

export interface IngestRoomSeatInput {
  readonly roomId: string;
  readonly seatId: string;
  readonly signal?: AbortSignal;
}

export interface RoomExistingSessionSpineOptions {
  readonly projectId: string;
  readonly roomStore: RoomExistingSessionStore;
  readonly connectorRegistry: SessionConnectorRegistry;
  readonly now?: () => string;
  readonly ingestionLimits: SessionConnectorIngestionLimits;
}

/*
FNXC:SessionRoomExistingSpine 2026-07-18-10:28:
Task 4.6 composes the canonical Room store, SessionConnectorRegistry, and
connector-ingestion persistence into one backend-owned seam. The separately
supervised recovery worker remains the downstream delivery coordinator.
Initial membership requires two or more exact existing Sessions; every ensure
must finish and prove connector, host, and machine identity before the atomic
Room/binding transaction starts. This path never invokes connector creation.

FNXC:SessionRoomExistingSpine 2026-07-18-10:28:
Targeted sends resolve the seat's persisted active binding and commit exactly
one pending outbox delivery. The durable recovery worker is the sole owner of
sender-lease acquisition and provider dispatch; this seam never becomes a
second sender. Restore reads only durable Room state, while ingestion reloads
durable cursors through the event-first/history-repair path.
The integration suite uses deterministic doubles and is not live-provider proof.
*/
export class RoomExistingSessionSpine {
  private readonly now: () => string;

  constructor(private readonly options: RoomExistingSessionSpineOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    requireNonEmpty(options.projectId, "projectId");
  }

  async createRoomWithExistingSessions(
    input: CreateRoomWithExistingSessionsInput,
  ): Promise<RoomAggregateV1> {
    validateExistingSessionRequests(input.sessions);
    const participants: CreateRoomWithExistingBindingsInput["participants"][number][] = [];
    const nativeIdentities = new Set<string>();
    const happierIdentities = new Set<string>();

    for (const request of input.sessions) {
      const connector = await this.options.connectorRegistry.requireVerified({
        connectorId: request.connectorId,
        capability: "ensureExisting",
        requiredHostId: request.requiredHostId,
      });
      let ensured: Awaited<ReturnType<typeof connector.ensureExisting>>;
      try {
        ensured = await connector.ensureExisting({
          contractVersion: 1,
          canonicalSessionUri: request.canonicalSessionUri,
          requiredHostId: request.requiredHostId,
          requiredMachineId: request.requiredMachineId,
          idempotencyKey: request.idempotencyKey,
        });
      } catch {
        throw new RoomExistingSessionSpineError(
          "ROOM_EXISTING_SESSION_ENSURE_FAILED",
          "Existing Session ensure threw before a durable Room was created",
        );
      }
      if (!ensured.ok) {
        throw new RoomExistingSessionSpineError(
          "ROOM_EXISTING_SESSION_ENSURE_FAILED",
          `Existing Session ensure failed with connector code ${ensured.error.code}`,
        );
      }
      if (ensured.value.providerTurnStarted !== false) {
        throw new RoomExistingSessionSpineError(
          "ROOM_EXISTING_SESSION_IDENTITY_CONFLICT",
          "Existing Session ensure must not start a provider turn",
        );
      }

      const identity = ensured.value.identity;
      assertEnsuredIdentity(request, identity);
      const nativeIdentity = `${identity.providerId}\u0000${identity.nativeSessionId}`;
      if (nativeIdentities.has(nativeIdentity)) {
        throw new RoomExistingSessionSpineError(
          "ROOM_EXISTING_SESSION_IDENTITY_CONFLICT",
          "Two initial seats resolved to the same native Session identity",
        );
      }
      nativeIdentities.add(nativeIdentity);
      if (identity.happierSessionId !== null) {
        const happierIdentity = `${identity.serverProfileId ?? ""}\u0000${identity.happierSessionId}`;
        if (happierIdentities.has(happierIdentity)) {
          throw new RoomExistingSessionSpineError(
            "ROOM_EXISTING_SESSION_IDENTITY_CONFLICT",
            "Two initial seats resolved to the same Happier Session identity",
          );
        }
        happierIdentities.add(happierIdentity);
      }

      participants.push({
        seat: {
          id: request.seatId,
          role: request.role,
          permissionScope: [...request.permissionScope],
        },
        binding: bindingFromIdentity(request.bindingId, identity),
      });
    }

    const occurredAt = this.now();
    return this.options.roomStore.createRoomWithExistingBindings({
      room: { ...input.room },
      participants,
      now: occurredAt,
    }, {
      eventId: `room-existing-session:${input.room.id}:created`,
      actorType: "system",
      actorId: "room-existing-session-spine",
      correlationId: `room-existing-session:${input.room.id}`,
      causationId: null,
      occurredAt,
    });
  }

  async sendToSeat(input: SendToRoomSeatInput): Promise<RoomOutboxRecordV1> {
    const room = await this.requireRoom(input.roomId);
    const binding = activeBindingForSeat(room, input.seatId);
    assertAuthorityTargetsSeat(input.authorityEnvelope, input.seatId);
    const occurredAt = this.now();
    const actor = authorityActor(input.authorityEnvelope);
    const queued = await this.options.roomStore.enqueueMessage({
      roomId: room.room.id,
      expectedAggregateVersion: input.expectedAggregateVersion,
      idempotencyKey: input.idempotencyKey,
      message: {
        id: input.messageId,
        turnId: null,
        nodeId: null,
        originType: originTypeForActor(actor.actorType),
        originId: actor.actorId,
        targetSeatIds: [input.seatId],
        intent: input.intent,
        content: input.content,
        authorityEnvelope: input.authorityEnvelope,
        createdAt: occurredAt,
      },
      deliveries: [{ id: input.outboxId, bindingId: binding.id }],
    }, {
      eventId: `room-existing-session:${input.messageId}:queued`,
      actorType: actor.actorType,
      actorId: actor.actorId,
      correlationId: input.idempotencyKey,
      causationId: null,
      occurredAt,
    });

    const delivery = requireExactDelivery(queued.deliveries, input.outboxId, binding.id);
    return delivery;
  }

  async ingestSeat(input: IngestRoomSeatInput): Promise<SessionConnectorIngestionResult> {
    const room = await this.requireRoom(input.roomId);
    const binding = activeBindingForSeat(room, input.seatId);
    const identity = identityFromBinding(binding);
    const connector = await this.options.connectorRegistry.requireVerified({
      connectorId: binding.connectorId,
      capability: "history",
      identity,
      requiredHostId: binding.hostId,
    });
    const persistence = new RoomSessionConnectorIngestionPersistence({
      store: this.options.roomStore,
      roomId: room.room.id,
      bindingId: binding.id,
      identity,
      now: this.now,
    });
    return runSessionConnectorIngestion({
      connector,
      identity,
      persistence,
      limits: this.options.ingestionLimits,
      signal: input.signal,
    });
  }

  async restoreRoom(roomId: string): Promise<RoomAggregateV1> {
    return this.requireRoom(roomId);
  }

  private async requireRoom(roomId: string): Promise<RoomAggregateV1> {
    requireNonEmpty(roomId, "roomId");
    const room = await this.options.roomStore.getRoom(roomId);
    if (!room || room.room.projectId !== this.options.projectId) {
      throw new RoomExistingSessionSpineError(
        "ROOM_EXISTING_SESSION_NOT_FOUND",
        "The requested existing-Session Room is not present in this project store",
      );
    }
    return room;
  }
}

function validateExistingSessionRequests(
  sessions: readonly ExactExistingSessionSeatRequest[],
): void {
  if (sessions.length < 2) {
    throw new RoomExistingSessionSpineError(
      "ROOM_EXISTING_SESSION_INVALID_REQUEST",
      "An existing-Session Room requires at least two exact Sessions",
    );
  }
  const seatIds = new Set<string>();
  const bindingIds = new Set<string>();
  const canonicalUris = new Set<string>();
  const idempotencyKeys = new Set<string>();
  for (const session of sessions) {
    for (const [field, value] of Object.entries({
      seatId: session.seatId,
      bindingId: session.bindingId,
      role: session.role,
      connectorId: session.connectorId,
      canonicalSessionUri: session.canonicalSessionUri,
      requiredHostId: session.requiredHostId,
      requiredMachineId: session.requiredMachineId,
      idempotencyKey: session.idempotencyKey,
    })) {
      requireNonEmpty(value, field);
    }
    rejectDuplicate(seatIds, session.seatId, "seat ID");
    rejectDuplicate(bindingIds, session.bindingId, "binding ID");
    rejectDuplicate(canonicalUris, session.canonicalSessionUri, "canonical Session URI");
    rejectDuplicate(idempotencyKeys, session.idempotencyKey, "ensure idempotency key");
  }
}

function rejectDuplicate(values: Set<string>, value: string, field: string): void {
  if (values.has(value)) {
    throw new RoomExistingSessionSpineError(
      "ROOM_EXISTING_SESSION_INVALID_REQUEST",
      `Initial existing-Session ${field} values must be unique`,
    );
  }
  values.add(value);
}

function requireNonEmpty(value: string, field: string): void {
  if (!value.trim()) {
    throw new RoomExistingSessionSpineError(
      "ROOM_EXISTING_SESSION_INVALID_REQUEST",
      `${field} must not be empty`,
    );
  }
}

function assertEnsuredIdentity(
  request: ExactExistingSessionSeatRequest,
  identity: SessionConnectorIdentityV1,
): void {
  if (
    !identity.providerId.trim()
    || !identity.nativeSessionId.trim()
    || identity.connectorId !== request.connectorId
    || identity.hostId !== request.requiredHostId
    || identity.machineId !== request.requiredMachineId
  ) {
    throw new RoomExistingSessionSpineError(
      "ROOM_EXISTING_SESSION_IDENTITY_CONFLICT",
      "Connector ensure returned an identity outside the requested connector, host, or machine",
    );
  }
}

function bindingFromIdentity(
  bindingId: string,
  identity: SessionConnectorIdentityV1,
): CreateRoomWithExistingBindingsInput["participants"][number]["binding"] {
  return {
    id: bindingId,
    connectorId: identity.connectorId,
    providerId: identity.providerId,
    nativeSessionId: identity.nativeSessionId,
    happierSessionId: identity.happierSessionId,
    serverProfileId: identity.serverProfileId,
    machineId: identity.machineId,
    hostId: identity.hostId,
  };
}

function activeBindingForSeat(
  room: RoomAggregateV1,
  seatId: string,
): RoomBindingRecordV1 {
  const seat = room.seats.find((candidate) => candidate.id === seatId);
  if (!seat || seat.state === "removed") {
    throw new RoomExistingSessionSpineError(
      "ROOM_EXISTING_SESSION_SEAT_NOT_FOUND",
      "The targeted Room seat is not active in durable membership",
    );
  }
  if (!seat.activeBindingId) {
    throw new RoomExistingSessionSpineError(
      "ROOM_EXISTING_SESSION_BINDING_NOT_FOUND",
      "The targeted Room seat has no active immutable binding",
    );
  }
  const binding = room.bindings.find((candidate) => candidate.id === seat.activeBindingId);
  if (!binding || binding.seatId !== seat.id || binding.state !== "attached") {
    throw new RoomExistingSessionSpineError(
      "ROOM_EXISTING_SESSION_BINDING_NOT_FOUND",
      "The targeted Room seat does not resolve to one active immutable binding",
    );
  }
  return binding;
}

function identityFromBinding(binding: RoomBindingRecordV1): SessionConnectorIdentityV1 {
  return {
    connectorId: binding.connectorId,
    providerId: binding.providerId,
    nativeSessionId: binding.nativeSessionId,
    happierSessionId: binding.happierSessionId,
    serverProfileId: binding.serverProfileId,
    machineId: binding.machineId,
    hostId: binding.hostId,
  };
}

function assertAuthorityTargetsSeat(
  envelope: Readonly<Record<string, unknown>>,
  seatId: string,
): void {
  const targets = envelope.targetSeatIds;
  const allowedActions = envelope.allowedActions;
  if (
    !Array.isArray(targets)
    || targets.length !== 1
    || targets[0] !== seatId
    || !Array.isArray(allowedActions)
    || !allowedActions.includes("session:send")
  ) {
    throw new RoomExistingSessionSpineError(
      "ROOM_EXISTING_SESSION_AUTHORITY_CONFLICT",
      "The authority envelope must authorize only the exact targeted seat and Session send",
    );
  }
}

function authorityActor(envelope: Readonly<Record<string, unknown>>): {
  readonly actorType: RoomCommandContext["actorType"];
  readonly actorId: string;
} {
  const actorType = envelope.actorType;
  const actorId = envelope.actorId;
  if (
    !["human", "controller", "seat", "system", "evolution"].includes(String(actorType))
    || typeof actorId !== "string"
    || !actorId.trim()
  ) {
    throw new RoomExistingSessionSpineError(
      "ROOM_EXISTING_SESSION_AUTHORITY_CONFLICT",
      "The authority envelope requires a typed non-empty actor identity",
    );
  }
  return {
    actorType: actorType as RoomCommandContext["actorType"],
    actorId,
  };
}

function originTypeForActor(
  actorType: RoomCommandContext["actorType"],
): "operator" | "controller" | "seat" {
  if (actorType === "human") return "operator";
  if (actorType === "seat") return "seat";
  return "controller";
}

function requireExactDelivery(
  deliveries: readonly RoomOutboxRecordV1[],
  outboxId: string,
  bindingId: string,
): RoomOutboxRecordV1 {
  if (
    deliveries.length !== 1
    || deliveries[0]?.id !== outboxId
    || deliveries[0].bindingId !== bindingId
  ) {
    throw new RoomExistingSessionSpineError(
      "ROOM_EXISTING_SESSION_DELIVERY_CONFLICT",
      "The durable outbox did not return exactly the requested seat binding delivery",
    );
  }
  return deliveries[0];
}
