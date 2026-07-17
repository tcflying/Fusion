import {
  RoomDomainError,
  createRoomAggregate,
  transitionRoomLifecycle,
  type RoomAggregateV1,
} from "./room-domain.js";
import {
  ROOM_LIFECYCLE_STATES,
  type RoomEventRecordV1,
  type RoomLifecycleState,
} from "./room-contracts/storage.js";
import { hashRoomValue } from "./room-integrity.js";

export type RoomProjectionReplayErrorCode =
  | "empty_event_stream"
  | "event_identity_conflict"
  | "event_version_gap"
  | "event_cursor_conflict"
  | "unsupported_event"
  | "invalid_event_payload"
  | "invalid_checkpoint_projection";

export class RoomProjectionReplayError extends Error {
  readonly code: RoomProjectionReplayErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: RoomProjectionReplayErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "RoomProjectionReplayError";
    this.code = code;
    this.details = details;
  }
}

/** Rebuild a Room projection without consulting mutable projection tables. */
export function rebuildRoomProjectionFromEvents(
  events: readonly RoomEventRecordV1[],
): RoomAggregateV1 {
  if (events.length === 0) {
    throw new RoomProjectionReplayError(
      "empty_event_stream",
      "Cannot rebuild a Room projection from an empty event stream",
    );
  }
  assertEventOrder(events);
  const first = events[0]!;
  if (first.eventType !== "room_created" || first.aggregateVersion !== 0) {
    throw new RoomProjectionReplayError(
      "event_version_gap",
      "Room event replay must start with room_created at aggregate version 0",
      { eventId: first.id, eventType: first.eventType, aggregateVersion: first.aggregateVersion },
    );
  }
  const aggregate = aggregateFromCreatedEvent(first);
  return applyRoomProjectionEvents(aggregate, events.slice(1));
}

/** Apply events after a verified checkpoint projection. */
export function applyRoomProjectionEvents(
  base: RoomAggregateV1,
  events: readonly RoomEventRecordV1[],
): RoomAggregateV1 {
  if (events.length === 0) return base;
  assertEventOrder(events);
  let aggregate = base;
  for (const event of events) {
    if (event.roomId !== aggregate.room.id || event.projectId !== aggregate.room.projectId) {
      throw new RoomProjectionReplayError(
        "event_identity_conflict",
        `Room event ${event.id} does not belong to checkpoint projection ${aggregate.room.id}`,
      );
    }
    const expectedVersion = aggregate.room.aggregateVersion + 1;
    if (event.aggregateVersion !== expectedVersion) {
      throw new RoomProjectionReplayError(
        "event_version_gap",
        `Room events must have contiguous aggregate version ${expectedVersion}; received ${event.aggregateVersion}`,
        { eventId: event.id, expectedVersion, actualVersion: event.aggregateVersion },
      );
    }
    aggregate = applyOneEvent(aggregate, event);
  }
  return aggregate;
}

/** Runtime validation for a JSON checkpoint before it is trusted as a base. */
export function parseRoomAggregateProjection(value: unknown): RoomAggregateV1 {
  try {
    return parseRoomAggregateProjectionUnsafe(value);
  } catch (error) {
    if (
      error instanceof RoomProjectionReplayError
      && error.code !== "invalid_checkpoint_projection"
    ) {
      throw new RoomProjectionReplayError(
        "invalid_checkpoint_projection",
        error.message,
        error.details,
      );
    }
    throw error;
  }
}

function parseRoomAggregateProjectionUnsafe(value: unknown): RoomAggregateV1 {
  const projection = requireRecord(value, "checkpoint projection");
  const room = requireRecord(projection.room, "checkpoint Room record");
  const roomId = requireString(room.id, "checkpoint room.id");
  requireString(room.projectId, "checkpoint room.projectId");
  requireString(room.objective, "checkpoint room.objective");
  requireString(room.protocolId, "checkpoint room.protocolId");
  requirePositiveInteger(room.protocolVersion, "checkpoint room.protocolVersion");
  requireLifecycleState(room.state, "checkpoint room.state");
  requireNonNegativeInteger(room.aggregateVersion, "checkpoint room.aggregateVersion");
  requireString(room.createdAt, "checkpoint room.createdAt");
  requireString(room.updatedAt, "checkpoint room.updatedAt");
  requireNonNegativeInteger(projection.membershipVersion, "checkpoint membershipVersion");
  if (projection.activeTurnId !== null && typeof projection.activeTurnId !== "string") {
    invalidProjection("checkpoint activeTurnId must be a string or null");
  }

  const seats = requireArray(projection.seats, "checkpoint seats");
  const bindings = requireArray(projection.bindings, "checkpoint bindings");
  const turns = requireArray(projection.turns, "checkpoint turns");
  const pending = requireArray(
    projection.pendingMembershipChanges,
    "checkpoint pendingMembershipChanges",
  );
  for (const [label, records] of [
    ["seat", seats],
    ["binding", bindings],
    ["turn", turns],
    ["pending membership change", pending],
  ] as const) {
    for (const candidate of records) {
      const record = requireRecord(candidate, `checkpoint ${label}`);
      requireString(record.id, `checkpoint ${label}.id`);
      if (requireString(record.roomId, `checkpoint ${label}.roomId`) !== roomId) {
        invalidProjection(`checkpoint ${label} belongs to another Room`);
      }
    }
  }
  return value as RoomAggregateV1;
}

function aggregateFromCreatedEvent(event: RoomEventRecordV1): RoomAggregateV1 {
  const payload = requireEventPayload(event);
  if (payload.initialProjection !== undefined) {
    const expectedHash = requireString(
      payload.initialProjectionHash,
      `room_created ${event.id} initialProjectionHash`,
    );
    const actualHash = hashRoomValue(payload.initialProjection);
    if (actualHash !== expectedHash) {
      throw new RoomProjectionReplayError(
        "invalid_event_payload",
        `room_created ${event.id} initial projection hash does not match its payload`,
      );
    }
    let aggregate: RoomAggregateV1;
    try {
      aggregate = parseRoomAggregateProjection(payload.initialProjection);
    } catch (error) {
      throw new RoomProjectionReplayError(
        "invalid_event_payload",
        `room_created ${event.id} initial projection is invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (
      aggregate.room.id !== event.roomId
      || aggregate.room.projectId !== event.projectId
      || aggregate.room.aggregateVersion !== event.aggregateVersion
      || aggregate.room.aggregateVersion !== 0
    ) {
      throw new RoomProjectionReplayError(
        "invalid_event_payload",
        `room_created ${event.id} initial projection identity/version does not match its event`,
      );
    }
    return aggregate;
  }
  const lifecycleState = requireLifecycleState(
    payload.lifecycleState,
    `room_created ${event.id} lifecycleState`,
  );
  const membershipVersion = requireNonNegativeInteger(
    payload.membershipVersion,
    `room_created ${event.id} membershipVersion`,
  );
  const activeTurnId = payload.activeTurnId;
  if (activeTurnId !== null) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `room_created ${event.id} must start without an active turn`,
    );
  }
  const createdAt = requireString(payload.createdAt, `room_created ${event.id} createdAt`);
  const updatedAt = requireString(payload.updatedAt, `room_created ${event.id} updatedAt`);
  if (createdAt !== updatedAt || lifecycleState !== "draft" || membershipVersion !== 0) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `room_created ${event.id} must represent an initial draft at membership version 0`,
    );
  }
  const aggregate = createRoomAggregate({
    id: event.roomId,
    projectId: event.projectId,
    objective: requireString(payload.objective, `room_created ${event.id} objective`),
    protocolId: requireString(payload.protocolId, `room_created ${event.id} protocolId`),
    protocolVersion: requirePositiveInteger(
      payload.protocolVersion,
      `room_created ${event.id} protocolVersion`,
    ),
    now: createdAt,
  });
  return aggregate;
}

function applyOneEvent(
  aggregate: RoomAggregateV1,
  event: RoomEventRecordV1,
): RoomAggregateV1 {
  const payload = requireEventPayload(event);
  switch (event.eventType) {
    case "room_lifecycle_transitioned": {
      const from = requireLifecycleState(payload.from, `${event.id} from`);
      const to = requireLifecycleState(payload.to, `${event.id} to`);
      const updatedAt = requireString(payload.updatedAt, `${event.id} updatedAt`);
      if (from !== aggregate.room.state) {
        throw new RoomProjectionReplayError(
          "invalid_event_payload",
          `Room lifecycle event ${event.id} expected state ${from} but replay is ${aggregate.room.state}`,
        );
      }
      try {
        return transitionRoomLifecycle(aggregate, {
          to,
          expectedAggregateVersion: aggregate.room.aggregateVersion,
          now: updatedAt,
        });
      } catch (error) {
        if (error instanceof RoomDomainError) {
          throw new RoomProjectionReplayError(
            "invalid_event_payload",
            `Room lifecycle event ${event.id} is invalid: ${error.message}`,
          );
        }
        throw error;
      }
    }
    case "room_message_queued": {
      requireString(payload.messageId, `${event.id} messageId`);
      const outboxIds = requireArray(payload.outboxIds, `${event.id} outboxIds`);
      if (outboxIds.length === 0 || outboxIds.some((id) => typeof id !== "string")) {
        throw new RoomProjectionReplayError(
          "invalid_event_payload",
          `Room message event ${event.id} requires non-empty string outbox IDs`,
        );
      }
      const updatedAt = requireString(payload.updatedAt, `${event.id} updatedAt`);
      return {
        ...aggregate,
        room: {
          ...aggregate.room,
          aggregateVersion: event.aggregateVersion,
          updatedAt,
        },
      };
    }
    case "membership_change_requested":
    case "membership_change_activated": {
      const projectionHash = requireString(payload.projectionHash, `${event.id} projectionHash`);
      if (hashRoomValue(payload.projection) !== projectionHash) {
        throw new RoomProjectionReplayError(
          "invalid_event_payload",
          `Room membership event ${event.id} projection hash does not match its payload`,
        );
      }
      let projection: RoomAggregateV1;
      try {
        projection = parseRoomAggregateProjection(payload.projection);
      } catch (error) {
        throw new RoomProjectionReplayError(
          "invalid_event_payload",
          `Room membership event ${event.id} projection is invalid: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (
        projection.room.id !== aggregate.room.id
        || projection.room.projectId !== aggregate.room.projectId
        || projection.room.aggregateVersion !== event.aggregateVersion
      ) {
        throw new RoomProjectionReplayError(
          "invalid_event_payload",
          `Room membership event ${event.id} projection identity/version does not match its event`,
        );
      }
      if (
        event.eventType === "membership_change_requested"
        && projection.membershipVersion !== aggregate.membershipVersion
      ) {
        throw new RoomProjectionReplayError(
          "invalid_event_payload",
          `Membership request ${event.id} changed the active membership snapshot`,
        );
      }
      if (
        event.eventType === "membership_change_activated"
        && projection.membershipVersion !== aggregate.membershipVersion + 1
      ) {
        throw new RoomProjectionReplayError(
          "invalid_event_payload",
          `Membership activation ${event.id} must advance membership version exactly once`,
        );
      }
      return projection;
    }
    default:
      throw new RoomProjectionReplayError(
        "unsupported_event",
        `Room projection replay does not support event type ${event.eventType}`,
        { eventId: event.id, eventType: event.eventType },
      );
  }
}

function assertEventOrder(events: readonly RoomEventRecordV1[]): void {
  let previousCursor: bigint | null = null;
  let roomId: string | null = null;
  let projectId: string | null = null;
  for (const event of events) {
    if (roomId === null) {
      roomId = event.roomId;
      projectId = event.projectId;
    } else if (event.roomId !== roomId || event.projectId !== projectId) {
      throw new RoomProjectionReplayError(
        "event_identity_conflict",
        `Room event stream mixes identities at event ${event.id}`,
      );
    }
    const cursor = parseEventCursor(event.cursor, event.id);
    if (previousCursor !== null && cursor <= previousCursor) {
      throw new RoomProjectionReplayError(
        "event_cursor_conflict",
        `Room event cursors must increase strictly at event ${event.id}`,
      );
    }
    previousCursor = cursor;
  }
}

function parseEventCursor(value: string, eventId: string): bigint {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new RoomProjectionReplayError(
      "event_cursor_conflict",
      `Room event ${eventId} has invalid durable cursor ${value}`,
    );
  }
  return BigInt(value);
}

function requireEventPayload(event: RoomEventRecordV1): Readonly<Record<string, unknown>> {
  if (event.payload === null || typeof event.payload !== "object" || Array.isArray(event.payload)) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Room event ${event.id} payload must be an object`,
    );
  }
  if (event.payload.projectionVersion !== 1) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Room event ${event.id} has unsupported projection payload version`,
    );
  }
  return event.payload;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalidProjection(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) invalidProjection(`${label} must be an array`);
  return value as readonly unknown[];
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `${label} must be a non-empty string`,
    );
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `${label} must be a non-negative safe integer`,
    );
  }
  return value as number;
}

function requirePositiveInteger(value: unknown, label: string): number {
  const result = requireNonNegativeInteger(value, label);
  if (result < 1) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `${label} must be a positive integer`,
    );
  }
  return result;
}

function requireLifecycleState(value: unknown, label: string): RoomLifecycleState {
  if (typeof value !== "string" || !ROOM_LIFECYCLE_STATES.includes(value as RoomLifecycleState)) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `${label} is not a supported Room lifecycle state`,
    );
  }
  return value as RoomLifecycleState;
}

function invalidProjection(message: string): never {
  throw new RoomProjectionReplayError("invalid_checkpoint_projection", message);
}
