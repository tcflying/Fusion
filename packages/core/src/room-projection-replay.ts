import {
  RoomDomainError,
  createRoomAggregate,
  terminalizeRoomLifecycle,
  transitionRoomLifecycle,
  type PendingRoomMembershipChangeV1,
  type RoomAggregateV1,
} from "./room-domain.js";
import {
  createRoomTerminalizationProjection,
  parseRoomTerminalizationProjection,
  terminalizeRoomTerminalizationProjection,
  type RoomTerminalizationContractProjectionV1,
  type RoomTerminalizationContractRecordV1,
  type RoomTerminalizationMarkerV1,
} from "./room-terminalization-contract.js";
import {
  ROOM_LIFECYCLE_STATES,
  type RoomBindingRecordV1,
  type RoomEventRecordV1,
  type RoomLifecycleState,
  type RoomSeatRecordV1,
} from "./room-contracts/storage.js";
import { hashRoomValue } from "./room-integrity.js";
import {
  mergeRoomCapabilityRegistry,
  validateRoomBindingCapabilitySnapshot,
  type RoomBindingCapabilitySnapshotV1,
  type RoomCapabilityFreshnessPolicyV1,
  type RoomCapabilityRegistryV1,
} from "./room-capability-registry.js";
import { validateRoomProtocolMessage } from "./room-contracts/protocol-message.js";
import {
  evaluateRoomPhaseTransitionGateEvidence,
  type RoomPhaseGateEvidenceProtocolV1,
  type RoomPhaseGateEvidenceRecordV1,
  type RoomPhaseGateProducerLineageV1,
} from "./room-phase-gate-evidence.js";
import type {
  RoomTaskGraphProjectionV1,
  RoomTaskNoProgressRecoveryActionSnapshotV1,
  RoomTaskNoProgressRecoveryDecisionV1,
  RoomTaskProgressObservationEventSnapshotV1,
  RoomTaskProgressObservationV1,
  RoomTaskRecoveryActionEventSnapshotV1,
  RoomTaskRecoveryActionResultV1,
  RoomTaskRecoveryActionV1,
  RoomTaskRecoveryPlanEventSnapshotV1,
  RoomTaskRecoveryPlanV1,
  RoomSemanticControllerActionEventSnapshotV1,
  RoomSemanticControllerActionV1,
  RoomSemanticRouteEventSnapshotV1,
} from "./async-room-store.js";
import {
  createRoomCapabilitySnapshot,
  normalizeRoomRoleAssignmentConstraints,
  validateRoomRoleAssignment,
} from "./room-role-assignment.js";
import { getRoomProtocolDefinition } from "./room-protocol-definitions.js";
import type {
  RoomCapabilitySnapshotInputV1,
  RoomRoleAssignmentConstraintsV1,
  RoomRoleAssignmentV1,
} from "./room-contracts/assignment.js";
import type {
  RoomProtocolDefinitionV1,
  RoomProtocolNoProgressRecoveryPolicyV1,
  RoomProtocolRecoveryActionV1,
} from "./room-contracts/protocol.js";

export type RoomProjectionReplayErrorCode =
  | "empty_event_stream"
  | "event_identity_conflict"
  | "event_version_gap"
  | "event_cursor_conflict"
  | "unsupported_event"
  | "invalid_event_payload"
  | "invalid_checkpoint_projection"
  | "capability_registry_drift"
  | "terminalization_contract_drift";

export const ROOM_CAPABILITY_REGISTRY_MERGED_EVENT_TYPE = "room_capability_registry_merged";
export const ROOM_TERMINALIZATION_CONTRACT_RECORDED_EVENT_TYPE = "room_terminalization_contract_recorded";

export interface RoomCapabilityRegistryWorkerFenceV1 {
  readonly leaseId: string;
  readonly holderId: string;
  readonly hostId: string;
  readonly expectedEpoch: number;
}

/** Canonical event snapshot; it contains only authenticated binding samples, never synthesized reporter fields. */
export interface RoomCapabilityRegistryEventSnapshotV1 {
  readonly projectionVersion: 1;
  readonly registryId: string;
  readonly previousRegistryRevision: number;
  readonly registry: RoomCapabilityRegistryV1;
  readonly samples: readonly RoomBindingCapabilitySnapshotV1[];
  readonly freshness: RoomCapabilityFreshnessPolicyV1;
  readonly createdAt: string;
  readonly asOf: string;
  readonly workerFence: RoomCapabilityRegistryWorkerFenceV1;
}

export interface ReplayedRoomCapabilityRegistryProjectionV1 {
  readonly projectId: string;
  readonly roomId: string;
  readonly registry: RoomCapabilityRegistryV1;
  readonly aggregateVersion: number;
  readonly sourceEventId: string;
  readonly workerFence: RoomCapabilityRegistryWorkerFenceV1;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RoomTerminalizationContractRecordedEventSnapshotV1 {
  readonly projectionVersion: 1;
  readonly contract: RoomTerminalizationContractRecordV1;
  readonly contractHash: string;
  readonly recordedAt: string;
}

export interface RoomTerminalizedEventSnapshotV1 {
  readonly projectionVersion: 1;
  readonly contract: RoomTerminalizationContractRecordV1;
  readonly contractHash: string;
  readonly recordEventId: string;
  readonly from: RoomLifecycleState;
  readonly to: RoomLifecycleState;
  readonly terminalizedAt: string;
}

const REPLAY_REGISTRY_VALIDATION_FRESHNESS: RoomCapabilityFreshnessPolicyV1 = {
  maxSnapshotAgeMs: Number.MAX_SAFE_INTEGER,
  maxSignalAgeMs: Number.MAX_SAFE_INTEGER,
  maxFutureSkewMs: 0,
};

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

/**
 * Rebuild only the terminalization projection from its immutable Room events.
 * The mutable JSONB projection is deliberately excluded so an altered row can
 * never be treated as an independently verified completion contract.
 */
export function rebuildRoomTerminalizationProjectionFromEvents(
  events: readonly RoomEventRecordV1[],
): RoomTerminalizationContractProjectionV1 | null {
  if (events.length === 0) return null;
  assertEventOrder(events);
  let projection: RoomTerminalizationContractProjectionV1 | null = null;
  for (const event of events) {
    if (event.eventType === ROOM_TERMINALIZATION_CONTRACT_RECORDED_EVENT_TYPE) {
      const contract = parseTerminalizationContractRecordedEvent(event);
      if (projection?.state === "terminalized") {
        throw new RoomProjectionReplayError(
          "terminalization_contract_drift",
          `Terminalization contract ${contract.id} was recorded after Room ${event.roomId} terminalized`,
          { eventId: event.id },
        );
      }
      projection = createRoomTerminalizationProjection(contract);
      continue;
    }
    if (event.eventType === "room_terminalized") {
      const snapshot = parseRoomTerminalizedEvent(event);
      if (!projection) {
        throw new RoomProjectionReplayError(
          "terminalization_contract_drift",
          `Terminal event ${event.id} has no preceding immutable contract-record event`,
        );
      }
      if (
        projection.contract.id !== snapshot.contract.id
        || projection.contract.contractHash !== snapshot.contractHash
        || projection.contract.recordEventId !== snapshot.recordEventId
      ) {
        throw new RoomProjectionReplayError(
          "terminalization_contract_drift",
          `Terminal event ${event.id} does not bind the current immutable terminalization contract`,
        );
      }
      const marker: RoomTerminalizationMarkerV1 = {
        contractId: snapshot.contract.id,
        contractHash: snapshot.contractHash,
        outcome: snapshot.contract.requestedOutcome,
        eventId: event.id,
        aggregateVersion: event.aggregateVersion,
        terminalizedAt: snapshot.terminalizedAt,
      };
      try {
        projection = terminalizeRoomTerminalizationProjection(projection, marker);
      } catch (error) {
        throw terminalizationReplayError(event, error);
      }
    }
  }
  return projection;
}

/**
 * Rebuild the current capability registry strictly from immutable Room events.
 * Projection-table contents are intentionally excluded so a stale or forged
 * row cannot make replay appear healthy.
 */
export function rebuildRoomCapabilityRegistryProjectionFromEvents(
  events: readonly RoomEventRecordV1[],
): ReplayedRoomCapabilityRegistryProjectionV1 | null {
  // This also verifies the Room aggregate versions, identities, and all event
  // types surrounding the registry event before its projection is trusted.
  rebuildRoomProjectionFromEvents(events);

  let current: RoomCapabilityRegistryV1 | null = null;
  let replayed: ReplayedRoomCapabilityRegistryProjectionV1 | null = null;
  for (const event of events) {
    if (event.eventType !== ROOM_CAPABILITY_REGISTRY_MERGED_EVENT_TYPE) continue;
    const snapshot = parseRoomCapabilityRegistryEventSnapshot(event);
    const expectedPreviousRevision = current?.revision ?? 0;
    if (snapshot.previousRegistryRevision !== expectedPreviousRevision) {
      throw new RoomProjectionReplayError(
        "capability_registry_drift",
        `Capability registry event ${event.id} expected prior revision ${expectedPreviousRevision}; received ${snapshot.previousRegistryRevision}`,
        { eventId: event.id, expectedPreviousRevision, actualPreviousRevision: snapshot.previousRegistryRevision },
      );
    }
    const merged = mergeRoomCapabilityRegistry({
      registryId: snapshot.registryId,
      current,
      samples: snapshot.samples,
      asOf: snapshot.asOf,
      freshness: snapshot.freshness,
    });
    if (!merged.ok) {
      throw new RoomProjectionReplayError(
        "capability_registry_drift",
        `Capability registry event ${event.id} cannot be reproduced from its immutable samples`,
        { eventId: event.id, issues: merged.issues },
      );
    }
    if (hashRoomValue(snapshot.registry) !== hashRoomValue(merged.value)) {
      throw new RoomProjectionReplayError(
        "capability_registry_drift",
        `Capability registry event ${event.id} does not match its deterministic merge result`,
        { eventId: event.id, registryId: snapshot.registryId },
      );
    }
    current = merged.value;
    replayed = {
      projectId: event.projectId,
      roomId: event.roomId,
      registry: current,
      aggregateVersion: event.aggregateVersion,
      sourceEventId: event.id,
      workerFence: snapshot.workerFence,
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.asOf,
    };
  }
  return replayed;
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
    case ROOM_TERMINALIZATION_CONTRACT_RECORDED_EVENT_TYPE: {
      const contract = parseTerminalizationContractRecordedEvent(event);
      if (contract.roomId !== aggregate.room.id || contract.projectId !== aggregate.room.projectId) {
        throw new RoomProjectionReplayError(
          "invalid_event_payload",
          `Terminalization contract event ${event.id} belongs to another Room`,
        );
      }
      if (contract.aggregateVersion !== event.aggregateVersion) {
        throw new RoomProjectionReplayError(
          "invalid_event_payload",
          `Terminalization contract event ${event.id} has an aggregate-version mismatch`,
        );
      }
      return {
        ...aggregate,
        room: {
          ...aggregate.room,
          aggregateVersion: event.aggregateVersion,
          updatedAt: contract.recordedAt,
        },
      };
    }
    case "room_terminalized": {
      const snapshot = parseRoomTerminalizedEvent(event);
      if (snapshot.from !== aggregate.room.state) {
        throw new RoomProjectionReplayError(
          "invalid_event_payload",
          `Terminal event ${event.id} expected state ${snapshot.from} but replay is ${aggregate.room.state}`,
        );
      }
      if (snapshot.to !== snapshot.contract.requestedOutcome) {
        throw new RoomProjectionReplayError(
          "invalid_event_payload",
          `Terminal event ${event.id} outcome differs from the bound contract`,
        );
      }
      const marker: RoomTerminalizationMarkerV1 = {
        contractId: snapshot.contract.id,
        contractHash: snapshot.contractHash,
        outcome: snapshot.contract.requestedOutcome,
        eventId: event.id,
        aggregateVersion: event.aggregateVersion,
        terminalizedAt: snapshot.terminalizedAt,
      };
      try {
        return terminalizeRoomLifecycle(aggregate, {
          to: snapshot.to,
          expectedAggregateVersion: aggregate.room.aggregateVersion,
          now: snapshot.terminalizedAt,
          terminalization: marker,
        });
      } catch (error) {
        throw terminalizationReplayError(event, error);
      }
    }
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
    case "room_task_graph_mutated":
      return validateTaskGraphMutation(aggregate, event, payload);
    case "room_task_dispatch_claimed":
      return validateTaskDispatchClaim(aggregate, event, payload);
    case "room_task_dispatch_delivery_rejected":
    case "room_task_dispatch_delivery_uncertain_blocked":
      return validateTaskDispatchDeliveryBlocked(aggregate, event, payload);
    case "room_phase_gate_evidence_recorded":
      return validateRoomPhaseGateEvidenceRecorded(aggregate, event, payload);
    case "room_role_assignment_activated":
    case "room_role_assignment_transitioned":
      return validateRoomRoleAssignmentActivation(aggregate, event, payload);
    case "room_semantic_state_updated":
      return validateRoomSemanticStateUpdated(aggregate, event, payload);
    case "room_protocol_message_routed":
      return validateRoomProtocolMessageRouted(aggregate, event, payload);
    case "room_semantic_controller_action_claimed":
    case "room_semantic_controller_action_completed":
      return validateRoomSemanticControllerActionEvent(aggregate, event, payload);
    case "room_task_progress_observed":
    case "room_task_recovery_action_enqueued":
    case "room_task_recovery_ladder_exhausted":
      return validateRoomTaskProgressObservationEvent(aggregate, event, payload);
    case "room_task_recovery_action_claimed":
    case "room_task_recovery_action_completed":
      return validateRoomTaskRecoveryActionEvent(aggregate, event, payload);
    case "room_task_recovery_plan_recorded":
      return validateRoomTaskRecoveryPlanEvent(aggregate, event, payload);
    case ROOM_CAPABILITY_REGISTRY_MERGED_EVENT_TYPE:
      return validateRoomCapabilityRegistryMergedEvent(aggregate, event);
    case "membership_change_requested":
      return validateMembershipChangeRequested(aggregate, event, payload);
    case "membership_change_activated":
      return validateMembershipChangeActivated(aggregate, event, payload);
    case "sender_takeover_blocked_delivery_uncertain": {
      assertExactKeys(payload, [
        "projectionVersion",
        "bindingId",
        "takeoverId",
        "takeoverEpoch",
        "outboxIds",
        "updatedAt",
      ], `${event.id} payload`);
      if (requireNonNegativeInteger(payload.projectionVersion, `${event.id} projectionVersion`) !== 1) {
        throw new RoomProjectionReplayError(
          "invalid_event_payload",
          `Sender takeover event ${event.id} requires projection version 1`,
        );
      }
      requireTrimmedString(payload.bindingId, `${event.id} bindingId`);
      requireTrimmedString(payload.takeoverId, `${event.id} takeoverId`);
      requirePositiveInteger(payload.takeoverEpoch, `${event.id} takeoverEpoch`);
      const outboxIds = requireArray(payload.outboxIds, `${event.id} outboxIds`);
      if (
        outboxIds.length === 0
        || outboxIds.some((id) => typeof id !== "string" || id.trim().length === 0)
        || new Set(outboxIds).size !== outboxIds.length
      ) {
        throw new RoomProjectionReplayError(
          "invalid_event_payload",
          `Sender takeover event ${event.id} requires unique non-empty outbox IDs`,
        );
      }
      const updatedAt = requireIsoTimestamp(payload.updatedAt, `${event.id} updatedAt`);
      const occurredAt = requireIsoTimestamp(event.occurredAt, `${event.id} occurredAt`);
      if (
        new Date(Date.parse(updatedAt)).toISOString() !== updatedAt
        || new Date(Date.parse(occurredAt)).toISOString() !== occurredAt
      ) {
        throw new RoomProjectionReplayError(
          "invalid_event_payload",
          `Sender takeover event ${event.id} requires canonical UTC timestamps`,
        );
      }
      if (Date.parse(occurredAt) > Date.parse(updatedAt)) {
        throw new RoomProjectionReplayError(
          "invalid_event_payload",
          `Sender takeover event ${event.id} cannot occur after its projection update`,
        );
      }
      if (Date.parse(updatedAt) < Date.parse(aggregate.room.updatedAt)) {
        throw new RoomProjectionReplayError(
          "invalid_event_payload",
          `Sender takeover event ${event.id} cannot move Room time backwards`,
        );
      }
      return {
        ...aggregate,
        room: {
          ...aggregate.room,
          aggregateVersion: event.aggregateVersion,
          updatedAt,
        },
      };
    }
    default:
      throw new RoomProjectionReplayError(
        "unsupported_event",
        `Room projection replay does not support event type ${event.eventType}`,
        { eventId: event.id, eventType: event.eventType },
      );
  }
}

function parseTerminalizationContractRecordedEvent(
  event: RoomEventRecordV1,
): RoomTerminalizationContractRecordV1 {
  const payload = requireEventPayload(event);
  assertExactKeys(payload, [
    "projectionVersion",
    "contract",
    "contractHash",
    "recordedAt",
  ], `${event.id} terminalization-contract payload`);
  if (requireNonNegativeInteger(payload.projectionVersion, `${event.id} projectionVersion`) !== 1) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Terminalization contract event ${event.id} requires projection version 1`,
    );
  }
  const recordedAt = requireCanonicalUtcTimestamp(payload.recordedAt, `${event.id} recordedAt`);
  if (recordedAt !== requireCanonicalUtcTimestamp(event.occurredAt, `${event.id} occurredAt`)) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Terminalization contract event ${event.id} recordedAt differs from its event time`,
    );
  }
  const contractHash = requireString(payload.contractHash, `${event.id} contractHash`);
  let projection: RoomTerminalizationContractProjectionV1 | null;
  try {
    projection = parseRoomTerminalizationProjection({
      contractVersion: 1,
      contract: payload.contract,
      state: "recorded",
      terminalization: null,
    });
  } catch (error) {
    throw terminalizationReplayError(event, error);
  }
  if (!projection || projection.contract.contractHash !== contractHash) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Terminalization contract event ${event.id} hash does not match its contract`,
    );
  }
  const contract = projection.contract;
  if (contract.recordEventId !== event.id || contract.aggregateVersion !== event.aggregateVersion) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Terminalization contract event ${event.id} identity or aggregate version is invalid`,
    );
  }
  if (contract.recordedAt !== recordedAt) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Terminalization contract event ${event.id} contract time differs from payload time`,
    );
  }
  return contract;
}

function parseRoomTerminalizedEvent(
  event: RoomEventRecordV1,
): RoomTerminalizedEventSnapshotV1 {
  const payload = requireEventPayload(event);
  assertExactKeys(payload, [
    "projectionVersion",
    "contract",
    "contractId",
    "contractHash",
    "recordEventId",
    "from",
    "to",
    "terminalizedAt",
  ], `${event.id} terminalized payload`);
  if (requireNonNegativeInteger(payload.projectionVersion, `${event.id} projectionVersion`) !== 1) {
    throw new RoomProjectionReplayError("invalid_event_payload", `Terminal event ${event.id} requires projection version 1`);
  }
  const contractHash = requireString(payload.contractHash, `${event.id} contractHash`);
  const contractId = requireString(payload.contractId, `${event.id} contractId`);
  let projection: RoomTerminalizationContractProjectionV1 | null;
  try {
    projection = parseRoomTerminalizationProjection({
      contractVersion: 1,
      contract: payload.contract,
      state: "recorded",
      terminalization: null,
    });
  } catch (error) {
    throw terminalizationReplayError(event, error);
  }
  if (!projection || projection.contract.contractHash !== contractHash || projection.contract.id !== contractId) {
    throw new RoomProjectionReplayError("invalid_event_payload", `Terminal event ${event.id} contract hash is invalid`);
  }
  const contract = projection.contract;
  const recordEventId = requireString(payload.recordEventId, `${event.id} recordEventId`);
  const from = requireLifecycleState(payload.from, `${event.id} from`);
  const to = requireLifecycleState(payload.to, `${event.id} to`);
  const terminalizedAt = requireCanonicalUtcTimestamp(payload.terminalizedAt, `${event.id} terminalizedAt`);
  if (terminalizedAt !== requireCanonicalUtcTimestamp(event.occurredAt, `${event.id} occurredAt`)) {
    throw new RoomProjectionReplayError("invalid_event_payload", `Terminal event ${event.id} time differs from its event time`);
  }
  if (contract.recordEventId !== recordEventId || contract.aggregateVersion + 1 !== event.aggregateVersion) {
    throw new RoomProjectionReplayError("invalid_event_payload", `Terminal event ${event.id} does not immediately follow its contract`);
  }
  if (!contract.decision.canTerminalize || contract.requestedOutcome !== to) {
    throw new RoomProjectionReplayError("invalid_event_payload", `Terminal event ${event.id} bypasses its contract decision`);
  }
  return {
    projectionVersion: 1,
    contract,
    contractHash,
    recordEventId,
    from,
    to,
    terminalizedAt,
  };
}

function terminalizationReplayError(event: RoomEventRecordV1, error: unknown): RoomProjectionReplayError {
  const message = error instanceof Error ? error.message : "invalid terminalization contract";
  return new RoomProjectionReplayError(
    "terminalization_contract_drift",
    `Terminalization replay rejected event ${event.id}: ${message}`,
    { eventId: event.id },
  );
}

function requireCanonicalUtcTimestamp(value: unknown, label: string): string {
  const timestamp = requireString(value, label);
  if (!Number.isFinite(Date.parse(timestamp)) || new Date(Date.parse(timestamp)).toISOString() !== timestamp) {
    throw new RoomProjectionReplayError("invalid_event_payload", `${label} must be canonical UTC`);
  }
  return timestamp;
}

function validateRoomCapabilityRegistryMergedEvent(
  aggregate: RoomAggregateV1,
  event: RoomEventRecordV1,
): RoomAggregateV1 {
  const snapshot = parseRoomCapabilityRegistryEventSnapshot(event);
  if (event.actorType !== "controller" || event.actorId !== snapshot.workerFence.holderId) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Capability registry event ${event.id} must be committed by its fenced Room worker`,
    );
  }
  const occurredAt = requireCanonicalUtcIsoTimestamp(event.occurredAt, `${event.id} occurredAt`);
  if (occurredAt !== snapshot.asOf) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Capability registry event ${event.id} must use one canonical observation timestamp`,
    );
  }
  if (Date.parse(snapshot.asOf) < Date.parse(aggregate.room.updatedAt)) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Capability registry event ${event.id} cannot move Room time backwards`,
    );
  }
  return {
    ...aggregate,
    room: {
      ...aggregate.room,
      aggregateVersion: event.aggregateVersion,
      updatedAt: snapshot.asOf,
    },
  };
}

function parseRoomCapabilityRegistryEventSnapshot(
  event: RoomEventRecordV1,
): RoomCapabilityRegistryEventSnapshotV1 {
  const payload = requireEventPayload(event);
  assertExactKeys(payload, [
    "projectionVersion",
    "registryId",
    "previousRegistryRevision",
    "registry",
    "samples",
    "freshness",
    "createdAt",
    "asOf",
    "workerFence",
  ], `${event.id} payload`);
  if (requireNonNegativeInteger(payload.projectionVersion, `${event.id} projectionVersion`) !== 1) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Capability registry event ${event.id} requires projection version 1`,
    );
  }
  const registryId = requireTrimmedString(payload.registryId, `${event.id} registryId`);
  const previousRegistryRevision = requireNonNegativeInteger(
    payload.previousRegistryRevision,
    `${event.id} previousRegistryRevision`,
  );
  const createdAt = requireCanonicalUtcIsoTimestamp(payload.createdAt, `${event.id} createdAt`);
  const asOf = requireCanonicalUtcIsoTimestamp(payload.asOf, `${event.id} asOf`);
  if (Date.parse(createdAt) > Date.parse(asOf)) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Capability registry event ${event.id} cannot update before its projection was created`,
    );
  }
  const freshness = requireRecord(payload.freshness, `${event.id} freshness`);
  assertExactKeys(freshness, [
    "maxSnapshotAgeMs",
    "maxSignalAgeMs",
    "maxFutureSkewMs",
  ], `${event.id} freshness`);
  const rawRegistry = requireRecord(payload.registry, `${event.id} registry`);
  const validatedRegistry = mergeRoomCapabilityRegistry({
    registryId,
    current: rawRegistry as unknown as RoomCapabilityRegistryV1,
    samples: [],
    asOf,
    freshness: freshness as unknown as RoomCapabilityFreshnessPolicyV1,
  });
  if (!validatedRegistry.ok) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Capability registry event ${event.id} has an invalid canonical registry`,
      { eventId: event.id, issues: validatedRegistry.issues },
    );
  }
  const registry = validatedRegistry.value;
  if (
    registry.registryId !== registryId
    || registry.observedAt !== asOf
    || registry.revision !== previousRegistryRevision + 1
  ) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Capability registry event ${event.id} has inconsistent revision or observation metadata`,
    );
  }
  const sampleValues = requireArray(payload.samples, `${event.id} samples`);
  if (sampleValues.length === 0) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Capability registry event ${event.id} requires at least one concrete binding sample`,
    );
  }
  const samples = sampleValues.map((value, index) => {
    const validated = validateRoomBindingCapabilitySnapshot(value);
    if (!validated.ok) {
      throw new RoomProjectionReplayError(
        "invalid_event_payload",
        `Capability registry event ${event.id} has an invalid binding sample at index ${index}`,
        { eventId: event.id, issues: validated.issues },
      );
    }
    return validated.value;
  });
  const workerFence = requireRecord(payload.workerFence, `${event.id} workerFence`);
  assertExactKeys(workerFence, ["leaseId", "holderId", "hostId", "expectedEpoch"], `${event.id} workerFence`);
  return {
    projectionVersion: 1,
    registryId,
    previousRegistryRevision,
    registry,
    samples,
    freshness: freshness as unknown as RoomCapabilityFreshnessPolicyV1,
    createdAt,
    asOf,
    workerFence: {
      leaseId: requireTrimmedString(workerFence.leaseId, `${event.id} workerFence.leaseId`),
      holderId: requireTrimmedString(workerFence.holderId, `${event.id} workerFence.holderId`),
      hostId: requireTrimmedString(workerFence.hostId, `${event.id} workerFence.hostId`),
      expectedEpoch: requirePositiveInteger(workerFence.expectedEpoch, `${event.id} workerFence.expectedEpoch`),
    },
  };
}

function validateRoomPhaseGateEvidenceRecorded(
  aggregate: RoomAggregateV1,
  event: RoomEventRecordV1,
  payload: Readonly<Record<string, unknown>>,
): RoomAggregateV1 {
  assertExactKeys(payload, [
    "projectionVersion",
    "phaseGateEvidenceId",
    "evidence",
    "evidenceHash",
    "producerLineage",
    "evidenceNotBefore",
    "recordedAt",
  ], `${event.id} payload`);
  if (requireNonNegativeInteger(payload.projectionVersion, `${event.id} projectionVersion`) !== 1) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Phase-gate evidence event ${event.id} requires projection version 1`,
    );
  }
  const evidenceId = requireTrimmedString(payload.phaseGateEvidenceId, `${event.id} phaseGateEvidenceId`);
  const evidence = requireRecord(payload.evidence, `${event.id} evidence`);
  const evidenceHash = requireTrimmedString(payload.evidenceHash, `${event.id} evidenceHash`);
  const producerLineage = requireRecord(payload.producerLineage, `${event.id} producerLineage`);
  const evidenceNotBefore = requireIsoTimestamp(payload.evidenceNotBefore, `${event.id} evidenceNotBefore`);
  const recordedAt = requireIsoTimestamp(payload.recordedAt, `${event.id} recordedAt`);
  if (evidence.id !== evidenceId || evidenceHash !== hashRoomValue(evidence)) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Phase-gate evidence event ${event.id} has a mismatched immutable evidence identity or hash`,
    );
  }
  const protocol = getRoomProtocolDefinition(aggregate.room.protocolId, aggregate.room.protocolVersion);
  if (!protocol) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Phase-gate evidence event ${event.id} references an unsupported Room protocol`,
    );
  }
  const fromPhaseId = typeof evidence.phaseId === "string" ? evidence.phaseId : "__invalid_phase__";
  const gateId = typeof evidence.gateId === "string" ? evidence.gateId : "__invalid_gate__";
  const targetPhaseId = findReplayProtocolTargetPhase(protocol, fromPhaseId, gateId);
  const turnId = typeof evidence.turnId === "string" ? evidence.turnId : "__invalid_turn__";
  const decision = evaluateReplayPhaseGateEvidence({
    protocol,
    fromPhaseId,
    targetPhaseId,
    turnId,
    evidence: evidence as unknown as RoomPhaseGateEvidenceRecordV1,
    evidenceNotBefore,
    evaluatedAt: recordedAt,
    producerLineage: producerLineage as unknown as RoomPhaseGateProducerLineageV1,
  });
  if (!decision.transitionAllowed || decision.acceptedEvidenceId !== evidenceId) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Phase-gate evidence event ${event.id} does not independently satisfy its declared transition`,
    );
  }
  const occurredAt = requireIsoTimestamp(event.occurredAt, `${event.id} occurredAt`);
  if (Date.parse(occurredAt) > Date.parse(recordedAt)) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Phase-gate evidence event ${event.id} cannot be recorded before it occurred`,
    );
  }
  return {
    ...aggregate,
    room: {
      ...aggregate.room,
      aggregateVersion: event.aggregateVersion,
      updatedAt: recordedAt,
    },
  };
}

function toReplayPhaseGateEvidenceProtocol(
  protocol: RoomProtocolDefinitionV1,
): RoomPhaseGateEvidenceProtocolV1 {
  return {
    contractVersion: 1,
    id: protocol.id,
    version: protocol.version,
    definitionHash: hashRoomValue(protocol),
    phases: protocol.phases.map((phase) => ({
      id: phase.id,
      entryGateIds: [...phase.entryGateIds],
      exitGateIds: [...phase.exitGateIds],
    })),
    gates: protocol.gates.map((gate) => ({ id: gate.id, kind: gate.kind, hard: gate.hard })),
    transitions: protocol.transitions.map((transition) => ({
      fromPhaseId: transition.fromPhaseId,
      toPhaseId: transition.toPhaseId,
      whenGateId: transition.whenGateId,
    })),
  };
}

function findReplayProtocolTargetPhase(
  protocol: RoomProtocolDefinitionV1,
  fromPhaseId: string,
  gateId: string,
): string {
  return protocol.transitions.find((transition) => (
    transition.fromPhaseId === fromPhaseId && transition.whenGateId === gateId
  ))?.toPhaseId ?? "__undeclared_phase__";
}

function evaluateReplayPhaseGateEvidence(input: {
  readonly protocol: RoomProtocolDefinitionV1;
  readonly fromPhaseId: string;
  readonly targetPhaseId: string;
  readonly turnId: string;
  readonly evidence: RoomPhaseGateEvidenceRecordV1;
  readonly evidenceNotBefore: string;
  readonly evaluatedAt: string;
  readonly producerLineage: RoomPhaseGateProducerLineageV1;
}) {
  return evaluateRoomPhaseTransitionGateEvidence({
    contractVersion: 1,
    protocol: toReplayPhaseGateEvidenceProtocol(input.protocol),
    transition: {
      protocolId: input.protocol.id,
      protocolVersion: input.protocol.version,
      protocolHash: hashRoomValue(input.protocol),
      fromPhaseId: input.fromPhaseId,
      toPhaseId: input.targetPhaseId,
      turnId: input.turnId,
      candidateId: input.evidence.candidateId,
      candidateHash: input.evidence.candidateHash,
      evidenceNotBefore: input.evidenceNotBefore,
      evaluatedAt: input.evaluatedAt,
    },
    evidenceLedger: { source: "durable_room_phase_gate_ledger", records: [input.evidence] },
    producerLineage: input.producerLineage,
  });
}

/**
 * The aggregate intentionally has no role-assignment field: assignment
 * history lives in its own versioned projection. Replay still validates the
 * immutable policy evidence here, so checkpoints cannot advance past forged
 * capability evidence or producer/verifier lineage.
 */
function validateRoomRoleAssignmentActivation(
  aggregate: RoomAggregateV1,
  event: RoomEventRecordV1,
  payload: Readonly<Record<string, unknown>>,
): RoomAggregateV1 {
  const transitioned = event.eventType === "room_role_assignment_transitioned";
  assertExactKeys(payload, [
    "projectionVersion",
    "assignmentId",
    "revision",
    "protocolId",
    "protocolVersion",
    "phaseId",
    "capabilitySnapshot",
    "capabilitySnapshotHash",
    "constraints",
    "constraintsHash",
    "assignment",
    "assignmentHash",
    "authoritativeProducerBindingIds",
    "updatedAt",
    ...(transitioned ? [
      "previousAssignmentId",
      "boundaryTurnId",
      "phaseGateEvidenceId",
      "phaseGateEvidence",
      "phaseGateEvidenceHash",
      "producerLineage",
      "evidenceNotBefore",
      "verifiedTransitionGateId",
    ] : []),
  ], `${event.id} payload`);
  if (requireNonNegativeInteger(payload.projectionVersion, `${event.id} projectionVersion`) !== 1) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Role-assignment event ${event.id} requires projection version 1`,
    );
  }
  requireTrimmedString(payload.assignmentId, `${event.id} assignmentId`);
  requirePositiveInteger(payload.revision, `${event.id} revision`);
  if (transitioned) {
    const previousAssignmentId = requireTrimmedString(
      payload.previousAssignmentId,
      `${event.id} previousAssignmentId`,
    );
    if (previousAssignmentId === payload.assignmentId) {
      throw new RoomProjectionReplayError(
        "invalid_event_payload",
        `Role-transition event ${event.id} cannot supersede itself`,
      );
    }
    requireTrimmedString(payload.boundaryTurnId, `${event.id} boundaryTurnId`);
    const phaseGateEvidenceId = requireTrimmedString(
      payload.phaseGateEvidenceId,
      `${event.id} phaseGateEvidenceId`,
    );
    const phaseGateEvidence = requireRecord(
      payload.phaseGateEvidence,
      `${event.id} phaseGateEvidence`,
    );
    if (
      phaseGateEvidence.id !== phaseGateEvidenceId
      || payload.phaseGateEvidenceHash !== hashRoomValue(phaseGateEvidence)
    ) {
      throw new RoomProjectionReplayError(
        "invalid_event_payload",
        `Role-transition event ${event.id} has invalid immutable phase-gate evidence identity or hash`,
      );
    }
    requireRecord(payload.producerLineage, `${event.id} producerLineage`);
    requireIsoTimestamp(payload.evidenceNotBefore, `${event.id} evidenceNotBefore`);
    requireTrimmedString(payload.verifiedTransitionGateId, `${event.id} verifiedTransitionGateId`);
  }
  const protocolId = requireTrimmedString(payload.protocolId, `${event.id} protocolId`);
  const protocolVersion = requirePositiveInteger(payload.protocolVersion, `${event.id} protocolVersion`);
  const phaseId = requireTrimmedString(payload.phaseId, `${event.id} phaseId`);
  if (
    protocolId !== aggregate.room.protocolId
    || protocolVersion !== aggregate.room.protocolVersion
  ) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Role-assignment event ${event.id} protocol does not match the Room aggregate`,
    );
  }
  const protocol = getRoomProtocolDefinition(protocolId, protocolVersion);
  if (!protocol) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Role-assignment event ${event.id} references an unsupported protocol`,
    );
  }
  if (transitioned) {
    const boundaryTurnId = requireTrimmedString(payload.boundaryTurnId, `${event.id} boundaryTurnId`);
    const evidence = requireRecord(payload.phaseGateEvidence, `${event.id} phaseGateEvidence`);
    const evidenceId = requireTrimmedString(payload.phaseGateEvidenceId, `${event.id} phaseGateEvidenceId`);
    const producerLineage = requireRecord(payload.producerLineage, `${event.id} producerLineage`);
    const evidenceNotBefore = requireIsoTimestamp(payload.evidenceNotBefore, `${event.id} evidenceNotBefore`);
    const verifiedTransitionGateId = requireTrimmedString(
      payload.verifiedTransitionGateId,
      `${event.id} verifiedTransitionGateId`,
    );
    const decision = evaluateReplayPhaseGateEvidence({
      protocol,
      fromPhaseId: (evidence.phaseId as string) ?? "",
      targetPhaseId: phaseId,
      turnId: boundaryTurnId,
      evidence: evidence as unknown as RoomPhaseGateEvidenceRecordV1,
      evidenceNotBefore,
      evaluatedAt: requireIsoTimestamp(payload.updatedAt, `${event.id} updatedAt`),
      producerLineage: producerLineage as unknown as RoomPhaseGateProducerLineageV1,
    });
    if (
      !decision.transitionAllowed
      || decision.acceptedEvidenceId !== evidenceId
      || decision.exactGateId !== verifiedTransitionGateId
    ) {
      throw new RoomProjectionReplayError(
        "invalid_event_payload",
        `Role-transition event ${event.id} phase-gate proof is insufficient or forged`,
      );
    }
  }
  const snapshotRaw = requireRecord(payload.capabilitySnapshot, `${event.id} capabilitySnapshot`);
  const snapshotResult = createRoomCapabilitySnapshot(
    snapshotRaw as unknown as RoomCapabilitySnapshotInputV1,
  );
  if (!snapshotResult.ok) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Role-assignment event ${event.id} has invalid capability evidence`,
    );
  }
  const constraintsRaw = requireRecord(payload.constraints, `${event.id} constraints`);
  const constraintsResult = normalizeRoomRoleAssignmentConstraints(
    constraintsRaw as unknown as RoomRoleAssignmentConstraintsV1,
  );
  if (!constraintsResult.ok) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Role-assignment event ${event.id} has invalid user constraints`,
    );
  }
  if (
    hashRoomValue(snapshotRaw) !== hashRoomValue(snapshotResult.value)
    || hashRoomValue(constraintsRaw) !== hashRoomValue(constraintsResult.value)
    || payload.capabilitySnapshotHash !== hashRoomValue(snapshotResult.value)
    || payload.constraintsHash !== hashRoomValue(constraintsResult.value)
  ) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Role-assignment event ${event.id} capability or constraint evidence hash is invalid`,
    );
  }
  const lineageRaw = requireArray(
    payload.authoritativeProducerBindingIds,
    `${event.id} authoritativeProducerBindingIds`,
  );
  if (
    lineageRaw.some((bindingId) => typeof bindingId !== "string" || bindingId.trim() !== bindingId || bindingId.length === 0)
    || new Set(lineageRaw).size !== lineageRaw.length
  ) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Role-assignment event ${event.id} requires unique producer binding identities`,
    );
  }
  const authoritativeProducerBindingIds = [...lineageRaw] as string[];
  authoritativeProducerBindingIds.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  if (hashRoomValue(lineageRaw) !== hashRoomValue(authoritativeProducerBindingIds)) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Role-assignment event ${event.id} producer lineage is not canonical`,
    );
  }
  const assignmentRaw = requireRecord(payload.assignment, `${event.id} assignment`);
  const assignmentResult = validateRoomRoleAssignment({
    protocol,
    assignment: assignmentRaw as unknown as RoomRoleAssignmentV1,
    capabilitySnapshot: snapshotResult.value,
    authoritativeProducerBindingIds,
  });
  if (!assignmentResult.ok) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Role-assignment event ${event.id} violates its protocol policy`,
    );
  }
  if (
    assignmentResult.value.phaseId !== phaseId
    || hashRoomValue(assignmentRaw) !== hashRoomValue(assignmentResult.value)
    || payload.assignmentHash !== hashRoomValue(assignmentResult.value)
    || hashRoomValue(assignmentResult.value.producerBindingIds)
      !== hashRoomValue(authoritativeProducerBindingIds)
  ) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Role-assignment event ${event.id} assignment evidence is inconsistent`,
    );
  }
  const updatedAt = requireIsoTimestamp(payload.updatedAt, `${event.id} updatedAt`);
  const occurredAt = requireIsoTimestamp(event.occurredAt, `${event.id} occurredAt`);
  if (
    new Date(Date.parse(updatedAt)).toISOString() !== updatedAt
    || new Date(Date.parse(occurredAt)).toISOString() !== occurredAt
    || Date.parse(occurredAt) > Date.parse(updatedAt)
  ) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Role-assignment event ${event.id} requires canonical non-retrograde timestamps`,
    );
  }
  return {
    ...aggregate,
    room: {
      ...aggregate.room,
      aggregateVersion: event.aggregateVersion,
      updatedAt,
    },
  };
}

/*
FNXC:SessionRoomDispatchReplay 2026-07-18-23:42:
Task-graph mutations and ready-to-running dispatch claims advance the same
Room aggregate as every other durable command. Their append-only events must
therefore replay the exact aggregate metadata after a checkpoint; otherwise a
crash after the atomic outbox commit would turn a valid Room into a recovery
failure.
*/
function validateTaskGraphMutation(
  aggregate: RoomAggregateV1,
  event: RoomEventRecordV1,
  payload: Readonly<Record<string, unknown>>,
): RoomAggregateV1 {
  assertExactKeys(payload, [
    "projectionVersion",
    "dagVersion",
    "idempotencyKey",
    "mutationActions",
    "commandAudit",
    "projection",
    "projectionHash",
    "mutatedAt",
  ], `${event.id} payload`);
  if (payload.projectionVersion !== 1) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Task-graph mutation event ${event.id} requires projection version 1`,
    );
  }
  const dagVersion = requireNonNegativeInteger(payload.dagVersion, `${event.id} dagVersion`);
  requireTrimmedString(payload.idempotencyKey, `${event.id} idempotencyKey`);
  const actions = requireStringArray(payload.mutationActions, `${event.id} mutationActions`);
  if (actions.length === 0) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Task-graph mutation event ${event.id} requires at least one mutation action`,
    );
  }
  requireEventRecord(payload.commandAudit, `${event.id} commandAudit`);
  const projection = requireEventRecord(payload.projection, `${event.id} projection`);
  assertExactKeys(projection, [
    "roomId",
    "aggregateVersion",
    "dagVersion",
    "nodes",
    "edges",
    "readyNodeIds",
    "criticalPathNodeIds",
  ], `${event.id} task-graph projection`);
  const projectionHash = requireTrimmedString(payload.projectionHash, `${event.id} projectionHash`);
  if (hashRoomValue(payload.projection) !== projectionHash) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Task-graph mutation event ${event.id} projection hash does not match its payload`,
    );
  }
  if (
    requireTrimmedString(projection.roomId, `${event.id} projection.roomId`) !== aggregate.room.id
    || requireNonNegativeInteger(
      projection.aggregateVersion,
      `${event.id} projection.aggregateVersion`,
    ) !== event.aggregateVersion
    || requireNonNegativeInteger(projection.dagVersion, `${event.id} projection.dagVersion`) !== dagVersion
  ) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Task-graph mutation event ${event.id} projection identity or version does not match its Room event`,
    );
  }
  requireArray(projection.nodes, `${event.id} projection.nodes`);
  requireArray(projection.edges, `${event.id} projection.edges`);
  requireStringArray(projection.readyNodeIds, `${event.id} projection.readyNodeIds`);
  requireStringArray(projection.criticalPathNodeIds, `${event.id} projection.criticalPathNodeIds`);
  return advanceRoomProjectionMetadata(
    aggregate,
    event,
    requireCanonicalUtcIsoTimestamp(payload.mutatedAt, `${event.id} mutatedAt`),
    "Task-graph mutation",
  );
}

function validateTaskDispatchClaim(
  aggregate: RoomAggregateV1,
  event: RoomEventRecordV1,
  payload: Readonly<Record<string, unknown>>,
): RoomAggregateV1 {
  const projectionVersion = requireNonNegativeInteger(
    payload.projectionVersion,
    `${event.id} projectionVersion`,
  );
  if (projectionVersion !== 1 && projectionVersion !== 2 && projectionVersion !== 3) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Task-dispatch event ${event.id} requires projection version 1, 2, or 3`,
    );
  }
  assertExactKeys(payload, [
    "projectionVersion",
    "nodeId",
    "ownerSeatId",
    "ownerBindingId",
    "runningNodeVersion",
    "dagVersion",
    "messageId",
    "targetId",
    "outboxId",
    "idempotencyKey",
    "updatedAt",
    ...(projectionVersion >= 2 ? ["projection", "projectionHash"] : []),
    ...(projectionVersion === 3 ? [
      "roleAssignmentId",
      "roleAssignmentRevision",
      "roleAssignmentPhaseId",
    ] : []),
  ], `${event.id} payload`);
  for (const field of [
    "nodeId",
    "ownerSeatId",
    "ownerBindingId",
    "messageId",
    "targetId",
    "outboxId",
    "idempotencyKey",
  ] as const) {
    requireTrimmedString(payload[field], `${event.id} ${field}`);
  }
  requirePositiveInteger(payload.runningNodeVersion, `${event.id} runningNodeVersion`);
  const dagVersion = requirePositiveInteger(payload.dagVersion, `${event.id} dagVersion`);
  if (projectionVersion >= 2) {
    const projection = requireEventRecord(payload.projection, `${event.id} task-dispatch projection`);
    assertExactKeys(projection, [
      "roomId",
      "aggregateVersion",
      "dagVersion",
      "nodes",
      "edges",
      "readyNodeIds",
      "criticalPathNodeIds",
    ], `${event.id} task-dispatch projection`);
    const projectionHash = requireTrimmedString(
      payload.projectionHash,
      `${event.id} task-dispatch projectionHash`,
    );
    if (hashRoomValue(payload.projection) !== projectionHash) {
      throw new RoomProjectionReplayError(
        "invalid_event_payload",
        `Task-dispatch event ${event.id} projection hash does not match its payload`,
      );
    }
    if (
      requireTrimmedString(projection.roomId, `${event.id} task-dispatch projection.roomId`) !== aggregate.room.id
      || requireNonNegativeInteger(
        projection.aggregateVersion,
        `${event.id} task-dispatch projection.aggregateVersion`,
      ) !== event.aggregateVersion
      || requireNonNegativeInteger(
        projection.dagVersion,
        `${event.id} task-dispatch projection.dagVersion`,
      ) !== dagVersion
    ) {
      throw new RoomProjectionReplayError(
        "invalid_event_payload",
        `Task-dispatch event ${event.id} projection identity or version does not match its Room event`,
      );
    }
    requireArray(projection.nodes, `${event.id} task-dispatch projection.nodes`);
    requireArray(projection.edges, `${event.id} task-dispatch projection.edges`);
    requireStringArray(projection.readyNodeIds, `${event.id} task-dispatch projection.readyNodeIds`);
    requireStringArray(
      projection.criticalPathNodeIds,
      `${event.id} task-dispatch projection.criticalPathNodeIds`,
    );
  }
  if (projectionVersion === 3) {
    const roleAssignmentId = payload.roleAssignmentId;
    const roleAssignmentRevision = payload.roleAssignmentRevision;
    const roleAssignmentPhaseId = payload.roleAssignmentPhaseId;
    const hasRoleAssignment = roleAssignmentId !== null
      || roleAssignmentRevision !== null
      || roleAssignmentPhaseId !== null;
    if (
      (hasRoleAssignment && (
        typeof roleAssignmentId !== "string"
        || roleAssignmentId.trim() !== roleAssignmentId
        || roleAssignmentId.length === 0
        || !Number.isSafeInteger(roleAssignmentRevision)
        || (roleAssignmentRevision as number) < 1
        || typeof roleAssignmentPhaseId !== "string"
        || roleAssignmentPhaseId.trim() !== roleAssignmentPhaseId
        || roleAssignmentPhaseId.length === 0
      ))
      || (!hasRoleAssignment && (
        roleAssignmentId !== null
        || roleAssignmentRevision !== null
        || roleAssignmentPhaseId !== null
      ))
    ) {
      throw new RoomProjectionReplayError(
        "invalid_event_payload",
        `Task-dispatch event ${event.id} has invalid role-assignment provenance`,
      );
    }
  }
  return advanceRoomProjectionMetadata(
    aggregate,
    event,
    requireCanonicalUtcIsoTimestamp(payload.updatedAt, `${event.id} updatedAt`),
    "Task-dispatch",
  );
}

function validateTaskDispatchDeliveryBlocked(
  aggregate: RoomAggregateV1,
  event: RoomEventRecordV1,
  payload: Readonly<Record<string, unknown>>,
): RoomAggregateV1 {
  const uncertain = event.eventType === "room_task_dispatch_delivery_uncertain_blocked";
  assertExactKeys(payload, [
    "projectionVersion",
    "nodeId",
    "outboxId",
    "blockedNodeVersion",
    "dagVersion",
    "errorCode",
    "projection",
    "projectionHash",
    "updatedAt",
    ...(uncertain ? ["firstUncertainAt"] : []),
  ], `${event.id} payload`);
  if (requireNonNegativeInteger(payload.projectionVersion, `${event.id} projectionVersion`) !== 1) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Task-dispatch delivery block event ${event.id} requires projection version 1`,
    );
  }
  for (const field of ["nodeId", "outboxId", "errorCode"] as const) {
    requireTrimmedString(payload[field], `${event.id} ${field}`);
  }
  if (uncertain) {
    requireCanonicalUtcIsoTimestamp(payload.firstUncertainAt, `${event.id} firstUncertainAt`);
  }
  const blockedNodeVersion = requirePositiveInteger(
    payload.blockedNodeVersion,
    `${event.id} blockedNodeVersion`,
  );
  const dagVersion = requirePositiveInteger(payload.dagVersion, `${event.id} dagVersion`);
  const projection = requireEventRecord(payload.projection, `${event.id} task-dispatch rejection projection`);
  assertExactKeys(projection, [
    "roomId",
    "aggregateVersion",
    "dagVersion",
    "nodes",
    "edges",
    "readyNodeIds",
    "criticalPathNodeIds",
  ], `${event.id} task-dispatch rejection projection`);
  const projectionHash = requireTrimmedString(
    payload.projectionHash,
    `${event.id} task-dispatch rejection projectionHash`,
  );
  if (hashRoomValue(payload.projection) !== projectionHash) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Task-dispatch delivery block event ${event.id} projection hash does not match its payload`,
    );
  }
  if (
    requireTrimmedString(projection.roomId, `${event.id} task-dispatch rejection projection.roomId`) !== aggregate.room.id
    || requireNonNegativeInteger(
      projection.aggregateVersion,
      `${event.id} task-dispatch rejection projection.aggregateVersion`,
    ) !== event.aggregateVersion
    || requireNonNegativeInteger(
      projection.dagVersion,
      `${event.id} task-dispatch rejection projection.dagVersion`,
    ) !== dagVersion
  ) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Task-dispatch delivery block event ${event.id} projection identity or version does not match its Room event`,
    );
  }
  const nodes = requireArray(projection.nodes, `${event.id} task-dispatch rejection projection.nodes`);
  requireArray(projection.edges, `${event.id} task-dispatch rejection projection.edges`);
  requireStringArray(projection.readyNodeIds, `${event.id} task-dispatch rejection projection.readyNodeIds`);
  requireStringArray(
    projection.criticalPathNodeIds,
    `${event.id} task-dispatch rejection projection.criticalPathNodeIds`,
  );
  const matchingNode = nodes.find((candidate) => {
    const node = candidate && typeof candidate === "object" && !Array.isArray(candidate)
      ? candidate as Record<string, unknown>
      : null;
    if (!node) return false;
    return node.id === payload.nodeId
      && node.state === "blocked"
      && node.nodeVersion === blockedNodeVersion;
  });
  if (!matchingNode) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Task-dispatch delivery block event ${event.id} snapshot lacks its blocked node`,
    );
  }
  return advanceRoomProjectionMetadata(
    aggregate,
    event,
    requireCanonicalUtcIsoTimestamp(payload.updatedAt, `${event.id} updatedAt`),
    "Task-dispatch delivery block",
  );
}

function advanceRoomProjectionMetadata(
  aggregate: RoomAggregateV1,
  event: RoomEventRecordV1,
  updatedAt: string,
  label: string,
): RoomAggregateV1 {
  const occurredAt = requireCanonicalUtcIsoTimestamp(event.occurredAt, `${event.id} occurredAt`);
  const previousUpdatedAt = requireCanonicalUtcIsoTimestamp(
    aggregate.room.updatedAt,
    `${event.id} prior Room updatedAt`,
  );
  if (Date.parse(occurredAt) > Date.parse(updatedAt)) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `${label} event ${event.id} cannot occur after its projection update`,
    );
  }
  if (Date.parse(updatedAt) < Date.parse(previousUpdatedAt)) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `${label} event ${event.id} cannot move Room time backwards`,
    );
  }
  return {
    ...aggregate,
    room: {
      ...aggregate.room,
      aggregateVersion: event.aggregateVersion,
      updatedAt,
    },
  };
}

function validateRoomSemanticStateUpdated(
  aggregate: RoomAggregateV1,
  event: RoomEventRecordV1,
  payload: Readonly<Record<string, unknown>>,
): RoomAggregateV1 {
  assertExactKeys(payload, [
    "projectionVersion",
    "semanticStateId",
    "revision",
    "turnId",
    "nodeId",
    "protocolId",
    "protocolVersion",
    "phaseId",
    "semanticHash",
    "evidenceStateHash",
    "decisionStateHash",
    "stateFingerprint",
    "updatedAt",
  ], `${event.id} payload`);
  requireTrimmedString(payload.semanticStateId, `${event.id} semanticStateId`);
  requirePositiveInteger(payload.revision, `${event.id} revision`);
  requireTrimmedString(payload.turnId, `${event.id} turnId`);
  requireTrimmedString(payload.nodeId, `${event.id} nodeId`);
  if (
    requireTrimmedString(payload.protocolId, `${event.id} protocolId`) !== aggregate.room.protocolId
    || requirePositiveInteger(payload.protocolVersion, `${event.id} protocolVersion`) !== aggregate.room.protocolVersion
  ) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Semantic state event ${event.id} protocol does not match the Room aggregate`,
    );
  }
  for (const field of [
    "phaseId",
    "semanticHash",
    "evidenceStateHash",
    "decisionStateHash",
    "stateFingerprint",
  ] as const) {
    requireTrimmedString(payload[field], `${event.id} ${field}`);
  }
  return advanceSemanticReplayAggregate(aggregate, event, payload, "semantic state");
}

/**
 * Returns the complete immutable route snapshot carried by a v2 route event.
 * Consumers rebuilding derived tables must start from this event evidence, not
 * from whichever mutable outbox or inbox rows survived a crash.
 */
export function extractRoomSemanticRouteEventSnapshot(
  event: RoomEventRecordV1,
): RoomSemanticRouteEventSnapshotV1 {
  if (event.eventType !== "room_protocol_message_routed") {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Event ${event.id} is not a semantic route event`,
    );
  }
  const payload = requireEventRecord(event.payload, `${event.id} payload`);
  return parseRoomSemanticRouteEventSnapshot(event, payload);
}

/**
 * Returns the immutable action transition carried by a controller-inbox event.
 * The event's exact payload shape is deliberately separate from the mutable
 * inbox row so replay never needs to infer a claim or acknowledgement.
 */
export function extractRoomSemanticControllerActionEventSnapshot(
  event: RoomEventRecordV1,
): RoomSemanticControllerActionEventSnapshotV1 {
  if (
    event.eventType !== "room_semantic_controller_action_claimed"
    && event.eventType !== "room_semantic_controller_action_completed"
  ) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Event ${event.id} is not a semantic controller inbox action event`,
    );
  }
  return parseRoomSemanticControllerActionEventSnapshot(
    event,
    requireEventRecord(event.payload, `${event.id} payload`),
  );
}

/*
FNXC:SessionRoomSemanticInbox 2026-07-19-05:45:
Semantic controller inbox rows are mutable operational state. Route snapshots
seed each action, while claim/retry/completion snapshots are the sole immutable
history used to rebuild after a crash. Replay must reject missing, duplicated,
or causally illegal action transitions rather than silently inventing progress.
*/
export function rebuildRoomSemanticControllerInboxProjectionFromEvents(
  events: readonly RoomEventRecordV1[],
): readonly RoomSemanticControllerActionV1[] {
  // Validate the complete Room stream first, including identity, cursor, and
  // aggregate-version integrity, before materializing its derived inbox view.
  rebuildRoomProjectionFromEvents(events);

  const actions = new Map<string, RoomSemanticControllerActionV1>();
  for (const event of events) {
    if (event.eventType === "room_protocol_message_routed") {
      const snapshot = extractRoomSemanticRouteEventSnapshot(event);
      if (snapshot.controllerAction !== null) {
        seedRoomSemanticControllerAction(actions, event, snapshot.controllerAction);
      }
      continue;
    }
    if (
      event.eventType === "room_semantic_controller_action_claimed"
      || event.eventType === "room_semantic_controller_action_completed"
    ) {
      applyRoomSemanticControllerActionTransition(
        actions,
        event,
        extractRoomSemanticControllerActionEventSnapshot(event),
      );
    }
  }

  return [...actions.values()]
    .sort((left, right) => {
      if (left.createdAt !== right.createdAt) {
        return left.createdAt < right.createdAt ? -1 : 1;
      }
      if (left.id === right.id) return 0;
      return left.id < right.id ? -1 : 1;
    })
    .map((action) => structuredClone(action));
}

export interface ReplayedRoomTaskProgressRecoveryProjectionV1 {
  readonly observations: readonly RoomTaskProgressObservationV1[];
  readonly actions: readonly RoomTaskRecoveryActionV1[];
  readonly plans: readonly RoomTaskRecoveryPlanV1[];
}

interface ParsedRoomTaskProgressObservationEventV1 {
  readonly snapshot: RoomTaskProgressObservationEventSnapshotV1;
  readonly taskGraphProjection: RoomTaskGraphProjectionV1 | null;
}

/*
FNXC:SessionRoomTaskProgressRecovery 2026-07-19-08:35:
No-progress recovery is an event-sourced safety ladder, not a best-effort worker
queue. Observation events establish immutable evidence, enqueue events seed one
pristine action, and claim/retry/completion events must be replayable with the
same claim-token and attempt lineage after a crash or worker takeover.
*/
export function rebuildRoomTaskProgressRecoveryProjectionFromEvents(
  events: readonly RoomEventRecordV1[],
): ReplayedRoomTaskProgressRecoveryProjectionV1 {
  // The Room aggregate validator owns cursor, identity, and aggregate-version
  // integrity. The derived projection below adds the stricter per-observation
  // and per-action lineage which does not live on RoomAggregateV1 itself.
  rebuildRoomProjectionFromEvents(events);

  const observations = new Map<string, RoomTaskProgressObservationV1>();
  const observationRounds = new Set<string>();
  const latestObservationAt = new Map<string, string>();
  const actions = new Map<string, RoomTaskRecoveryActionV1>();
  const claimedTokensByAction = new Map<string, Set<string>>();
  const plans = new Map<string, RoomTaskRecoveryPlanV1>();

  for (const event of events) {
    if (
      event.eventType === "room_task_progress_observed"
      || event.eventType === "room_task_recovery_action_enqueued"
      || event.eventType === "room_task_recovery_ladder_exhausted"
    ) {
      const parsed = parseRoomTaskProgressObservationEvent(
        event,
        requireEventRecord(event.payload, `${event.id} payload`),
      );
      seedRoomTaskProgressObservation(
        observations,
        observationRounds,
        latestObservationAt,
        actions,
        event,
        parsed.snapshot,
      );
      continue;
    }
    if (
      event.eventType === "room_task_recovery_action_claimed"
      || event.eventType === "room_task_recovery_action_completed"
    ) {
      applyRoomTaskRecoveryActionTransition(
        actions,
        claimedTokensByAction,
        event,
        extractRoomTaskRecoveryActionEventSnapshot(event),
      );
      continue;
    }
    if (event.eventType === "room_task_recovery_plan_recorded") {
      const plan = extractRoomTaskRecoveryPlanEventSnapshot(event).plan;
      const action = actions.get(plan.recoveryActionId);
      if (
        !action
        || action.state !== "claimed"
        || action.roomId !== plan.roomId
        || hashRoomValue(action.actionSnapshot) !== plan.actionSnapshotHash
        || hashRoomValue(action.actionSnapshot) !== hashRoomValue(plan.actionSnapshot)
        || action.actionSnapshot.executionMode !== plan.executionMode
      ) {
        throw new RoomProjectionReplayError(
          "invalid_event_payload",
          `Recovery-plan event ${event.id} does not bind the current claimed action lineage`,
        );
      }
      if (plans.has(plan.recoveryActionId)) {
        throw new RoomProjectionReplayError(
          "invalid_event_payload",
          `Recovery-plan event ${event.id} duplicates action ${plan.recoveryActionId}`,
        );
      }
      plans.set(plan.recoveryActionId, plan);
    }
  }

  return {
    observations: [...observations.values()]
      .sort(compareRoomTaskProgressObservations)
      .map((observation) => structuredClone(observation)),
    actions: [...actions.values()]
      .sort(compareRoomTaskRecoveryActions)
      .map((action) => structuredClone(action)),
    plans: [...plans.values()]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      .map((plan) => structuredClone(plan)),
  };
}

/** Returns the immutable observation/decision snapshot carried by a recovery event. */
export function extractRoomTaskProgressObservationEventSnapshot(
  event: RoomEventRecordV1,
): RoomTaskProgressObservationEventSnapshotV1 {
  return parseRoomTaskProgressObservationEvent(
    event,
    requireEventRecord(event.payload, `${event.id} payload`),
  ).snapshot;
}

/**
 * Returns the only task-graph snapshot produced by a no-progress exhaustion.
 * `rebuildRoomTaskGraphProjectionFromEvents` can consume this helper without
 * re-parsing a mutable Store row or treating an un-hashed graph as evidence.
 */
export function extractRoomTaskRecoveryExhaustionTaskGraphProjection(
  event: RoomEventRecordV1,
): RoomTaskGraphProjectionV1 {
  const parsed = parseRoomTaskProgressObservationEvent(
    event,
    requireEventRecord(event.payload, `${event.id} payload`),
  );
  if (event.eventType !== "room_task_recovery_ladder_exhausted" || !parsed.taskGraphProjection) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Event ${event.id} is not a no-progress exhaustion task-graph snapshot`,
    );
  }
  return structuredClone(parsed.taskGraphProjection);
}

/** Returns the immutable state transition carried by a task-recovery action event. */
export function extractRoomTaskRecoveryActionEventSnapshot(
  event: RoomEventRecordV1,
): RoomTaskRecoveryActionEventSnapshotV1 {
  if (
    event.eventType !== "room_task_recovery_action_claimed"
    && event.eventType !== "room_task_recovery_action_completed"
  ) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Event ${event.id} is not a task-recovery action event`,
    );
  }
  return parseRoomTaskRecoveryActionEventSnapshot(
    event,
    requireEventRecord(event.payload, `${event.id} payload`),
  );
}

/** Returns the immutable provider-free handoff carried by a recovery-plan event. */
export function extractRoomTaskRecoveryPlanEventSnapshot(
  event: RoomEventRecordV1,
): RoomTaskRecoveryPlanEventSnapshotV1 {
  if (event.eventType !== "room_task_recovery_plan_recorded") {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Event ${event.id} is not a task-recovery plan event`,
    );
  }
  return parseRoomTaskRecoveryPlanEventSnapshot(
    event,
    requireEventRecord(event.payload, `${event.id} payload`),
  );
}

function validateRoomTaskProgressObservationEvent(
  aggregate: RoomAggregateV1,
  event: RoomEventRecordV1,
  payload: Readonly<Record<string, unknown>>,
): RoomAggregateV1 {
  parseRoomTaskProgressObservationEvent(event, payload);
  return advanceSemanticReplayAggregate(aggregate, event, payload, "task-progress recovery");
}

function validateRoomTaskRecoveryActionEvent(
  aggregate: RoomAggregateV1,
  event: RoomEventRecordV1,
  payload: Readonly<Record<string, unknown>>,
): RoomAggregateV1 {
  parseRoomTaskRecoveryActionEventSnapshot(event, payload);
  return advanceSemanticReplayAggregate(aggregate, event, payload, "task-recovery action");
}

function validateRoomTaskRecoveryPlanEvent(
  aggregate: RoomAggregateV1,
  event: RoomEventRecordV1,
  payload: Readonly<Record<string, unknown>>,
): RoomAggregateV1 {
  parseRoomTaskRecoveryPlanEventSnapshot(event, payload);
  return advanceSemanticReplayAggregate(aggregate, event, payload, "task-recovery plan");
}

function parseRoomTaskProgressObservationEvent(
  event: RoomEventRecordV1,
  payload: Readonly<Record<string, unknown>>,
): ParsedRoomTaskProgressObservationEventV1 {
  const exhausted = event.eventType === "room_task_recovery_ladder_exhausted";
  if (
    event.eventType !== "room_task_progress_observed"
    && event.eventType !== "room_task_recovery_action_enqueued"
    && !exhausted
  ) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Event ${event.id} is not a task-progress recovery event`,
    );
  }
  assertExactKeys(payload, exhausted
    ? [
      "projectionVersion",
      "snapshot",
      "taskGraphProjection",
      "taskGraphProjectionHash",
      "updatedAt",
    ]
    : ["projectionVersion", "snapshot", "updatedAt"], `${event.id} payload`);
  if (requireNonNegativeInteger(payload.projectionVersion, `${event.id} projectionVersion`) !== 1) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Task-progress event ${event.id} requires projection version 1`,
    );
  }
  const updatedAt = requireCanonicalUtcIsoTimestamp(payload.updatedAt, `${event.id} updatedAt`);
  if (event.occurredAt !== updatedAt) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Task-progress event ${event.id} must occur at its immutable update time`,
    );
  }
  const snapshot = requireEventRecord(payload.snapshot, `${event.id} snapshot`);
  assertExactKeys(snapshot, ["contractVersion", "observation", "decision"], `${event.id} snapshot`);
  if (snapshot.contractVersion !== "room-task-progress-observation-snapshot/v1") {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Task-progress event ${event.id} has an unsupported observation snapshot contract`,
    );
  }
  const observation = parseRoomTaskProgressObservation(
    snapshot.observation,
    `${event.id} snapshot.observation`,
  );
  const decision = parseRoomTaskNoProgressRecoveryDecision(
    snapshot.decision,
    observation,
    `${event.id} snapshot.decision`,
  );
  const expectedEventType = roomTaskProgressRecoveryEventType(decision);
  if (
    event.eventType !== expectedEventType
    || observation.roomId !== event.roomId
    || observation.observedAt !== updatedAt
  ) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Task-progress event ${event.id} does not bind its observation and decision`,
    );
  }
  const taskGraphProjection = exhausted
    ? parseRoomTaskRecoveryExhaustionTaskGraphProjection(event, payload)
    : null;
  return {
    snapshot: {
      contractVersion: "room-task-progress-observation-snapshot/v1",
      observation,
      decision,
    },
    taskGraphProjection,
  };
}

function parseRoomTaskRecoveryExhaustionTaskGraphProjection(
  event: RoomEventRecordV1,
  payload: Readonly<Record<string, unknown>>,
): RoomTaskGraphProjectionV1 {
  const projection = requireEventRecord(
    payload.taskGraphProjection,
    `${event.id} taskGraphProjection`,
  );
  assertExactKeys(projection, [
    "roomId",
    "aggregateVersion",
    "dagVersion",
    "nodes",
    "edges",
    "readyNodeIds",
    "criticalPathNodeIds",
  ], `${event.id} taskGraphProjection`);
  const projectionHash = requireCanonicalRoomHash(
    payload.taskGraphProjectionHash,
    `${event.id} taskGraphProjectionHash`,
  );
  if (hashRoomValue(projection) !== projectionHash) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Task-progress exhaustion ${event.id} task-graph hash does not match its snapshot`,
    );
  }
  if (
    requireTrimmedString(projection.roomId, `${event.id} taskGraphProjection.roomId`) !== event.roomId
    || requireNonNegativeInteger(
      projection.aggregateVersion,
      `${event.id} taskGraphProjection.aggregateVersion`,
    ) !== event.aggregateVersion
  ) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Task-progress exhaustion ${event.id} task graph does not bind its Room aggregate`,
    );
  }
  requireNonNegativeInteger(projection.dagVersion, `${event.id} taskGraphProjection.dagVersion`);
  requireEventArray(projection.nodes, `${event.id} taskGraphProjection.nodes`);
  requireEventArray(projection.edges, `${event.id} taskGraphProjection.edges`);
  requireUniqueStringArray(projection.readyNodeIds, `${event.id} taskGraphProjection.readyNodeIds`);
  requireUniqueStringArray(
    projection.criticalPathNodeIds,
    `${event.id} taskGraphProjection.criticalPathNodeIds`,
  );
  return structuredClone(projection) as unknown as RoomTaskGraphProjectionV1;
}

function parseRoomTaskNoProgressRecoveryDecision(
  value: unknown,
  observation: RoomTaskProgressObservationV1,
  label: string,
): RoomTaskNoProgressRecoveryDecisionV1 {
  const decision = requireEventRecord(value, label);
  const consecutiveUnchangedRounds = requirePositiveInteger(
    decision.consecutiveUnchangedRounds,
    `${label}.consecutiveUnchangedRounds`,
  );
  if (decision.kind === "below_threshold" || decision.kind === "no_declared_action") {
    assertExactKeys(decision, ["kind", "consecutiveUnchangedRounds"], label);
    return { kind: decision.kind, consecutiveUnchangedRounds };
  }
  if (decision.kind === "awaiting_active_action") {
    assertExactKeys(decision, ["kind", "consecutiveUnchangedRounds", "activeActionId"], label);
    return {
      kind: "awaiting_active_action",
      consecutiveUnchangedRounds,
      activeActionId: requireTrimmedString(decision.activeActionId, `${label}.activeActionId`),
    };
  }
  if (decision.kind === "action_enqueued") {
    assertExactKeys(decision, ["kind", "consecutiveUnchangedRounds", "action"], label);
    const action = parseRoomTaskRecoveryAction(decision.action, `${label}.action`);
    if (
      action.state !== "pending"
      || action.attemptCount !== 0
      || action.observationId !== observation.id
      || action.roomId !== observation.roomId
      || action.nodeId !== observation.nodeId
      || action.nodeVersion !== observation.nodeVersion
      || action.actionSnapshot.turnId !== observation.turnId
      || action.actionSnapshot.phaseId !== observation.phaseId
      || action.createdAt !== observation.observedAt
      || action.updatedAt !== observation.observedAt
      || action.nextEligibleAt !== observation.observedAt
    ) {
      throw new RoomProjectionReplayError(
        "invalid_event_payload",
        `${label}.action does not seed a pristine action for its triggering observation`,
      );
    }
    return { kind: "action_enqueued", consecutiveUnchangedRounds, action };
  }
  if (decision.kind === "exhausted") {
    assertExactKeys(decision, ["kind", "consecutiveUnchangedRounds", "exhaustedGateIds"], label);
    const exhaustedGateIds = requireUniqueStringArray(
      decision.exhaustedGateIds,
      `${label}.exhaustedGateIds`,
    );
    if (exhaustedGateIds.length === 0) {
      throw new RoomProjectionReplayError(
        "invalid_event_payload",
        `${label}.exhaustedGateIds cannot be empty`,
      );
    }
    return { kind: "exhausted", consecutiveUnchangedRounds, exhaustedGateIds };
  }
  throw new RoomProjectionReplayError(
    "invalid_event_payload",
    `${label}.kind is not a supported task-progress recovery decision`,
  );
}

function parseRoomTaskProgressObservation(
  value: unknown,
  label: string,
): RoomTaskProgressObservationV1 {
  const observation = requireEventRecord(value, label);
  assertExactKeys(observation, [
    "id",
    "roomId",
    "nodeId",
    "nodeVersion",
    "turnId",
    "phaseId",
    "roundId",
    "idempotencyKey",
    "progressSignature",
    "semanticHash",
    "evidenceHash",
    "artifactHash",
    "testHash",
    "resolvedDissentHash",
    "origin",
    "observedAt",
    "createdAt",
  ], label);
  for (const field of ["id", "roomId", "nodeId", "turnId", "phaseId", "roundId", "idempotencyKey"] as const) {
    requireTrimmedString(observation[field], `${label}.${field}`);
  }
  const nodeVersion = requireNonNegativeInteger(observation.nodeVersion, `${label}.nodeVersion`);
  for (const field of [
    "progressSignature",
    "semanticHash",
    "evidenceHash",
    "artifactHash",
    "testHash",
    "resolvedDissentHash",
  ] as const) {
    requireCanonicalRoomHash(observation[field], `${label}.${field}`);
  }
  const origin = requireEventRecord(observation.origin, `${label}.origin`);
  assertExactKeys(origin, ["contractVersion", "sourceKind", "sourceRef"], `${label}.origin`);
  if (
    origin.contractVersion !== "room-task-progress-observation-origin/v1"
    || (origin.sourceKind !== "controller"
      && origin.sourceKind !== "connector"
      && origin.sourceKind !== "recovery_worker"
      && origin.sourceKind !== "operator")
  ) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `${label}.origin has an unsupported contract or source kind`,
    );
  }
  requireTrimmedString(origin.sourceRef, `${label}.origin.sourceRef`);
  const observedAt = requireCanonicalUtcIsoTimestamp(observation.observedAt, `${label}.observedAt`);
  const createdAt = requireCanonicalUtcIsoTimestamp(observation.createdAt, `${label}.createdAt`);
  if (createdAt !== observedAt) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `${label}.createdAt must equal its immutable observedAt`,
    );
  }
  return structuredClone({
    ...observation,
    nodeVersion,
    origin: {
      contractVersion: "room-task-progress-observation-origin/v1",
      sourceKind: origin.sourceKind,
      sourceRef: origin.sourceRef,
    },
    observedAt,
    createdAt,
  }) as unknown as RoomTaskProgressObservationV1;
}

function parseRoomTaskRecoveryActionEventSnapshot(
  event: RoomEventRecordV1,
  payload: Readonly<Record<string, unknown>>,
): RoomTaskRecoveryActionEventSnapshotV1 {
  assertExactKeys(payload, ["projectionVersion", "actionId", "snapshot", "updatedAt"], `${event.id} payload`);
  if (requireNonNegativeInteger(payload.projectionVersion, `${event.id} projectionVersion`) !== 1) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Task-recovery action event ${event.id} requires projection version 1`,
    );
  }
  const actionId = requireTrimmedString(payload.actionId, `${event.id} actionId`);
  const updatedAt = requireCanonicalUtcIsoTimestamp(payload.updatedAt, `${event.id} updatedAt`);
  if (event.occurredAt !== updatedAt) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Task-recovery action event ${event.id} must occur at its action update time`,
    );
  }
  const snapshot = requireEventRecord(payload.snapshot, `${event.id} snapshot`);
  assertExactKeys(snapshot, ["contractVersion", "transition", "previousState", "action"], `${event.id} snapshot`);
  if (snapshot.contractVersion !== "room-task-recovery-action-snapshot/v1") {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Task-recovery action event ${event.id} has an unsupported snapshot contract`,
    );
  }
  if (snapshot.previousState !== "pending" && snapshot.previousState !== "claimed") {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Task-recovery action event ${event.id} has an unsupported previous state`,
    );
  }
  if (
    snapshot.transition !== "claimed"
    && snapshot.transition !== "processed"
    && snapshot.transition !== "retry"
  ) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Task-recovery action event ${event.id} has an unsupported transition`,
    );
  }
  const action = parseRoomTaskRecoveryAction(snapshot.action, `${event.id} snapshot.action`);
  if (action.id !== actionId || action.roomId !== event.roomId || action.updatedAt !== updatedAt) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Task-recovery action event ${event.id} does not bind its action snapshot`,
    );
  }
  if (event.eventType === "room_task_recovery_action_claimed") {
    if (snapshot.transition !== "claimed" || action.state !== "claimed") {
      throw new RoomProjectionReplayError(
        "invalid_event_payload",
        `Task-recovery action claim ${event.id} must end in claimed state`,
      );
    }
  } else if (
    snapshot.previousState !== "claimed"
    || (snapshot.transition !== "processed" && snapshot.transition !== "retry")
    || (snapshot.transition === "processed" && action.state !== "processed")
    || (snapshot.transition === "retry" && action.state !== "pending")
  ) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Task-recovery action completion ${event.id} has an illegal transition`,
    );
  }
  return structuredClone(snapshot) as unknown as RoomTaskRecoveryActionEventSnapshotV1;
}

function parseRoomTaskRecoveryPlanEventSnapshot(
  event: RoomEventRecordV1,
  payload: Readonly<Record<string, unknown>>,
): RoomTaskRecoveryPlanEventSnapshotV1 {
  assertExactKeys(
    payload,
    ["projectionVersion", "recoveryActionId", "snapshot", "recordedAt", "updatedAt"],
    `${event.id} payload`,
  );
  if (requireNonNegativeInteger(payload.projectionVersion, `${event.id} projectionVersion`) !== 1) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Recovery-plan event ${event.id} requires projection version 1`,
    );
  }
  const recoveryActionId = requireTrimmedString(payload.recoveryActionId, `${event.id} recoveryActionId`);
  const recordedAt = requireCanonicalUtcIsoTimestamp(payload.recordedAt, `${event.id} recordedAt`);
  const updatedAt = requireCanonicalUtcIsoTimestamp(payload.updatedAt, `${event.id} updatedAt`);
  if (event.occurredAt !== recordedAt || event.occurredAt !== updatedAt || event.causationId === null) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Recovery-plan event ${event.id} must retain a causal observation at its record time`,
    );
  }
  const snapshot = requireEventRecord(payload.snapshot, `${event.id} snapshot`);
  assertExactKeys(snapshot, ["contractVersion", "plan"], `${event.id} snapshot`);
  if (snapshot.contractVersion !== "room-task-recovery-plan-snapshot/v1") {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Recovery-plan event ${event.id} has an unsupported snapshot contract`,
    );
  }
  const plan = parseRoomTaskRecoveryPlan(snapshot.plan, `${event.id} snapshot.plan`);
  if (
    plan.roomId !== event.roomId
    || plan.recoveryActionId !== recoveryActionId
    || plan.createdAt !== recordedAt
  ) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Recovery-plan event ${event.id} does not bind its plan snapshot`,
    );
  }
  return {
    contractVersion: "room-task-recovery-plan-snapshot/v1",
    plan,
  };
}

function parseRoomTaskRecoveryPlan(
  value: unknown,
  label: string,
): RoomTaskRecoveryPlanV1 {
  const plan = requireEventRecord(value, label);
  assertExactKeys(plan, [
    "contractVersion",
    "id",
    "roomId",
    "recoveryActionId",
    "executionMode",
    "actionSnapshot",
    "actionSnapshotHash",
    "resultReceipt",
    "createdAt",
  ], label);
  if (plan.contractVersion !== "room-task-recovery-plan/v1") {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `${label} has an unsupported recovery-plan contract`,
    );
  }
  const id = requireTrimmedString(plan.id, `${label}.id`);
  const roomId = requireTrimmedString(plan.roomId, `${label}.roomId`);
  const recoveryActionId = requireTrimmedString(plan.recoveryActionId, `${label}.recoveryActionId`);
  if (plan.executionMode !== "controller_plan" && plan.executionMode !== "operator_approval") {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `${label}.executionMode is unsupported`,
    );
  }
  const actionSnapshot = parseRoomTaskNoProgressRecoveryActionSnapshot(
    plan.actionSnapshot,
    `${label}.actionSnapshot`,
  );
  const actionSnapshotHash = requireCanonicalRoomHash(plan.actionSnapshotHash, `${label}.actionSnapshotHash`);
  const resultReceipt = parseRoomTaskRecoveryActionResult(plan.resultReceipt, `${label}.resultReceipt`);
  const createdAt = requireCanonicalUtcIsoTimestamp(plan.createdAt, `${label}.createdAt`);
  const expectedKind = plan.executionMode === "controller_plan"
    ? "controller_plan_submitted"
    : "operator_approval_requested";
  if (
    actionSnapshot.executionMode !== plan.executionMode
    || actionSnapshotHash !== hashRoomValue(actionSnapshot)
    || resultReceipt.kind !== expectedKind
    || resultReceipt.receiptRef !== id
    || id !== `room-task-recovery-plan:${recoveryActionId}`
  ) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `${label} does not retain its exact recovery-action lineage or receipt`,
    );
  }
  return {
    contractVersion: "room-task-recovery-plan/v1",
    id,
    roomId,
    recoveryActionId,
    executionMode: plan.executionMode,
    actionSnapshot,
    actionSnapshotHash,
    resultReceipt,
    createdAt,
  };
}

function seedRoomTaskProgressObservation(
  observations: Map<string, RoomTaskProgressObservationV1>,
  observationRounds: Set<string>,
  latestObservationAt: Map<string, string>,
  actions: Map<string, RoomTaskRecoveryActionV1>,
  event: RoomEventRecordV1,
  snapshot: RoomTaskProgressObservationEventSnapshotV1,
): void {
  const observation = snapshot.observation;
  const roundKey = roomTaskProgressObservationRoundKey(observation);
  const scopeKey = roomTaskProgressObservationScopeKey(observation);
  if (observations.has(observation.id) || observationRounds.has(roundKey)) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Task-progress event ${event.id} duplicates observation ${observation.id} or its round`,
    );
  }
  const previousObservedAt = latestObservationAt.get(scopeKey);
  if (
    previousObservedAt !== undefined
    && Date.parse(observation.observedAt) <= Date.parse(previousObservedAt)
  ) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Task-progress event ${event.id} does not advance its observation timeline`,
    );
  }
  if (snapshot.decision.kind === "action_enqueued") {
    seedRoomTaskRecoveryAction(actions, event, snapshot.decision.action);
  } else if (snapshot.decision.kind === "awaiting_active_action") {
    const active = actions.get(snapshot.decision.activeActionId);
    if (
      !active
      || active.state === "processed"
      || active.roomId !== observation.roomId
      || active.nodeId !== observation.nodeId
      || active.nodeVersion !== observation.nodeVersion
      || active.actionSnapshot.turnId !== observation.turnId
      || active.actionSnapshot.phaseId !== observation.phaseId
    ) {
      throw new RoomProjectionReplayError(
        "invalid_event_payload",
        `Task-progress event ${event.id} awaits an action that is not active in its exact scope`,
      );
    }
  } else if (snapshot.decision.kind === "exhausted") {
    for (const action of actions.values()) {
      const trigger = observations.get(action.observationId);
      if (
        action.state !== "processed"
        && trigger !== undefined
        && action.roomId === observation.roomId
        && action.nodeId === observation.nodeId
        && action.nodeVersion === observation.nodeVersion
        && action.actionSnapshot.turnId === observation.turnId
        && action.actionSnapshot.phaseId === observation.phaseId
        && sameRoomTaskProgressVector(trigger, observation)
      ) {
        throw new RoomProjectionReplayError(
          "invalid_event_payload",
          `Task-progress exhaustion ${event.id} leaves active recovery action ${action.id}`,
        );
      }
    }
  }
  observations.set(observation.id, structuredClone(observation));
  observationRounds.add(roundKey);
  latestObservationAt.set(scopeKey, observation.observedAt);
}

function seedRoomTaskRecoveryAction(
  actions: Map<string, RoomTaskRecoveryActionV1>,
  event: RoomEventRecordV1,
  action: RoomTaskRecoveryActionV1,
): void {
  if (actions.has(action.id)) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Task-progress event ${event.id} duplicates recovery action ${action.id}`,
    );
  }
  if (
    action.state !== "pending"
    || action.attemptCount !== 0
    || action.claimToken !== null
    || action.claimExpiresAt !== null
    || action.claimedByWorkerId !== null
    || action.claimedAt !== null
    || action.resultPayload !== null
    || action.lastErrorCode !== null
    || action.operatorApprovalId !== null
    || action.processedAt !== null
    || action.createdAt !== action.updatedAt
  ) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Task-progress event ${event.id} must seed one pristine pending recovery action`,
    );
  }
  actions.set(action.id, structuredClone(action));
}

function applyRoomTaskRecoveryActionTransition(
  actions: Map<string, RoomTaskRecoveryActionV1>,
  claimedTokensByAction: Map<string, Set<string>>,
  event: RoomEventRecordV1,
  snapshot: RoomTaskRecoveryActionEventSnapshotV1,
): void {
  const previous = actions.get(snapshot.action.id);
  if (!previous) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Task-recovery action event ${event.id} references an unseeded action ${snapshot.action.id}`,
    );
  }
  if (snapshot.previousState !== previous.state) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Task-recovery action event ${event.id} requires previous state ${snapshot.previousState}; replay is ${previous.state}`,
    );
  }
  assertRoomTaskRecoveryActionIdentity(previous, snapshot.action, event.id);
  if (Date.parse(snapshot.action.updatedAt) < Date.parse(previous.updatedAt)) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Task-recovery action event ${event.id} moves action time backwards`,
    );
  }
  if (snapshot.transition === "claimed") {
    const claimToken = snapshot.action.claimToken;
    if (
      snapshot.action.state !== "claimed"
      || claimToken === null
      || snapshot.action.attemptCount !== previous.attemptCount + 1
      || snapshot.action.claimedAt !== snapshot.action.updatedAt
      || snapshot.action.nextEligibleAt !== previous.nextEligibleAt
      || snapshot.action.operatorApprovalId !== previous.operatorApprovalId
      || (previous.state === "claimed" && (
        previous.claimExpiresAt === null
        || Date.parse(previous.claimExpiresAt) > Date.parse(snapshot.action.updatedAt)
        || previous.claimToken === snapshot.action.claimToken
      ))
    ) {
      throw new RoomProjectionReplayError(
        "invalid_event_payload",
        `Task-recovery action claim ${event.id} is not a legal next claim`,
      );
    }
    const claimedTokens = claimedTokensByAction.get(snapshot.action.id) ?? new Set<string>();
    if (claimedTokens.has(claimToken)) {
      throw new RoomProjectionReplayError(
        "invalid_event_payload",
        `Task-recovery action claim ${event.id} reuses a prior immutable claim token`,
      );
    }
    claimedTokens.add(claimToken);
    claimedTokensByAction.set(snapshot.action.id, claimedTokens);
  } else if (
    previous.state !== "claimed"
    || snapshot.previousState !== "claimed"
    || snapshot.action.attemptCount !== previous.attemptCount
    || snapshot.action.operatorApprovalId !== previous.operatorApprovalId
    || (snapshot.transition === "processed" && (
      snapshot.action.state !== "processed"
      || snapshot.action.resultPayload === null
      || snapshot.action.nextEligibleAt !== previous.nextEligibleAt
    ))
    || (snapshot.transition === "retry" && (
      snapshot.action.state !== "pending"
      || snapshot.action.lastErrorCode === null
      || Date.parse(snapshot.action.nextEligibleAt) <= Date.parse(snapshot.action.updatedAt)
    ))
  ) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Task-recovery action completion ${event.id} requires its exact claimed action`,
    );
  }
  actions.set(snapshot.action.id, structuredClone(snapshot.action));
}

function assertRoomTaskRecoveryActionIdentity(
  previous: RoomTaskRecoveryActionV1,
  next: RoomTaskRecoveryActionV1,
  eventId: string,
): void {
  const immutable = (action: RoomTaskRecoveryActionV1) => ({
    id: action.id,
    roomId: action.roomId,
    nodeId: action.nodeId,
    nodeVersion: action.nodeVersion,
    observationId: action.observationId,
    actionId: action.actionId,
    actionSnapshot: action.actionSnapshot,
    policySnapshot: action.policySnapshot,
    createdAt: action.createdAt,
  });
  if (hashRoomValue(immutable(previous)) !== hashRoomValue(immutable(next))) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Task-recovery action event ${eventId} changes immutable action evidence`,
    );
  }
}

function parseRoomTaskRecoveryAction(value: unknown, label: string): RoomTaskRecoveryActionV1 {
  const action = requireEventRecord(value, label);
  assertExactKeys(action, [
    "id",
    "roomId",
    "nodeId",
    "nodeVersion",
    "observationId",
    "actionId",
    "actionSnapshot",
    "policySnapshot",
    "state",
    "attemptCount",
    "claimToken",
    "claimExpiresAt",
    "claimedByWorkerId",
    "claimedAt",
    "nextEligibleAt",
    "resultPayload",
    "lastErrorCode",
    "operatorApprovalId",
    "createdAt",
    "updatedAt",
    "processedAt",
  ], label);
  for (const field of ["id", "roomId", "nodeId", "observationId", "actionId"] as const) {
    requireTrimmedString(action[field], `${label}.${field}`);
  }
  const actionSnapshot = parseRoomTaskNoProgressRecoveryActionSnapshot(
    action.actionSnapshot,
    `${label}.actionSnapshot`,
  );
  const policySnapshot = parseRoomTaskNoProgressRecoveryPolicySnapshot(
    action.policySnapshot,
    `${label}.policySnapshot`,
  );
  const nodeVersion = requireNonNegativeInteger(action.nodeVersion, `${label}.nodeVersion`);
  const attemptCount = requireNonNegativeInteger(action.attemptCount, `${label}.attemptCount`);
  const claimToken = requireNullableTrimmedString(action.claimToken, `${label}.claimToken`);
  const claimExpiresAt = action.claimExpiresAt === null
    ? null
    : requireCanonicalUtcIsoTimestamp(action.claimExpiresAt, `${label}.claimExpiresAt`);
  const claimedByWorkerId = requireNullableTrimmedString(
    action.claimedByWorkerId,
    `${label}.claimedByWorkerId`,
  );
  const claimedAt = action.claimedAt === null
    ? null
    : requireCanonicalUtcIsoTimestamp(action.claimedAt, `${label}.claimedAt`);
  const nextEligibleAt = requireCanonicalUtcIsoTimestamp(action.nextEligibleAt, `${label}.nextEligibleAt`);
  const resultPayload = action.resultPayload === null
    ? null
    : parseRoomTaskRecoveryActionResult(action.resultPayload, `${label}.resultPayload`);
  const lastErrorCode = requireNullableTaskRecoveryErrorCode(action.lastErrorCode, `${label}.lastErrorCode`);
  const operatorApprovalId = requireNullableTrimmedString(
    action.operatorApprovalId,
    `${label}.operatorApprovalId`,
  );
  const createdAt = requireCanonicalUtcIsoTimestamp(action.createdAt, `${label}.createdAt`);
  const updatedAt = requireCanonicalUtcIsoTimestamp(action.updatedAt, `${label}.updatedAt`);
  const processedAt = action.processedAt === null
    ? null
    : requireCanonicalUtcIsoTimestamp(action.processedAt, `${label}.processedAt`);
  if (
    Date.parse(updatedAt) < Date.parse(createdAt)
    || actionSnapshot.nodeId !== action.nodeId
    || actionSnapshot.nodeVersion !== nodeVersion
    || actionSnapshot.observationId !== action.observationId
    || actionSnapshot.recoveryAction.id !== action.actionId
    || policySnapshot.protocolId !== actionSnapshot.protocolId
    || policySnapshot.protocolVersion !== actionSnapshot.protocolVersion
  ) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `${label} has inconsistent recovery-action identity or policy lineage`,
    );
  }
  const matchingPolicyAction = policySnapshot.actions.find(
    (candidate) => candidate.recoveryActionId === actionSnapshot.recoveryAction.id,
  );
  if (
    !matchingPolicyAction
    || matchingPolicyAction.ladderOrder !== actionSnapshot.ladderOrder
    || matchingPolicyAction.minimumConsecutiveUnchangedRounds
      !== actionSnapshot.minimumConsecutiveUnchangedRounds
  ) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `${label} action snapshot does not bind its policy rung`,
    );
  }
  if (action.state === "pending") {
    if (
      claimToken !== null
      || claimExpiresAt !== null
      || claimedByWorkerId !== null
      || claimedAt !== null
      || processedAt !== null
      || resultPayload !== null
    ) {
      throw new RoomProjectionReplayError(
        "invalid_event_payload",
        `${label} pending action retains a claim or result`,
      );
    }
  } else if (action.state === "claimed") {
    if (
      attemptCount < 1
      || claimToken === null
      || claimExpiresAt === null
      || claimedByWorkerId === null
      || claimedAt === null
      || processedAt !== null
      || resultPayload !== null
      || lastErrorCode !== null
      || Date.parse(claimExpiresAt) <= Date.parse(claimedAt)
    ) {
      throw new RoomProjectionReplayError(
        "invalid_event_payload",
        `${label} has invalid claimed action state`,
      );
    }
  } else if (action.state === "processed") {
    if (
      claimToken !== null
      || claimExpiresAt !== null
      || claimedByWorkerId !== null
      || claimedAt !== null
      || processedAt !== updatedAt
      || resultPayload === null
      || lastErrorCode !== null
    ) {
      throw new RoomProjectionReplayError(
        "invalid_event_payload",
        `${label} has invalid processed action state`,
      );
    }
  } else {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `${label}.state must be pending, claimed, or processed`,
    );
  }
  return {
    id: action.id as string,
    roomId: action.roomId as string,
    nodeId: action.nodeId as string,
    nodeVersion,
    observationId: action.observationId as string,
    actionId: action.actionId as string,
    actionSnapshot,
    policySnapshot,
    state: action.state,
    attemptCount,
    claimToken,
    claimExpiresAt,
    claimedByWorkerId,
    claimedAt,
    nextEligibleAt,
    resultPayload,
    lastErrorCode,
    operatorApprovalId,
    createdAt,
    updatedAt,
    processedAt,
  };
}

function parseRoomTaskNoProgressRecoveryActionSnapshot(
  value: unknown,
  label: string,
): RoomTaskNoProgressRecoveryActionSnapshotV1 {
  const snapshot = requireEventRecord(value, label);
  assertExactKeys(snapshot, [
    "contractVersion",
    "protocolId",
    "protocolVersion",
    "turnId",
    "phaseId",
    "nodeId",
    "nodeVersion",
    "observationId",
    "recoveryAction",
    "recoveryActionHash",
    "ladderOrder",
    "minimumConsecutiveUnchangedRounds",
    "executionMode",
  ], label);
  if (snapshot.contractVersion !== "room-task-no-progress-recovery-action/v1") {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `${label} has an unsupported recovery-action snapshot contract`,
    );
  }
  for (const field of ["protocolId", "turnId", "phaseId", "nodeId", "observationId"] as const) {
    requireTrimmedString(snapshot[field], `${label}.${field}`);
  }
  const protocolVersion = requirePositiveInteger(snapshot.protocolVersion, `${label}.protocolVersion`);
  const nodeVersion = requireNonNegativeInteger(snapshot.nodeVersion, `${label}.nodeVersion`);
  const recoveryAction = parseRoomProtocolRecoveryAction(
    snapshot.recoveryAction,
    `${label}.recoveryAction`,
  );
  const recoveryActionHash = requireCanonicalRoomHash(
    snapshot.recoveryActionHash,
    `${label}.recoveryActionHash`,
  );
  const ladderOrder = requirePositiveInteger(snapshot.ladderOrder, `${label}.ladderOrder`);
  const minimumConsecutiveUnchangedRounds = requirePositiveInteger(
    snapshot.minimumConsecutiveUnchangedRounds,
    `${label}.minimumConsecutiveUnchangedRounds`,
  );
  if (
    snapshot.executionMode !== "controller_plan"
    && snapshot.executionMode !== "operator_approval"
  ) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `${label}.executionMode is unsupported`,
    );
  }
  if (
    recoveryAction.trigger !== "no_progress"
    || recoveryActionHash !== hashRoomValue(recoveryAction)
    || snapshot.executionMode !== roomTaskRecoveryExecutionMode(recoveryAction)
    || !recoveryAction.phaseIds.includes(snapshot.phaseId as string)
  ) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `${label} has forged recovery-action hash, mode, trigger, or phase scope`,
    );
  }
  return {
    contractVersion: "room-task-no-progress-recovery-action/v1",
    protocolId: snapshot.protocolId as RoomTaskNoProgressRecoveryActionSnapshotV1["protocolId"],
    protocolVersion,
    turnId: snapshot.turnId as string,
    phaseId: snapshot.phaseId as string,
    nodeId: snapshot.nodeId as string,
    nodeVersion,
    observationId: snapshot.observationId as string,
    recoveryAction,
    recoveryActionHash,
    ladderOrder,
    minimumConsecutiveUnchangedRounds,
    executionMode: snapshot.executionMode,
  };
}

function parseRoomProtocolRecoveryAction(
  value: unknown,
  label: string,
): RoomProtocolRecoveryActionV1 {
  const action = requireEventRecord(value, label);
  assertExactKeys(action, ["id", "trigger", "action", "maxAttempts", "phaseIds", "exhaustedGateId"], label);
  const triggers = new Set([
    "timeout",
    "no_progress",
    "hard_gate_failed",
    "participant_lost",
    "rate_limited",
    "conflicting_evidence",
  ]);
  const actionKinds = new Set([
    "retry",
    "redecompose",
    "replace_participant",
    "add_challenger",
    "shrink_scope",
    "change_model",
    "request_operator",
  ]);
  if (
    !triggers.has(action.trigger as string)
    || !actionKinds.has(action.action as string)
  ) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `${label} has an unsupported recovery trigger or action`,
    );
  }
  const phaseIds = requireUniqueStringArray(action.phaseIds, `${label}.phaseIds`);
  if (phaseIds.length === 0) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `${label}.phaseIds cannot be empty`,
    );
  }
  return {
    id: requireTrimmedString(action.id, `${label}.id`),
    trigger: action.trigger as RoomProtocolRecoveryActionV1["trigger"],
    action: action.action as RoomProtocolRecoveryActionV1["action"],
    maxAttempts: requirePositiveInteger(action.maxAttempts, `${label}.maxAttempts`),
    phaseIds,
    exhaustedGateId: requireTrimmedString(action.exhaustedGateId, `${label}.exhaustedGateId`),
  };
}

function parseRoomTaskNoProgressRecoveryPolicySnapshot(
  value: unknown,
  label: string,
): RoomProtocolNoProgressRecoveryPolicyV1 {
  const policy = requireEventRecord(value, label);
  assertExactKeys(policy, ["protocolId", "protocolVersion", "actions"], label);
  const protocolId = requireTrimmedString(policy.protocolId, `${label}.protocolId`);
  const protocolVersion = requirePositiveInteger(policy.protocolVersion, `${label}.protocolVersion`);
  const actionRecords = requireEventArray(policy.actions, `${label}.actions`);
  const actionIds = new Set<string>();
  const ladderOrders = new Set<number>();
  const actions = actionRecords.map((candidate, index) => {
    const action = requireEventRecord(candidate, `${label}.actions[${index}]`);
    assertExactKeys(action, [
      "recoveryActionId",
      "ladderOrder",
      "minimumConsecutiveUnchangedRounds",
    ], `${label}.actions[${index}]`);
    const recoveryActionId = requireTrimmedString(
      action.recoveryActionId,
      `${label}.actions[${index}].recoveryActionId`,
    );
    const ladderOrder = requirePositiveInteger(
      action.ladderOrder,
      `${label}.actions[${index}].ladderOrder`,
    );
    const minimumConsecutiveUnchangedRounds = requirePositiveInteger(
      action.minimumConsecutiveUnchangedRounds,
      `${label}.actions[${index}].minimumConsecutiveUnchangedRounds`,
    );
    if (actionIds.has(recoveryActionId) || ladderOrders.has(ladderOrder)) {
      throw new RoomProjectionReplayError(
        "invalid_event_payload",
        `${label}.actions contains duplicate recovery-action or ladder identity`,
      );
    }
    actionIds.add(recoveryActionId);
    ladderOrders.add(ladderOrder);
    return { recoveryActionId, ladderOrder, minimumConsecutiveUnchangedRounds };
  });
  return {
    protocolId: protocolId as RoomProtocolNoProgressRecoveryPolicyV1["protocolId"],
    protocolVersion,
    actions: actions.sort(
      (left, right) => left.ladderOrder - right.ladderOrder
        || left.recoveryActionId.localeCompare(right.recoveryActionId),
    ),
  };
}

function parseRoomTaskRecoveryActionResult(
  value: unknown,
  label: string,
): RoomTaskRecoveryActionResultV1 {
  const result = requireEventRecord(value, label);
  assertExactKeys(result, ["contractVersion", "kind", "receiptRef", "resultHash"], label);
  if (
    result.contractVersion !== "room-task-recovery-action-result/v1"
    || (result.kind !== "controller_plan_submitted"
      && result.kind !== "operator_approval_requested"
      && result.kind !== "superseded")
  ) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `${label} has an unsupported recovery result contract or kind`,
    );
  }
  const receiptRef = requireTrimmedString(result.receiptRef, `${label}.receiptRef`);
  const resultHash = requireCanonicalRoomHash(result.resultHash, `${label}.resultHash`);
  if (
    resultHash !== hashRoomValue({
      contractVersion: result.contractVersion,
      kind: result.kind,
      receiptRef,
    })
  ) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `${label}.resultHash does not bind its durable receipt`,
    );
  }
  return {
    contractVersion: "room-task-recovery-action-result/v1",
    kind: result.kind,
    receiptRef,
    resultHash,
  };
}

function roomTaskRecoveryExecutionMode(
  action: RoomProtocolRecoveryActionV1,
): RoomTaskNoProgressRecoveryActionSnapshotV1["executionMode"] {
  return action.action === "replace_participant"
    || action.action === "change_model"
    || action.action === "request_operator"
    ? "operator_approval"
    : "controller_plan";
}

function requireNullableTaskRecoveryErrorCode(value: unknown, label: string): string | null {
  if (value === null) return null;
  const errorCode = requireTrimmedString(value, label);
  if (!/^[a-z][a-z0-9_]{0,63}$/u.test(errorCode)) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `${label} must be a safe task-recovery error code`,
    );
  }
  return errorCode;
}

function roomTaskProgressRecoveryEventType(
  decision: RoomTaskNoProgressRecoveryDecisionV1,
): "room_task_progress_observed" | "room_task_recovery_action_enqueued" | "room_task_recovery_ladder_exhausted" {
  if (decision.kind === "action_enqueued") return "room_task_recovery_action_enqueued";
  if (decision.kind === "exhausted") return "room_task_recovery_ladder_exhausted";
  return "room_task_progress_observed";
}

function sameRoomTaskProgressVector(
  left: RoomTaskProgressObservationV1,
  right: RoomTaskProgressObservationV1,
): boolean {
  return left.progressSignature === right.progressSignature
    && left.semanticHash === right.semanticHash
    && left.evidenceHash === right.evidenceHash
    && left.artifactHash === right.artifactHash
    && left.testHash === right.testHash
    && left.resolvedDissentHash === right.resolvedDissentHash;
}

function roomTaskProgressObservationScopeKey(observation: RoomTaskProgressObservationV1): string {
  return JSON.stringify([
    observation.roomId,
    observation.nodeId,
    observation.nodeVersion,
    observation.turnId,
    observation.phaseId,
  ]);
}

function roomTaskProgressObservationRoundKey(observation: RoomTaskProgressObservationV1): string {
  return JSON.stringify([
    observation.roomId,
    observation.nodeId,
    observation.nodeVersion,
    observation.turnId,
    observation.phaseId,
    observation.roundId,
  ]);
}

function compareRoomTaskProgressObservations(
  left: RoomTaskProgressObservationV1,
  right: RoomTaskProgressObservationV1,
): number {
  if (left.observedAt !== right.observedAt) return left.observedAt < right.observedAt ? -1 : 1;
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

function compareRoomTaskRecoveryActions(
  left: RoomTaskRecoveryActionV1,
  right: RoomTaskRecoveryActionV1,
): number {
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

function parseRoomSemanticControllerActionEventSnapshot(
  event: RoomEventRecordV1,
  payload: Readonly<Record<string, unknown>>,
): RoomSemanticControllerActionEventSnapshotV1 {
  assertExactKeys(payload, [
    "projectionVersion",
    "actionId",
    "snapshot",
    "updatedAt",
  ], `${event.id} payload`);
  if (requireNonNegativeInteger(payload.projectionVersion, `${event.id} projectionVersion`) !== 1) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Semantic controller action event ${event.id} requires projection version 1`,
    );
  }
  const actionId = requireTrimmedString(payload.actionId, `${event.id} actionId`);
  const updatedAt = requireCanonicalUtcIsoTimestamp(payload.updatedAt, `${event.id} updatedAt`);
  if (event.occurredAt !== updatedAt) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Semantic controller action event ${event.id} must occur at its action update time`,
    );
  }
  const snapshot = requireEventRecord(payload.snapshot, `${event.id} snapshot`);
  assertExactKeys(snapshot, [
    "contractVersion",
    "transition",
    "previousState",
    "action",
  ], `${event.id} snapshot`);
  if (snapshot.contractVersion !== "room-semantic-controller-action-snapshot/v1") {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Semantic controller action event ${event.id} has an unsupported snapshot contract`,
    );
  }
  if (
    snapshot.transition !== "claimed"
    && snapshot.transition !== "processed"
    && snapshot.transition !== "retry"
  ) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Semantic controller action event ${event.id} has an unsupported transition`,
    );
  }
  if (snapshot.previousState !== "pending" && snapshot.previousState !== "claimed") {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Semantic controller action event ${event.id} has an unsupported previous state`,
    );
  }
  const action = parseRoomSemanticControllerAction(
    snapshot.action,
    `${event.id} snapshot.action`,
  );
  if (action.id !== actionId || action.roomId !== event.roomId || action.updatedAt !== updatedAt) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Semantic controller action event ${event.id} does not bind its action snapshot`,
    );
  }
  if (event.eventType === "room_semantic_controller_action_claimed") {
    if (snapshot.transition !== "claimed" || action.state !== "claimed") {
      throw new RoomProjectionReplayError(
        "invalid_event_payload",
        `Semantic controller action claim ${event.id} must end in claimed state`,
      );
    }
  } else if (
    snapshot.previousState !== "claimed"
    || (snapshot.transition !== "processed" && snapshot.transition !== "retry")
    || (snapshot.transition === "processed" && action.state !== "processed")
    || (snapshot.transition === "retry" && action.state !== "pending")
  ) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Semantic controller action completion ${event.id} has an illegal transition`,
    );
  }
  return structuredClone(snapshot) as unknown as RoomSemanticControllerActionEventSnapshotV1;
}

function parseRoomSemanticControllerAction(
  value: unknown,
  label: string,
): RoomSemanticControllerActionV1 {
  const action = requireEventRecord(value, label);
  assertExactKeys(action, [
    "id",
    "roomId",
    "messageId",
    "protocolMessageId",
    "actionKind",
    "reasonCode",
    "payload",
    "state",
    "attemptCount",
    "claimToken",
    "claimExpiresAt",
    "claimedBy",
    "processedAt",
    "lastErrorCode",
    "createdAt",
    "updatedAt",
  ], label);
  requireTrimmedString(action.id, `${label}.id`);
  requireTrimmedString(action.roomId, `${label}.roomId`);
  requireTrimmedString(action.messageId, `${label}.messageId`);
  requireNullableTrimmedString(action.protocolMessageId, `${label}.protocolMessageId`);
  if (action.actionKind !== "semantic_message" && action.actionKind !== "semantic_loop_break") {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `${label}.actionKind must be a supported semantic controller action`,
    );
  }
  requireNullableTrimmedString(action.reasonCode, `${label}.reasonCode`);
  requireEventRecord(action.payload, `${label}.payload`);
  if (action.state !== "pending" && action.state !== "claimed" && action.state !== "processed") {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `${label}.state must be pending, claimed, or processed`,
    );
  }
  const attemptCount = requireNonNegativeInteger(action.attemptCount, `${label}.attemptCount`);
  const claimToken = requireNullableTrimmedString(action.claimToken, `${label}.claimToken`);
  const claimExpiresAt = action.claimExpiresAt === null
    ? null
    : requireCanonicalUtcIsoTimestamp(action.claimExpiresAt, `${label}.claimExpiresAt`);
  const claimedBy = requireNullableTrimmedString(action.claimedBy, `${label}.claimedBy`);
  const processedAt = action.processedAt === null
    ? null
    : requireCanonicalUtcIsoTimestamp(action.processedAt, `${label}.processedAt`);
  const lastErrorCode = requireNullableTrimmedString(action.lastErrorCode, `${label}.lastErrorCode`);
  const createdAt = requireCanonicalUtcIsoTimestamp(action.createdAt, `${label}.createdAt`);
  const updatedAt = requireCanonicalUtcIsoTimestamp(action.updatedAt, `${label}.updatedAt`);
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `${label}.updatedAt cannot precede createdAt`,
    );
  }
  if (action.state === "claimed") {
    if (
      attemptCount === 0
      || claimToken === null
      || claimExpiresAt === null
      || claimedBy === null
      || processedAt !== null
      || lastErrorCode !== null
      || Date.parse(claimExpiresAt) <= Date.parse(updatedAt)
    ) {
      throw new RoomProjectionReplayError(
        "invalid_event_payload",
        `${label} claimed state must retain one live claim and no completion`,
      );
    }
  } else {
    if (claimToken !== null || claimExpiresAt !== null || claimedBy !== null) {
      throw new RoomProjectionReplayError(
        "invalid_event_payload",
        `${label} non-claimed state cannot retain a claim token`,
      );
    }
    if (action.state === "processed") {
      if (attemptCount === 0 || processedAt !== updatedAt || lastErrorCode !== null) {
        throw new RoomProjectionReplayError(
          "invalid_event_payload",
          `${label} processed state must retain a successful completion timestamp`,
        );
      }
    } else if (processedAt !== null) {
      throw new RoomProjectionReplayError(
        "invalid_event_payload",
        `${label} pending state cannot retain a completion timestamp`,
      );
    }
  }
  return structuredClone(action) as unknown as RoomSemanticControllerActionV1;
}

function seedRoomSemanticControllerAction(
  actions: Map<string, RoomSemanticControllerActionV1>,
  event: RoomEventRecordV1,
  action: RoomSemanticControllerActionV1,
): void {
  const payload = requireEventRecord(event.payload, `${event.id} payload`);
  const routedProtocolMessageId = requireTrimmedString(
    payload.protocolMessageId,
    `${event.id} protocolMessageId`,
  );
  const existing = actions.get(action.id);
  if (existing) {
    // A bounded loop may emit later route events that reference the one
    // already-materialized escalation action. The reference is valid only when
    // it names a different triggering protocol message and carries the exact
    // current immutable/action-state snapshot; a duplicate initial seed still
    // fails closed.
    if (
      action.actionKind !== "semantic_loop_break"
      || action.protocolMessageId === routedProtocolMessageId
    ) {
      throw new RoomProjectionReplayError(
        "invalid_event_payload",
        `Route event ${event.id} duplicates controller inbox action ${action.id}`,
      );
    }
    assertRoomSemanticControllerActionIdentity(existing, action, event.id);
    if (hashRoomValue(existing) !== hashRoomValue(action)) {
      throw new RoomProjectionReplayError(
        "invalid_event_payload",
        `Route event ${event.id} does not match the current controller action ${action.id}`,
      );
    }
    return;
  }
  if (action.protocolMessageId !== routedProtocolMessageId) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Route event ${event.id} references an unseeded controller action ${action.id}`,
    );
  }
  if (
    action.roomId !== event.roomId
    || action.state !== "pending"
    || action.attemptCount !== 0
    || action.claimToken !== null
    || action.claimExpiresAt !== null
    || action.claimedBy !== null
    || action.processedAt !== null
    || action.lastErrorCode !== null
    || action.createdAt !== action.updatedAt
  ) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Route event ${event.id} must seed one pristine pending controller action`,
    );
  }
  actions.set(action.id, structuredClone(action));
}

function applyRoomSemanticControllerActionTransition(
  actions: Map<string, RoomSemanticControllerActionV1>,
  event: RoomEventRecordV1,
  snapshot: RoomSemanticControllerActionEventSnapshotV1,
): void {
  const previous = actions.get(snapshot.action.id);
  if (!previous) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Semantic controller action event ${event.id} references an unseeded action ${snapshot.action.id}`,
    );
  }
  if (snapshot.previousState !== previous.state) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Semantic controller action event ${event.id} requires previous state ${snapshot.previousState}; replay is ${previous.state}`,
    );
  }
  assertRoomSemanticControllerActionIdentity(previous, snapshot.action, event.id);
  if (Date.parse(snapshot.action.updatedAt) < Date.parse(previous.updatedAt)) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Semantic controller action event ${event.id} moves action time backwards`,
    );
  }
  if (snapshot.transition === "claimed") {
    if (
      snapshot.action.state !== "claimed"
      || snapshot.action.attemptCount !== previous.attemptCount + 1
      || (
        previous.state === "claimed"
        && (
          previous.claimExpiresAt === null
          || Date.parse(previous.claimExpiresAt) > Date.parse(snapshot.action.updatedAt)
        )
      )
    ) {
      throw new RoomProjectionReplayError(
        "invalid_event_payload",
        `Semantic controller action claim ${event.id} is not a legal next claim`,
      );
    }
  } else {
    if (
      previous.state !== "claimed"
      || snapshot.previousState !== "claimed"
      || snapshot.action.attemptCount !== previous.attemptCount
      || (snapshot.transition === "processed" && snapshot.action.state !== "processed")
      || (snapshot.transition === "retry" && snapshot.action.state !== "pending")
    ) {
      throw new RoomProjectionReplayError(
        "invalid_event_payload",
        `Semantic controller action completion ${event.id} requires a claimed action`,
      );
    }
  }
  actions.set(snapshot.action.id, structuredClone(snapshot.action));
}

function assertRoomSemanticControllerActionIdentity(
  previous: RoomSemanticControllerActionV1,
  next: RoomSemanticControllerActionV1,
  eventId: string,
): void {
  const immutable = (action: RoomSemanticControllerActionV1) => ({
    id: action.id,
    roomId: action.roomId,
    messageId: action.messageId,
    protocolMessageId: action.protocolMessageId,
    actionKind: action.actionKind,
    reasonCode: action.reasonCode,
    payload: action.payload,
    createdAt: action.createdAt,
  });
  if (hashRoomValue(immutable(previous)) !== hashRoomValue(immutable(next))) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Semantic controller action event ${eventId} changes immutable action evidence`,
    );
  }
}

function parseRoomSemanticRouteEventSnapshot(
  event: RoomEventRecordV1,
  payload: Readonly<Record<string, unknown>>,
): RoomSemanticRouteEventSnapshotV1 {
  const snapshot = requireEventRecord(payload.snapshot, `${event.id} snapshot`);
  assertExactKeys(snapshot, [
    "contractVersion",
    "sourceMessage",
    "protocolMessage",
    "targets",
    "deliveries",
    "controllerAction",
    "loopBreak",
  ], `${event.id} snapshot`);
  if (snapshot.contractVersion !== "room-semantic-route-snapshot/v1") {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `${event.id} snapshot has an unsupported contract version`,
    );
  }

  const source = requireEventRecord(snapshot.sourceMessage, `${event.id} snapshot.sourceMessage`);
  assertExactKeys(source, [
    "contractVersion",
    "id",
    "roomId",
    "turnId",
    "nodeId",
    "originType",
    "originId",
    "targetSeatIds",
    "intent",
    "contentHash",
    "authorityEnvelope",
    "createdAt",
    "content",
  ], `${event.id} snapshot.sourceMessage`);
  if (
    source.contractVersion !== 1
    || requireTrimmedString(source.id, `${event.id} snapshot.sourceMessage.id`) !== payload.messageId
    || requireTrimmedString(source.roomId, `${event.id} snapshot.sourceMessage.roomId`) !== event.roomId
    || source.originType !== "seat"
  ) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `${event.id} snapshot source message does not bind the routed Room message`,
    );
  }
  requireCanonicalUtcIsoTimestamp(source.createdAt, `${event.id} snapshot.sourceMessage.createdAt`);
  requireTrimmedString(source.content, `${event.id} snapshot.sourceMessage.content`);
  requireTrimmedString(source.contentHash, `${event.id} snapshot.sourceMessage.contentHash`);
  requireUniqueStringArray(source.targetSeatIds, `${event.id} snapshot.sourceMessage.targetSeatIds`);

  const protocol = requireEventRecord(snapshot.protocolMessage, `${event.id} snapshot.protocolMessage`);
  const envelope = validateRoomProtocolMessage(protocol.envelope);
  if (!envelope.ok) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `${event.id} snapshot protocol envelope is invalid`,
    );
  }
  if (
    requireTrimmedString(protocol.id, `${event.id} snapshot.protocolMessage.id`) !== source.id
    || requireTrimmedString(protocol.roomId, `${event.id} snapshot.protocolMessage.roomId`) !== event.roomId
    || requireTrimmedString(protocol.protocolMessageId, `${event.id} snapshot.protocolMessage.protocolMessageId`)
      !== payload.protocolMessageId
    || envelope.value.roomId !== event.roomId
    || envelope.value.projectId !== event.projectId
    || envelope.value.messageId !== payload.protocolMessageId
    || envelope.value.content !== source.content
    || envelope.value.contentHash !== source.contentHash
    || envelope.value.intent !== source.intent
    || hashRoomValue(envelope.value.authority) !== hashRoomValue(source.authorityEnvelope)
  ) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `${event.id} snapshot protocol envelope is inconsistent with the source message`,
    );
  }
  for (const field of [
    "turnId",
    "nodeId",
    "protocolId",
    "phaseId",
    "channelId",
    "issuedAt",
    "semanticLoopFingerprint",
    "semanticStateId",
    "semanticStateFingerprint",
    "routeOutcome",
    "createdAt",
  ] as const) {
    requireTrimmedString(protocol[field], `${event.id} snapshot.protocolMessage.${field}`);
  }
  if (
    protocol.semanticStateId !== payload.semanticStateId
    || protocol.semanticStateRevision !== payload.semanticStateRevision
    || protocol.semanticStateFingerprint !== payload.semanticStateFingerprint
    || protocol.routeOutcome !== payload.outcome
  ) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `${event.id} snapshot protocol projection is inconsistent with route metadata`,
    );
  }
  const audit = requireEventRecord(payload.audit, `${event.id} audit`);
  if (protocol.semanticLoopFingerprint !== audit.semanticLoopFingerprint) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `${event.id} snapshot loop identity does not match the route audit`,
    );
  }

  const targetIds = requireUniqueStringArray(payload.targetIds, `${event.id} targetIds`);
  const snapshotTargets = requireEventArray(snapshot.targets, `${event.id} snapshot.targets`);
  assertSnapshotRecordIds(snapshotTargets, targetIds, `${event.id} snapshot.targets`, source.id);
  const outboxIds = requireUniqueStringArray(payload.outboxIds, `${event.id} outboxIds`);
  const snapshotDeliveries = requireEventArray(snapshot.deliveries, `${event.id} snapshot.deliveries`);
  assertSnapshotRecordIds(snapshotDeliveries, outboxIds, `${event.id} snapshot.deliveries`, undefined);

  const controllerActionId = requireNullableTrimmedString(
    payload.controllerActionId,
    `${event.id} controllerActionId`,
  );
  const action = snapshot.controllerAction === null
    ? null
    : parseRoomSemanticControllerAction(
      snapshot.controllerAction,
      `${event.id} snapshot.controllerAction`,
    );
  if (
    (controllerActionId === null) !== (action === null)
    || (action !== null
      && requireTrimmedString(action.id, `${event.id} snapshot.controllerAction.id`) !== controllerActionId)
  ) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `${event.id} snapshot controller action does not match route metadata`,
    );
  }

  const loopBreak = snapshot.loopBreak === null
    ? null
    : requireEventRecord(snapshot.loopBreak, `${event.id} snapshot.loopBreak`);
  if (payload.outcome === "loop_break") {
    if (!loopBreak || !action) {
      throw new RoomProjectionReplayError(
        "invalid_event_payload",
        `${event.id} loop break must retain its escalation snapshot`,
      );
    }
    assertExactKeys(loopBreak, ["message", "target", "controllerAction"], `${event.id} snapshot.loopBreak`);
    const escalationMessage = requireEventRecord(loopBreak.message, `${event.id} snapshot.loopBreak.message`);
    const escalationTarget = requireEventRecord(loopBreak.target, `${event.id} snapshot.loopBreak.target`);
    const escalationAction = parseRoomSemanticControllerAction(
      loopBreak.controllerAction,
      `${event.id} snapshot.loopBreak.controllerAction`,
    );
    if (
      requireTrimmedString(escalationMessage.id, `${event.id} snapshot.loopBreak.message.id`)
        !== payload.escalationMessageId
      || requireTrimmedString(escalationTarget.id, `${event.id} snapshot.loopBreak.target.id`)
        !== payload.escalationTargetId
      || requireTrimmedString(escalationAction.id, `${event.id} snapshot.loopBreak.controllerAction.id`)
        !== controllerActionId
    ) {
      throw new RoomProjectionReplayError(
        "invalid_event_payload",
        `${event.id} loop-break snapshot does not match route metadata`,
      );
    }
    if (hashRoomValue(escalationAction) !== hashRoomValue(action)) {
      throw new RoomProjectionReplayError(
        "invalid_event_payload",
        `${event.id} loop-break action must exactly match the route action snapshot`,
      );
    }
  } else if (loopBreak !== null) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `${event.id} ordinary route cannot retain a loop-break snapshot`,
    );
  }
  if (action !== null) {
    validateRoomSemanticRouteControllerAction(event, payload, protocol, loopBreak, action);
  }

  return structuredClone(snapshot) as unknown as RoomSemanticRouteEventSnapshotV1;
}

function validateRoomSemanticRouteControllerAction(
  event: RoomEventRecordV1,
  payload: Readonly<Record<string, unknown>>,
  protocol: Readonly<Record<string, unknown>>,
  loopBreak: Readonly<Record<string, unknown>> | null,
  action: RoomSemanticControllerActionV1,
): void {
  const actionPayload = requireEventRecord(action.payload, `${event.id} snapshot.controllerAction.payload`);
  const isExistingLoopActionReference = action.actionKind === "semantic_loop_break"
    && action.protocolMessageId !== payload.protocolMessageId;
  const commonPayloadKeys = [
    "contractVersion",
    "protocolMessageId",
    "protocolEnvelope",
    "turnId",
    "nodeId",
    "intent",
    "origin",
    "semanticStateId",
    "semanticStateRevision",
    "semanticStateFingerprint",
    "audit",
  ];
  assertExactKeys(
    actionPayload,
    action.actionKind === "semantic_loop_break"
      ? [...commonPayloadKeys, "parentMessageId", "reasonCode"]
      : commonPayloadKeys,
    `${event.id} snapshot.controllerAction.payload`,
  );
  if (actionPayload.contractVersion !== "room-semantic-controller-action/v1") {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `${event.id} controller action payload has an unsupported contract version`,
    );
  }
  const actionEnvelope = validateRoomProtocolMessage(actionPayload.protocolEnvelope);
  if (!actionEnvelope.ok) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `${event.id} controller action has an invalid protocol envelope`,
    );
  }
  const invariantFailures = [
    ["room", action.roomId !== event.roomId],
    ["turn", actionPayload.turnId !== protocol.turnId],
    ["node", actionPayload.nodeId !== protocol.nodeId],
    ["semanticState", actionPayload.semanticStateId !== payload.semanticStateId],
    ["semanticRevision", actionPayload.semanticStateRevision !== payload.semanticStateRevision],
    ["semanticFingerprint", actionPayload.semanticStateFingerprint !== payload.semanticStateFingerprint],
    ["actionPayloadProtocolMessage", action.protocolMessageId !== actionPayload.protocolMessageId],
    ["createdAt", Date.parse(action.createdAt) > Date.parse(requireCanonicalUtcIsoTimestamp(payload.updatedAt, `${event.id} updatedAt`))],
    ...(!isExistingLoopActionReference ? [
      ["protocolMessage", action.protocolMessageId !== payload.protocolMessageId],
      [
        "payloadProtocolMessage",
        requireTrimmedString(actionPayload.protocolMessageId, `${event.id} action payload protocolMessageId`)
          !== payload.protocolMessageId,
      ],
      ["protocolEnvelope", hashRoomValue(actionPayload.protocolEnvelope) !== hashRoomValue(protocol.envelope)],
      ["intent", actionPayload.intent !== actionEnvelope.value.intent],
      ["origin", hashRoomValue(actionPayload.origin) !== hashRoomValue(protocol.origin)],
      ["audit", hashRoomValue(actionPayload.audit) !== hashRoomValue(payload.audit)],
      ["createdAt", action.createdAt !== payload.updatedAt],
    ] as const : []),
  ] as const;
  const failedInvariant = invariantFailures.find(([, failed]) => failed);
  if (failedInvariant) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `${event.id} controller action does not preserve routed ${failedInvariant[0]} evidence`,
    );
  }
  if (action.actionKind === "semantic_message") {
    if (
      action.reasonCode !== null
      || action.messageId !== payload.messageId
      || loopBreak !== null
    ) {
      throw new RoomProjectionReplayError(
        "invalid_event_payload",
        `${event.id} ordinary controller action must bind the routed source message`,
      );
    }
    return;
  }
  if (
    payload.outcome !== "loop_break"
    || action.reasonCode !== "semantic_loop"
    || action.messageId !== payload.escalationMessageId
    || actionPayload.parentMessageId !== action.protocolMessageId
    || actionPayload.reasonCode !== "semantic_loop"
    || loopBreak === null
  ) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `${event.id} loop-break controller action must bind its escalation evidence`,
    );
  }
}

function assertSnapshotRecordIds(
  values: readonly unknown[],
  expectedIds: readonly string[],
  label: string,
  expectedMessageId: string | undefined,
): void {
  const ids = values.map((value, index) => {
    const record = requireEventRecord(value, `${label}[${index}]`);
    const id = requireTrimmedString(record.id, `${label}[${index}].id`);
    if (expectedMessageId !== undefined && record.messageId !== expectedMessageId) {
      throw new RoomProjectionReplayError(
        "invalid_event_payload",
        `${label}[${index}] does not reference its routed source message`,
      );
    }
    return id;
  });
  if (
    ids.length !== expectedIds.length
    || ids.some((id, index) => id !== expectedIds[index])
  ) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `${label} identifiers do not match immutable route metadata`,
    );
  }
}

function validateRoomProtocolMessageRouted(
  aggregate: RoomAggregateV1,
  event: RoomEventRecordV1,
  payload: Readonly<Record<string, unknown>>,
): RoomAggregateV1 {
  assertExactKeys(payload, [
    "projectionVersion",
    "messageId",
    "protocolMessageId",
    "targetIds",
    "outboxIds",
    "controllerActionId",
    "escalationMessageId",
    "escalationTargetId",
    "semanticStateId",
    "semanticStateRevision",
    "semanticStateFingerprint",
    "outcome",
    "audit",
    "snapshot",
    "updatedAt",
  ], `${event.id} payload`);
  if (payload.projectionVersion !== 2) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Protocol message event ${event.id} must use replayable projectionVersion 2`,
    );
  }
  requireTrimmedString(payload.messageId, `${event.id} messageId`);
  requireTrimmedString(payload.protocolMessageId, `${event.id} protocolMessageId`);
  requireUniqueStringArray(payload.targetIds, `${event.id} targetIds`);
  requireUniqueStringArray(payload.outboxIds, `${event.id} outboxIds`);
  requireNullableTrimmedString(payload.controllerActionId, `${event.id} controllerActionId`);
  requireNullableTrimmedString(payload.escalationMessageId, `${event.id} escalationMessageId`);
  requireNullableTrimmedString(payload.escalationTargetId, `${event.id} escalationTargetId`);
  requireTrimmedString(payload.semanticStateId, `${event.id} semanticStateId`);
  requirePositiveInteger(payload.semanticStateRevision, `${event.id} semanticStateRevision`);
  requireTrimmedString(payload.semanticStateFingerprint, `${event.id} semanticStateFingerprint`);
  if (payload.outcome !== "route" && payload.outcome !== "loop_break") {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Protocol message event ${event.id} has unsupported outcome`,
    );
  }
  parseRoomSemanticRouteEventSnapshot(event, payload);
  if (payload.outcome === "loop_break") {
    if (
      payload.controllerActionId === null
      || payload.escalationMessageId === null
      || payload.escalationTargetId === null
      || requireUniqueStringArray(payload.outboxIds, `${event.id} outboxIds`).length !== 0
    ) {
      throw new RoomProjectionReplayError(
        "invalid_event_payload",
        `Loop-break event ${event.id} must contain one controller escalation and no seat outbox`,
      );
    }
  } else if (payload.escalationMessageId !== null || payload.escalationTargetId !== null) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Routed protocol message ${event.id} cannot contain a loop-break escalation`,
    );
  }
  const audit = requireEventRecord(payload.audit, `${event.id} audit`);
  assertExactKeys(audit, [
    "outcome",
    "messageFingerprint",
    "semanticLoopFingerprint",
    "targetFingerprint",
    "semanticHash",
    "evidenceStateHash",
    "decisionStateHash",
    "repeatedSemanticCount",
    "recipientCount",
    "requiredResponderCount",
  ], `${event.id} audit`);
  if (audit.outcome !== payload.outcome) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `Protocol message event ${event.id} audit outcome does not match payload`,
    );
  }
  for (const field of [
    "messageFingerprint",
    "semanticLoopFingerprint",
    "targetFingerprint",
    "semanticHash",
    "evidenceStateHash",
    "decisionStateHash",
  ] as const) {
    requireTrimmedString(audit[field], `${event.id} audit.${field}`);
  }
  for (const field of ["repeatedSemanticCount", "recipientCount", "requiredResponderCount"] as const) {
    requireNonNegativeInteger(audit[field], `${event.id} audit.${field}`);
  }
  return advanceSemanticReplayAggregate(aggregate, event, payload, "protocol message");
}

function validateRoomSemanticControllerActionEvent(
  aggregate: RoomAggregateV1,
  event: RoomEventRecordV1,
  payload: Readonly<Record<string, unknown>>,
): RoomAggregateV1 {
  parseRoomSemanticControllerActionEventSnapshot(event, payload);
  return advanceSemanticReplayAggregate(aggregate, event, payload, "semantic controller action");
}

function advanceSemanticReplayAggregate(
  aggregate: RoomAggregateV1,
  event: RoomEventRecordV1,
  payload: Readonly<Record<string, unknown>>,
  label: string,
): RoomAggregateV1 {
  const updatedAt = requireCanonicalUtcIsoTimestamp(payload.updatedAt, `${event.id} updatedAt`);
  if (event.aggregateVersion !== aggregate.room.aggregateVersion + 1) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `${label} event ${event.id} must advance the aggregate by exactly one`,
    );
  }
  if (Date.parse(updatedAt) < Date.parse(aggregate.room.updatedAt)) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `${label} event ${event.id} cannot move Room time backwards`,
    );
  }
  return {
    ...aggregate,
    room: {
      ...aggregate.room,
      aggregateVersion: event.aggregateVersion,
      updatedAt,
    },
  };
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

function requireCanonicalUtcIsoTimestamp(value: unknown, label: string): string {
  const timestamp = requireIsoTimestamp(value, label);
  if (new Date(Date.parse(timestamp)).toISOString() !== timestamp) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `${label} must be a canonical UTC ISO timestamp`,
    );
  }
  return timestamp;
}

function requireCanonicalRoomHash(value: unknown, label: string): string {
  const hash = requireTrimmedString(value, label);
  if (!/^sha256:[0-9a-f]{64}$/u.test(hash)) {
    throw new RoomProjectionReplayError(
      "invalid_event_payload",
      `${label} must be a canonical sha256 Room hash`,
    );
  }
  return hash;
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
      (event.eventType === "membership_change_activated" || event.eventType === "room_task_dispatch_claimed")
      && (event.payload.projectionVersion === 2 || event.payload.projectionVersion === 3)
    )
    || (event.eventType === "room_protocol_message_routed" && event.payload.projectionVersion === 2);
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
