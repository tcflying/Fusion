import {
  RoomDomainError,
  createRoomAggregate,
  transitionRoomLifecycle,
  type PendingRoomMembershipChangeV1,
  type RoomAggregateV1,
} from "./room-domain.js";
import {
  ROOM_LIFECYCLE_STATES,
  type RoomBindingRecordV1,
  type RoomEventRecordV1,
  type RoomLifecycleState,
  type RoomSeatRecordV1,
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
      return validateMembershipChangeRequested(aggregate, event, payload);
    case "membership_change_activated":
      return validateMembershipChangeActivated(aggregate, event, payload);
    default:
      throw new RoomProjectionReplayError(
        "unsupported_event",
        `Room projection replay does not support event type ${event.eventType}`,
        { eventId: event.id, eventType: event.eventType },
      );
  }
}

function validateMembershipChangeRequested(
  aggregate: RoomAggregateV1,
  event: RoomEventRecordV1,
  payload: Readonly<Record<string, unknown>>,
): RoomAggregateV1 {
  assertExactKeys(payload, [
    "projectionVersion",
    "changeId",
    "changeKind",
    "effectiveAfterTurnId",
    "projection",
    "projectionHash",
    "updatedAt",
  ], `${event.id} payload`);
  const projectionHash = requireString(payload.projectionHash, `${event.id} projectionHash`);
  if (hashRoomValue(payload.projection) !== projectionHash) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Room membership event ${event.id} projection hash does not match its payload`,
    );
  }
  if (aggregate.activeTurnId === null) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Room membership request ${event.id} requires an active turn boundary`,
    );
  }
  const changeId = requireTrimmedString(payload.changeId, `${event.id} changeId`);
  const changeKind = requireMembershipChangeKind(payload.changeKind, `${event.id} changeKind`);
  const effectiveAfterTurnId = requireTrimmedString(
    payload.effectiveAfterTurnId,
    `${event.id} effectiveAfterTurnId`,
  );
  if (effectiveAfterTurnId !== aggregate.activeTurnId) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Room membership request ${event.id} must target active turn ${aggregate.activeTurnId}`,
    );
  }
  const updatedAt = requireIsoTimestamp(payload.updatedAt, `${event.id} updatedAt`);
  const projection = requireEventRecord(payload.projection, `${event.id} projection`);
  assertExactKeys(projection, [
    "room",
    "membershipVersion",
    "activeTurnId",
    "seats",
    "bindings",
    "turns",
    "pendingMembershipChanges",
  ], `${event.id} projection`);

  const existingPending = validatePendingMembershipChangeSet(
    aggregate.pendingMembershipChanges,
    `${event.id} existing pending changes`,
  );
  if (existingPending.some((change) => change.id === changeId)) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Room membership request ${event.id} duplicates changeId ${changeId}`,
    );
  }
  const projectedPending = requireEventArray(
    projection.pendingMembershipChanges,
    `${event.id} projection.pendingMembershipChanges`,
  );
  if (projectedPending.length !== existingPending.length + 1) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Room membership request ${event.id} must add exactly one pending membership change`,
    );
  }
  const pending = parseStrictPendingMembershipChange(
    projectedPending.at(-1),
    `${event.id} pending membership change`,
  );
  assertPendingMembershipChangeMatchesRequest(
    aggregate,
    pending,
    event.id,
    changeId,
    changeKind,
    effectiveAfterTurnId,
    updatedAt,
  );

  const expected: RoomAggregateV1 = {
    room: {
      ...aggregate.room,
      aggregateVersion: event.aggregateVersion,
      updatedAt,
    },
    membershipVersion: aggregate.membershipVersion,
    activeTurnId: aggregate.activeTurnId,
    seats: aggregate.seats,
    bindings: aggregate.bindings,
    turns: aggregate.turns,
    pendingMembershipChanges: [...existingPending, pending],
  };
  if (hashRoomValue(payload.projection) !== hashRoomValue(expected)) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Room membership request ${event.id} projection is not the exact allowed request delta`,
    );
  }
  return expected;
}

function validateMembershipChangeActivated(
  aggregate: RoomAggregateV1,
  event: RoomEventRecordV1,
  payload: Readonly<Record<string, unknown>>,
): RoomAggregateV1 {
  const projectionVersion = requireNonNegativeInteger(
    payload.projectionVersion,
    `${event.id} projectionVersion`,
  );
  if (projectionVersion === 1) {
    return validateMembershipChangeActivatedV1(aggregate, event, payload);
  }
  if (projectionVersion === 2) {
    return validateMembershipChangeActivatedV2(aggregate, event, payload);
  }
  throw new RoomProjectionReplayError(
    "invalid_event_payload",
    `Room membership activation ${event.id} uses unsupported projection version ${projectionVersion}`,
  );
}

function validateMembershipChangeActivatedV1(
  aggregate: RoomAggregateV1,
  event: RoomEventRecordV1,
  payload: Readonly<Record<string, unknown>>,
): RoomAggregateV1 {
  assertExactKeys(payload, [
    "projectionVersion",
    "turnId",
    "changeIds",
    "membershipVersion",
    "projection",
    "projectionHash",
    "updatedAt",
  ], `${event.id} payload`);
  const projectionHash = requireString(payload.projectionHash, `${event.id} projectionHash`);
  if (hashRoomValue(payload.projection) !== projectionHash) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Room membership event ${event.id} projection hash does not match its payload`,
    );
  }
  const turnId = requireTrimmedString(payload.turnId, `${event.id} turnId`);
  const changeIds = requireUniqueStringArray(payload.changeIds, `${event.id} changeIds`);
  const updatedAt = requireIsoTimestamp(payload.updatedAt, `${event.id} updatedAt`);
  const declaredMembershipVersion = requireNonNegativeInteger(
    payload.membershipVersion,
    `${event.id} membershipVersion`,
  );
  if (declaredMembershipVersion !== aggregate.membershipVersion + 1) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Room membership activation ${event.id} declared an invalid membership version`,
    );
  }

  const projection = requireEventRecord(payload.projection, `${event.id} projection`);
  assertExactKeys(projection, [
    "room",
    "membershipVersion",
    "activeTurnId",
    "seats",
    "bindings",
    "turns",
    "pendingMembershipChanges",
  ], `${event.id} projection`);
  const validatedPending = validatePendingMembershipChangeSet(
    aggregate.pendingMembershipChanges,
    `${event.id} pending changes`,
  );
  const replayBase: RoomAggregateV1 = {
    ...aggregate,
    pendingMembershipChanges: validatedPending,
  };
  const applicableChanges = validatedPending
    .filter((change) => change.effectiveAfterTurnId === turnId)
    .slice()
    .sort((left, right) => comparePendingMembershipChanges(left, right));
  if (applicableChanges.length === 0) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Room membership activation ${event.id} has no pending changes for turn ${turnId}`,
    );
  }
  const applicableIds = applicableChanges.map((change) => change.id);
  if (
    changeIds.length !== applicableIds.length
    || changeIds.some((changeId, index) => changeId !== applicableIds[index])
  ) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Room membership activation ${event.id} does not match the pending change set for turn ${turnId}`,
    );
  }

  const boundaryBase = deriveMembershipActivationBoundary(
    replayBase,
    projection,
    event.id,
    turnId,
    updatedAt,
  );
  const expected = applyMembershipChangesForReplay(boundaryBase, applicableChanges, updatedAt);
  if (
    expected.room.aggregateVersion !== event.aggregateVersion
    || expected.membershipVersion !== declaredMembershipVersion
    || hashRoomValue(payload.projection) !== hashRoomValue(expected)
  ) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Room membership activation ${event.id} projection is not the exact allowed boundary delta`,
    );
  }
  return expected;
}

type MembershipActivationOutcomeV2 =
  | { readonly changeId: string; readonly status: "applied" }
  | {
      readonly changeId: string;
      readonly status: "failed";
      readonly failureCode: "seat_not_found" | "binding_not_found";
    };

function validateMembershipChangeActivatedV2(
  aggregate: RoomAggregateV1,
  event: RoomEventRecordV1,
  payload: Readonly<Record<string, unknown>>,
): RoomAggregateV1 {
  assertExactKeys(payload, [
    "projectionVersion",
    "turnId",
    "outcomes",
    "quarantinedChangeIds",
    "membershipVersion",
    "projection",
    "projectionHash",
    "updatedAt",
  ], `${event.id} payload`);
  const projectionHash = requireString(payload.projectionHash, `${event.id} projectionHash`);
  if (hashRoomValue(payload.projection) !== projectionHash) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Room membership event ${event.id} projection hash does not match its payload`,
    );
  }
  const turnId = requireTrimmedString(payload.turnId, `${event.id} turnId`);
  const outcomes = parseMembershipActivationOutcomesV2(payload.outcomes, event.id);
  const quarantinedChangeIds = requireUniqueStringArray(
    payload.quarantinedChangeIds,
    `${event.id} quarantinedChangeIds`,
  );
  if (outcomes.length === 0 && quarantinedChangeIds.length === 0) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Room membership activation ${event.id} has neither ledger outcomes nor quarantined rows`,
    );
  }
  const outcomeIds = new Set(outcomes.map((outcome) => outcome.changeId));
  if (quarantinedChangeIds.some((changeId) => outcomeIds.has(changeId))) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Room membership activation ${event.id} overlaps ledger outcomes and quarantined rows`,
    );
  }
  const updatedAt = requireIsoTimestamp(payload.updatedAt, `${event.id} updatedAt`);
  const declaredMembershipVersion = requireNonNegativeInteger(
    payload.membershipVersion,
    `${event.id} membershipVersion`,
  );
  const projection = requireEventRecord(payload.projection, `${event.id} projection`);
  assertExactKeys(projection, [
    "room",
    "membershipVersion",
    "activeTurnId",
    "seats",
    "bindings",
    "turns",
    "pendingMembershipChanges",
  ], `${event.id} projection`);
  const validatedPending = validatePendingMembershipChangeSet(
    aggregate.pendingMembershipChanges,
    `${event.id} pending changes`,
  );
  const replayBase: RoomAggregateV1 = {
    ...aggregate,
    pendingMembershipChanges: validatedPending,
  };
  const applicableChanges = validatedPending
    .filter((change) => change.effectiveAfterTurnId === turnId)
    .slice()
    .sort((left, right) => comparePendingMembershipChanges(left, right));
  const applicableIds = applicableChanges.map((change) => change.id);
  if (
    outcomes.length !== applicableIds.length
    || outcomes.some((outcome, index) => outcome.changeId !== applicableIds[index])
  ) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Room membership activation ${event.id} outcomes do not match the ordered pending change set for turn ${turnId}`,
    );
  }

  const boundaryBase = deriveMembershipActivationBoundary(
    replayBase,
    projection,
    event.id,
    turnId,
    updatedAt,
  );
  let projected = boundaryBase;
  let appliedCount = 0;
  for (let index = 0; index < applicableChanges.length; index += 1) {
    const change = applicableChanges[index]!;
    const outcome = outcomes[index]!;
    const failureCode = classifyMembershipReplayFailure(projected, change);
    if (failureCode) {
      if (outcome.status !== "failed" || outcome.failureCode !== failureCode) {
        throw new RoomProjectionReplayError(
          "invalid_event_payload",
          `Room membership activation ${event.id} has an invalid failed outcome for ${change.id}`,
        );
      }
      continue;
    }
    if (outcome.status !== "applied") {
      throw new RoomProjectionReplayError(
        "invalid_event_payload",
        `Room membership activation ${event.id} falsely failed applicable change ${change.id}`,
      );
    }
    projected = applyMembershipChangeForReplay(projected, change, updatedAt);
    appliedCount += 1;
  }
  const completedIds = new Set(applicableIds);
  const expected: RoomAggregateV1 = {
    ...projected,
    room: {
      ...projected.room,
      aggregateVersion: aggregate.room.aggregateVersion + 1,
      updatedAt,
    },
    membershipVersion: aggregate.membershipVersion + (appliedCount > 0 ? 1 : 0),
    pendingMembershipChanges: boundaryBase.pendingMembershipChanges.filter(
      (change) => !completedIds.has(change.id),
    ),
  };
  if (
    expected.room.aggregateVersion !== event.aggregateVersion
    || expected.membershipVersion !== declaredMembershipVersion
    || hashRoomValue(payload.projection) !== hashRoomValue(expected)
  ) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Room membership activation ${event.id} projection is not the exact version-2 boundary delta`,
    );
  }
  return expected;
}

function parseMembershipActivationOutcomesV2(
  value: unknown,
  eventId: string,
): readonly MembershipActivationOutcomeV2[] {
  const rows = requireEventArray(value, `${eventId} outcomes`);
  const seen = new Set<string>();
  return rows.map((value, index) => {
    const row = requireEventRecord(value, `${eventId} outcomes[${index}]`);
    const status = row.status;
    if (status !== "applied" && status !== "failed") {
      throw new RoomProjectionReplayError(
        "invalid_event_payload",
        `Room membership activation ${eventId} has an invalid outcome status`,
      );
    }
    assertExactKeys(
      row,
      status === "applied" ? ["changeId", "status"] : ["changeId", "status", "failureCode"],
      `${eventId} outcomes[${index}]`,
    );
    const changeId = requireTrimmedString(row.changeId, `${eventId} outcomes[${index}].changeId`);
    if (seen.has(changeId)) {
      throw new RoomProjectionReplayError(
        "invalid_event_payload",
        `Room membership activation ${eventId} duplicates outcome ${changeId}`,
      );
    }
    seen.add(changeId);
    if (status === "applied") return { changeId, status };
    if (row.failureCode !== "seat_not_found" && row.failureCode !== "binding_not_found") {
      throw new RoomProjectionReplayError(
        "invalid_event_payload",
        `Room membership activation ${eventId} has an invalid failure code`,
      );
    }
    return { changeId, status, failureCode: row.failureCode };
  });
}

function classifyMembershipReplayFailure(
  aggregate: RoomAggregateV1,
  change: PendingRoomMembershipChangeV1,
): "seat_not_found" | "binding_not_found" | null {
  if (change.kind === "add") return null;
  const seat = aggregate.seats.find((candidate) => candidate.id === change.seatId);
  if (!seat) return "seat_not_found";
  if (change.kind === "change_role") return null;
  if (
    !seat.activeBindingId
    || !aggregate.bindings.some((binding) => binding.id === seat.activeBindingId)
  ) {
    return "binding_not_found";
  }
  return null;
}

/*
FNXC:SessionRoomMembershipReplay 2026-07-18-01:56:
A membership request is replayable only as one exact pending delta against the
current active turn. Activation may carry the missing durable boundary evidence,
but only for that same turn: active becomes null and the one running or waiting
turn becomes completed, cancelled, or uncertain. All other Room, turn, seat,
binding, and pending state is derived and compared fail closed.
*/
function deriveMembershipActivationBoundary(
  aggregate: RoomAggregateV1,
  projection: Readonly<Record<string, unknown>>,
  eventId: string,
  turnId: string,
  updatedAt: string,
): RoomAggregateV1 {
  const boundaryTurn = aggregate.turns.find((turn) => turn.id === turnId);
  if (!boundaryTurn) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Room membership activation ${eventId} targets missing turn ${turnId}`,
    );
  }
  if (projection.activeTurnId !== null) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Room membership activation ${eventId} must clear activeTurnId at the boundary`,
    );
  }

  if (aggregate.activeTurnId === null) {
    if (
      !["completed", "cancelled", "uncertain"].includes(boundaryTurn.state)
      || boundaryTurn.endedAt === null
    ) {
      throw new RoomProjectionReplayError(
        "invalid_event_payload",
        `Room membership activation ${eventId} lacks a settled checkpoint boundary for turn ${turnId}`,
      );
    }
    return aggregate;
  }
  if (aggregate.activeTurnId !== turnId) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Room membership activation ${eventId} cannot settle unrelated active turn ${aggregate.activeTurnId}`,
    );
  }
  if (!["running", "waiting"].includes(boundaryTurn.state) || boundaryTurn.endedAt !== null) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Room membership activation ${eventId} has invalid pre-boundary state for turn ${turnId}`,
    );
  }

  const projectedTurns = requireEventArray(projection.turns, `${eventId} projection.turns`);
  const projectedMatches = projectedTurns
    .map((candidate) => requireEventRecord(candidate, `${eventId} projected turn`))
    .filter((candidate) => candidate.id === turnId);
  if (projectedMatches.length !== 1) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Room membership activation ${eventId} requires exactly one projected boundary turn ${turnId}`,
    );
  }
  const projectedBoundaryTurn = projectedMatches[0]!;
  const outcome = requireSettledTurnState(
    projectedBoundaryTurn.state,
    `${eventId} projected boundary turn state`,
  );
  const endedAt = requireIsoTimestamp(
    projectedBoundaryTurn.endedAt,
    `${eventId} projected boundary turn endedAt`,
  );
  if (
    Date.parse(endedAt) < Date.parse(boundaryTurn.startedAt ?? aggregate.room.createdAt)
    || Date.parse(endedAt) > Date.parse(updatedAt)
  ) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Room membership activation ${eventId} has impossible boundary time for turn ${turnId}`,
    );
  }
  return {
    ...aggregate,
    activeTurnId: null,
    turns: aggregate.turns.map((turn) => turn.id === turnId
      ? { ...turn, state: outcome, endedAt }
      : turn),
  };
}

function assertPendingMembershipChangeMatchesRequest(
  aggregate: RoomAggregateV1,
  pending: PendingRoomMembershipChangeV1,
  eventId: string,
  changeId: string,
  changeKind: PendingRoomMembershipChangeV1["kind"],
  effectiveAfterTurnId: string,
  updatedAt: string,
): void {
  if (
    pending.id !== changeId
    || pending.kind !== changeKind
    || pending.roomId !== aggregate.room.id
    || pending.effectiveAfterTurnId !== effectiveAfterTurnId
    || pending.state !== "waiting_turn_boundary"
    || pending.requestedAt !== updatedAt
  ) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Room membership request ${eventId} pending change does not match the event payload`,
    );
  }
  if (changeKind === "add") {
    if (
      !pending.seat
      || !pending.binding
      || pending.seat.id !== pending.seatId
      || aggregate.seats.some((seat) => seat.id === pending.seatId)
      || aggregate.bindings.some((binding) => binding.id === pending.binding!.id)
    ) {
      throw new RoomProjectionReplayError(
        "invalid_event_payload",
        `Room membership request ${eventId} has an invalid add delta`,
      );
    }
    return;
  }

  const seat = aggregate.seats.find((candidate) => candidate.id === pending.seatId);
  if (!seat || seat.state === "removed") {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Room membership request ${eventId} targets missing seat ${pending.seatId}`,
    );
  }
  if (
    changeKind !== "change_role"
    && (!seat.activeBindingId || !aggregate.bindings.some((binding) => binding.id === seat.activeBindingId))
  ) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Room membership request ${eventId} requires an active binding for seat ${pending.seatId}`,
    );
  }
}

function validatePendingMembershipChangeSet(
  values: readonly unknown[],
  label: string,
): readonly PendingRoomMembershipChangeV1[] {
  const parsed = values.map((value, index) =>
    parseStrictPendingMembershipChange(value, `${label}[${index}]`));
  const ids = new Set<string>();
  for (const change of parsed) {
    if (ids.has(change.id)) {
      throw new RoomProjectionReplayError(
        "invalid_event_payload",
        `${label} contains duplicate changeId ${change.id}`,
      );
    }
    ids.add(change.id);
  }
  return parsed;
}

function parseStrictPendingMembershipChange(
  value: unknown,
  label: string,
): PendingRoomMembershipChangeV1 {
  const pending = requireEventRecord(value, label);
  const kind = requireMembershipChangeKind(pending.kind, `${label}.kind`);
  const commonKeys = [
    "id",
    "roomId",
    "seatId",
    "kind",
    "reason",
    "effectiveAfterTurnId",
    "requestedAt",
    "state",
  ];
  const extraKeys = kind === "add"
    ? ["seat", "binding"]
    : kind === "replace"
      ? ["replacement"]
      : kind === "change_role"
        ? ["role"]
        : [];
  assertExactKeys(pending, [...commonKeys, ...extraKeys], label);
  if (pending.state !== "waiting_turn_boundary") {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `${label}.state must be waiting_turn_boundary`,
    );
  }
  const common = {
    id: requireTrimmedString(pending.id, `${label}.id`),
    roomId: requireTrimmedString(pending.roomId, `${label}.roomId`),
    seatId: requireTrimmedString(pending.seatId, `${label}.seatId`),
    kind,
    reason: requireTrimmedString(pending.reason, `${label}.reason`),
    effectiveAfterTurnId: requireNullableTrimmedString(
      pending.effectiveAfterTurnId,
      `${label}.effectiveAfterTurnId`,
    ),
    requestedAt: requireIsoTimestamp(pending.requestedAt, `${label}.requestedAt`),
    state: "waiting_turn_boundary" as const,
  };
  switch (kind) {
    case "add":
      return {
        ...common,
        kind,
        seat: parseStrictPendingSeat(pending.seat, `${label}.seat`),
        binding: parseStrictMembershipBinding(pending.binding, `${label}.binding`),
      };
    case "replace":
      return {
        ...common,
        kind,
        replacement: parseStrictMembershipBinding(
          pending.replacement,
          `${label}.replacement`,
        ),
      };
    case "change_role":
      return {
        ...common,
        kind,
        role: requireTrimmedString(pending.role, `${label}.role`),
      };
    case "pause":
    case "remove":
      return { ...common, kind };
  }
}

function parseStrictPendingSeat(
  value: unknown,
  label: string,
): NonNullable<PendingRoomMembershipChangeV1["seat"]> {
  const seat = requireEventRecord(value, label);
  assertExactKeys(seat, ["id", "role", "permissionScope"], label);
  return {
    id: requireTrimmedString(seat.id, `${label}.id`),
    role: requireTrimmedString(seat.role, `${label}.role`),
    permissionScope: requireUniqueStringArray(seat.permissionScope, `${label}.permissionScope`),
  };
}

function parseStrictMembershipBinding(
  value: unknown,
  label: string,
): NonNullable<PendingRoomMembershipChangeV1["binding"]> {
  const binding = requireEventRecord(value, label);
  assertExactKeys(binding, [
    "id",
    "connectorId",
    "providerId",
    "nativeSessionId",
    "happierSessionId",
    "serverProfileId",
    "machineId",
    "hostId",
  ], label);
  return {
    id: requireTrimmedString(binding.id, `${label}.id`),
    connectorId: requireTrimmedString(binding.connectorId, `${label}.connectorId`),
    providerId: requireTrimmedString(binding.providerId, `${label}.providerId`),
    nativeSessionId: requireTrimmedString(binding.nativeSessionId, `${label}.nativeSessionId`),
    happierSessionId: requireNullableTrimmedString(
      binding.happierSessionId,
      `${label}.happierSessionId`,
    ),
    serverProfileId: requireNullableTrimmedString(
      binding.serverProfileId,
      `${label}.serverProfileId`,
    ),
    machineId: requireNullableTrimmedString(binding.machineId, `${label}.machineId`),
    hostId: requireTrimmedString(binding.hostId, `${label}.hostId`),
  };
}

function applyMembershipChangesForReplay(
  aggregate: RoomAggregateV1,
  changes: readonly PendingRoomMembershipChangeV1[],
  now: string,
): RoomAggregateV1 {
  let next = aggregate;
  for (const change of changes) {
    next = applyMembershipChangeForReplay(next, change, now);
  }
  const appliedIds = new Set(changes.map((change) => change.id));
  return {
    ...next,
    room: {
      ...next.room,
      aggregateVersion: aggregate.room.aggregateVersion + 1,
      updatedAt: now,
    },
    membershipVersion: aggregate.membershipVersion + 1,
    pendingMembershipChanges: aggregate.pendingMembershipChanges.filter(
      (change) => !appliedIds.has(change.id),
    ),
  };
}

function applyMembershipChangeForReplay(
  aggregate: RoomAggregateV1,
  change: PendingRoomMembershipChangeV1,
  now: string,
): RoomAggregateV1 {
  switch (change.kind) {
    case "add":
      return applyAddMembershipChangeForReplay(aggregate, change, now);
    case "pause":
      return applyPauseMembershipChangeForReplay(aggregate, change, now);
    case "remove":
      return applyRemoveMembershipChangeForReplay(aggregate, change, now);
    case "change_role":
      return applyRoleMembershipChangeForReplay(aggregate, change, now);
    case "replace":
      return applyReplaceMembershipChangeForReplay(aggregate, change, now);
    default:
      throw new RoomProjectionReplayError(
        "invalid_event_payload",
        `Room membership activation ${change.id} has unsupported kind ${change.kind}`,
      );
  }
}

function applyAddMembershipChangeForReplay(
  aggregate: RoomAggregateV1,
  change: PendingRoomMembershipChangeV1,
  now: string,
): RoomAggregateV1 {
  const seat = change.seat;
  const binding = change.binding;
  if (!seat || !binding) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Room membership activation ${change.id} is missing add payload`,
    );
  }
  const seatId = requireString(seat.id, `${change.id} seat.id`);
  if (aggregate.seats.some((candidate) => candidate.id === seatId)) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Room membership activation ${change.id} duplicates seat ${seatId}`,
    );
  }
  const bindingId = requireString(binding.id, `${change.id} binding.id`);
  if (aggregate.bindings.some((candidate) => candidate.id === bindingId)) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Room membership activation ${change.id} duplicates binding ${bindingId}`,
    );
  }
  const nextSeat: RoomSeatRecordV1 = {
    contractVersion: 1,
    id: seatId,
    roomId: aggregate.room.id,
    role: requireString(seat.role, `${change.id} seat.role`),
    state: "active",
    permissionScope: [...requireStringArray(seat.permissionScope, `${change.id} seat.permissionScope`)],
    activeBindingId: bindingId,
    roleVersion: 1,
    createdAt: now,
    updatedAt: now,
  };
  return {
    ...aggregate,
    seats: [...aggregate.seats, nextSeat],
    bindings: [
      ...aggregate.bindings,
      createReplayBindingRecord(aggregate.room.id, seatId, 1, change.binding, now),
    ],
  };
}

function applyPauseMembershipChangeForReplay(
  aggregate: RoomAggregateV1,
  change: PendingRoomMembershipChangeV1,
  now: string,
): RoomAggregateV1 {
  const seat = requireReplaySeat(aggregate, change);
  const oldBinding = requireReplayActiveBinding(aggregate, seat, change);
  const nextSeats: RoomSeatRecordV1[] = aggregate.seats.map((candidate): RoomSeatRecordV1 =>
    candidate.id === seat.id
      ? { ...candidate, state: "paused" as const, updatedAt: now }
      : candidate,
  );
  const nextBindings: RoomBindingRecordV1[] = aggregate.bindings.map((binding): RoomBindingRecordV1 =>
    binding.id === oldBinding.id
      ? { ...binding, state: "paused" as const }
      : binding,
  );
  return {
    ...aggregate,
    seats: nextSeats,
    bindings: nextBindings,
  };
}

function applyRemoveMembershipChangeForReplay(
  aggregate: RoomAggregateV1,
  change: PendingRoomMembershipChangeV1,
  now: string,
): RoomAggregateV1 {
  const seat = requireReplaySeat(aggregate, change);
  const oldBinding = requireReplayActiveBinding(aggregate, seat, change);
  const nextSeats: RoomSeatRecordV1[] = aggregate.seats.map((candidate): RoomSeatRecordV1 =>
    candidate.id === seat.id
      ? { ...candidate, state: "removed" as const, activeBindingId: null, updatedAt: now }
      : candidate,
  );
  const nextBindings: RoomBindingRecordV1[] = aggregate.bindings.map((binding): RoomBindingRecordV1 =>
    binding.id === oldBinding.id
      ? { ...binding, state: "detached" as const, detachedAt: now }
      : binding,
  );
  return {
    ...aggregate,
    seats: nextSeats,
    bindings: nextBindings,
  };
}

function applyRoleMembershipChangeForReplay(
  aggregate: RoomAggregateV1,
  change: PendingRoomMembershipChangeV1,
  now: string,
): RoomAggregateV1 {
  const seat = requireReplaySeat(aggregate, change);
  const role = change.role;
  if (!role) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Room membership activation ${change.id} is missing role payload`,
    );
  }
  const nextSeats: RoomSeatRecordV1[] = aggregate.seats.map((candidate): RoomSeatRecordV1 =>
    candidate.id === seat.id
      ? { ...candidate, role, roleVersion: candidate.roleVersion + 1, updatedAt: now }
      : candidate,
  );
  return {
    ...aggregate,
    seats: nextSeats,
  };
}

function applyReplaceMembershipChangeForReplay(
  aggregate: RoomAggregateV1,
  change: PendingRoomMembershipChangeV1,
  now: string,
): RoomAggregateV1 {
  const seat = requireReplaySeat(aggregate, change);
  const oldBinding = requireReplayActiveBinding(aggregate, seat, change);
  if (!change.replacement) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Room membership activation ${change.id} is missing replacement payload`,
    );
  }
  const generation = nextReplayBindingGeneration(aggregate, seat.id);
  const replacement = createReplayBindingRecord(aggregate.room.id, seat.id, generation, change.replacement, now);
  const nextSeats: RoomSeatRecordV1[] = aggregate.seats.map((candidate): RoomSeatRecordV1 =>
    candidate.id === seat.id
      ? { ...candidate, state: "active" as const, activeBindingId: replacement.id, updatedAt: now }
      : candidate,
  );
  const nextBindings: RoomBindingRecordV1[] = [
    ...aggregate.bindings.map((binding): RoomBindingRecordV1 =>
      binding.id === oldBinding.id
        ? { ...binding, state: "replaced" as const, detachedAt: now, replacedByBindingId: replacement.id }
        : binding,
    ),
    replacement,
  ];
  return {
    ...aggregate,
    seats: nextSeats,
    bindings: nextBindings,
  };
}

function createReplayBindingRecord(
  roomId: string,
  seatId: string,
  generation: number,
  binding: NonNullable<PendingRoomMembershipChangeV1["binding"]>,
  now: string,
): RoomAggregateV1["bindings"][number] {
  return {
    contractVersion: 1,
    id: requireString(binding.id, `${binding.id ?? "unknown"} id`),
    roomId,
    seatId,
    generation,
    connectorId: requireString(binding.connectorId, `${binding.id} connectorId`),
    providerId: requireString(binding.providerId, `${binding.id} providerId`),
    nativeSessionId: requireString(binding.nativeSessionId, `${binding.id} nativeSessionId`),
    happierSessionId: binding.happierSessionId,
    serverProfileId: binding.serverProfileId,
    machineId: binding.machineId,
    hostId: requireString(binding.hostId, `${binding.id} hostId`),
    state: "attached",
    attachedAt: now,
    detachedAt: null,
    replacedByBindingId: null,
  };
}

function requireReplaySeat(
  aggregate: RoomAggregateV1,
  change: PendingRoomMembershipChangeV1,
): RoomAggregateV1["seats"][number] {
  const seat = aggregate.seats.find((candidate) => candidate.id === change.seatId);
  if (!seat) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Room membership activation ${change.id} targets missing seat ${change.seatId}`,
    );
  }
  return seat;
}

function requireReplayActiveBinding(
  aggregate: RoomAggregateV1,
  seat: RoomAggregateV1["seats"][number],
  change: PendingRoomMembershipChangeV1,
): RoomAggregateV1["bindings"][number] {
  if (!seat.activeBindingId) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Room membership activation ${change.id} requires an active binding for seat ${seat.id}`,
    );
  }
  const binding = aggregate.bindings.find((candidate) => candidate.id === seat.activeBindingId);
  if (!binding) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Room membership activation ${change.id} lost binding ${seat.activeBindingId}`,
    );
  }
  return binding;
}

function nextReplayBindingGeneration(aggregate: RoomAggregateV1, seatId: string): number {
  return aggregate.bindings.reduce(
    (highest, binding) => (binding.seatId === seatId ? Math.max(highest, binding.generation) : highest),
    0,
  ) + 1;
}

function comparePendingMembershipChanges(
  left: PendingRoomMembershipChangeV1,
  right: PendingRoomMembershipChangeV1,
): number {
  if (left.requestedAt !== right.requestedAt) {
    return left.requestedAt < right.requestedAt ? -1 : 1;
  }
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

function requireMembershipChangeKind(
  value: unknown,
  label: string,
): PendingRoomMembershipChangeV1["kind"] {
  if (
    value !== "add"
    && value !== "remove"
    && value !== "pause"
    && value !== "replace"
    && value !== "change_role"
  ) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `${label} must be a supported membership change kind`,
    );
  }
  return value;
}

function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  allowedKeys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...allowedKeys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `${label} must contain exactly [${expected.join(", ")}]; received [${actual.join(", ")}]`,
    );
  }
}

function requireEventRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `${label} must be an object`,
    );
  }
  return value as Record<string, unknown>;
}

function requireEventArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `${label} must be an array`,
    );
  }
  return value;
}

function requireTrimmedString(value: unknown, label: string): string {
  const result = requireString(value, label);
  if (result.trim() !== result || result.length === 0) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `${label} must be a trimmed non-empty string`,
    );
  }
  return result;
}

function requireNullableTrimmedString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return requireTrimmedString(value, label);
}

function requireIsoTimestamp(value: unknown, label: string): string {
  const result = requireTrimmedString(value, label);
  if (!Number.isFinite(Date.parse(result))) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `${label} must be a valid timestamp`,
    );
  }
  return result;
}

function requireUniqueStringArray(value: unknown, label: string): readonly string[] {
  const values = requireEventArray(value, label).map((candidate, index) =>
    requireTrimmedString(candidate, `${label}[${index}]`));
  if (new Set(values).size !== values.length) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `${label} must contain unique strings`,
    );
  }
  return values;
}

function requireSettledTurnState(
  value: unknown,
  label: string,
): Extract<RoomAggregateV1["turns"][number]["state"], "completed" | "cancelled" | "uncertain"> {
  if (value !== "completed" && value !== "cancelled" && value !== "uncertain") {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `${label} must be completed, cancelled, or uncertain`,
    );
  }
  return value;
}

function requireStringArray(value: unknown, label: string): readonly string[] {
  const array = requireArray(value, label);
  if (array.some((candidate) => typeof candidate !== "string" || candidate.length === 0)) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `${label} must be an array of non-empty strings`,
    );
  }
  return array as readonly string[];
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
  const supportedVersion = event.payload.projectionVersion === 1
    || (
      event.eventType === "membership_change_activated"
      && event.payload.projectionVersion === 2
    );
  if (!supportedVersion) {
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
