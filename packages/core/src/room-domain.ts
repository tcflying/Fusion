import type {
  IsoTimestamp,
  ProjectId,
  RoomBindingId,
  RoomId,
  RoomProtocolId,
  RoomSeatId,
  RoomTurnId,
  SessionConnectorId,
} from "./room-contracts/ids.js";
import type {
  RoomBindingRecordV1,
  RoomLifecycleState,
  RoomRecordV1,
  RoomSeatRecordV1,
  RoomTurnRecordV1,
  RoomTurnState,
} from "./room-contracts/storage.js";

export type RoomDomainErrorCode =
  | "aggregate_version_conflict"
  | "invalid_lifecycle_transition"
  | "terminal_state_immutable"
  | "room_state_conflict"
  | "seat_identity_conflict"
  | "seat_not_found"
  | "binding_identity_conflict"
  | "binding_not_found"
  | "turn_identity_conflict"
  | "turn_not_found"
  | "turn_boundary_required"
  | "membership_change_conflict";

export class RoomDomainError extends Error {
  readonly code: RoomDomainErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: RoomDomainErrorCode, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = "RoomDomainError";
    this.code = code;
    this.details = details;
  }
}

export interface RoomBindingReplacementV1 {
  readonly id: RoomBindingId;
  readonly connectorId: SessionConnectorId;
  readonly providerId: string;
  readonly nativeSessionId: string;
  readonly happierSessionId: string | null;
  readonly serverProfileId: string | null;
  readonly hostId: string;
}

export interface PendingRoomMembershipChangeV1 {
  readonly id: string;
  readonly roomId: RoomId;
  readonly seatId: RoomSeatId;
  readonly kind: "replace_binding";
  readonly replacement: RoomBindingReplacementV1;
  readonly reason: string;
  readonly effectiveAfterTurnId: RoomTurnId | null;
  readonly requestedAt: IsoTimestamp;
  readonly state: "waiting_turn_boundary";
}

export interface RoomAggregateV1 {
  readonly room: RoomRecordV1;
  readonly membershipVersion: number;
  readonly activeTurnId: RoomTurnId | null;
  readonly seats: readonly RoomSeatRecordV1[];
  readonly bindings: readonly RoomBindingRecordV1[];
  readonly turns: readonly RoomTurnRecordV1[];
  readonly pendingMembershipChanges: readonly PendingRoomMembershipChangeV1[];
}

export interface CreateRoomAggregateInput {
  readonly id: RoomId;
  readonly projectId: ProjectId;
  readonly objective: string;
  readonly protocolId: RoomProtocolId;
  readonly protocolVersion: number;
  readonly now: IsoTimestamp;
}

export interface TransitionRoomLifecycleInput {
  readonly to: RoomLifecycleState;
  readonly expectedAggregateVersion: number;
  readonly now: IsoTimestamp;
}

const TERMINAL_OUTCOMES = new Set<RoomLifecycleState>([
  "completed",
  "completed_with_risks",
  "partial",
  "cancelled",
  "failed",
]);

const LIFECYCLE_TRANSITIONS: Readonly<Record<RoomLifecycleState, readonly RoomLifecycleState[]>> = {
  draft: ["ready", "cancelled"],
  ready: ["running", "paused", "cancelled", "failed"],
  running: ["paused", "blocked", "completed", "completed_with_risks", "partial", "cancelled", "failed"],
  paused: ["ready", "running", "cancelled", "failed"],
  completed: ["archived"],
  completed_with_risks: ["archived"],
  partial: ["archived"],
  blocked: ["running", "paused", "partial", "cancelled", "failed"],
  cancelled: ["archived"],
  failed: ["archived"],
  archived: [],
};

/*
FNXC:SessionRoomDomain 2026-07-17-03:28:
All Room mutations are immutable and optimistic-versioned. Running membership
changes are requests until a recorded turn is settled; this prevents a new
provider Session from silently interleaving with the binding it replaces.
*/
export function createRoomAggregate(input: CreateRoomAggregateInput): RoomAggregateV1 {
  if (!input.id || !input.projectId || !input.objective || !input.protocolId || input.protocolVersion < 1) {
    throw new RoomDomainError("room_state_conflict", "Room identity, project, objective, and protocol are required");
  }
  return {
    room: {
      contractVersion: 1,
      id: input.id,
      projectId: input.projectId,
      objective: input.objective,
      protocolId: input.protocolId,
      protocolVersion: input.protocolVersion,
      state: "draft",
      aggregateVersion: 0,
      createdAt: input.now,
      updatedAt: input.now,
    },
    membershipVersion: 0,
    activeTurnId: null,
    seats: [],
    bindings: [],
    turns: [],
    pendingMembershipChanges: [],
  };
}

export function transitionRoomLifecycle(
  aggregate: RoomAggregateV1,
  input: TransitionRoomLifecycleInput,
): RoomAggregateV1 {
  assertAggregateVersion(aggregate, input.expectedAggregateVersion);
  const from = aggregate.room.state;
  if ((TERMINAL_OUTCOMES.has(from) && input.to !== "archived") || from === "archived") {
    throw new RoomDomainError(
      "terminal_state_immutable",
      `Room terminal state ${from} cannot transition to ${input.to}`,
      { from, to: input.to },
    );
  }
  if (!LIFECYCLE_TRANSITIONS[from].includes(input.to)) {
    throw new RoomDomainError(
      "invalid_lifecycle_transition",
      `Room cannot transition from ${from} to ${input.to}`,
      { from, to: input.to },
    );
  }
  return bumpAggregate(aggregate, input.now, { state: input.to });
}

export interface AddRoomSeatInput {
  readonly id: RoomSeatId;
  readonly role: string;
  readonly permissionScope: readonly string[];
  readonly expectedAggregateVersion: number;
  readonly now: IsoTimestamp;
}

export function addRoomSeat(aggregate: RoomAggregateV1, input: AddRoomSeatInput): RoomAggregateV1 {
  assertAggregateVersion(aggregate, input.expectedAggregateVersion);
  assertNoActiveTurn(aggregate);
  if (aggregate.seats.some((seat) => seat.id === input.id)) {
    throw new RoomDomainError("seat_identity_conflict", `Room seat ${input.id} already exists`, { seatId: input.id });
  }
  const seat: RoomSeatRecordV1 = {
    contractVersion: 1,
    id: input.id,
    roomId: aggregate.room.id,
    role: input.role,
    state: "ready",
    permissionScope: [...input.permissionScope],
    activeBindingId: null,
    roleVersion: 1,
    createdAt: input.now,
    updatedAt: input.now,
  };
  return bumpAggregate({ ...aggregate, seats: [...aggregate.seats, seat] }, input.now);
}

export interface AttachRoomBindingInput extends RoomBindingReplacementV1 {
  readonly seatId: RoomSeatId;
  readonly expectedAggregateVersion: number;
  readonly now: IsoTimestamp;
}

export function attachRoomBinding(
  aggregate: RoomAggregateV1,
  input: AttachRoomBindingInput,
): RoomAggregateV1 {
  assertAggregateVersion(aggregate, input.expectedAggregateVersion);
  assertNoActiveTurn(aggregate);
  const seat = requireSeat(aggregate, input.seatId);
  if (seat.activeBindingId !== null) {
    throw new RoomDomainError("binding_identity_conflict", `Seat ${seat.id} already has an active binding`, {
      seatId: seat.id,
      activeBindingId: seat.activeBindingId,
    });
  }
  assertReplacementIdentityAvailable(aggregate, input);
  const generation = nextBindingGeneration(aggregate, seat.id);
  const binding = createBindingRecord(aggregate.room.id, seat.id, generation, input, input.now);
  const seats = aggregate.seats.map((candidate) =>
    candidate.id === seat.id
      ? { ...candidate, activeBindingId: binding.id, state: "ready" as const, updatedAt: input.now }
      : candidate,
  );
  return bumpAggregate(
    { ...aggregate, seats, bindings: [...aggregate.bindings, binding] },
    input.now,
  );
}

export interface BeginRoomTurnInput {
  readonly id: RoomTurnId;
  readonly sequence: number;
  readonly protocolPhaseId: string;
  readonly expectedAggregateVersion: number;
  readonly now: IsoTimestamp;
}

export function beginRoomTurn(aggregate: RoomAggregateV1, input: BeginRoomTurnInput): RoomAggregateV1 {
  assertAggregateVersion(aggregate, input.expectedAggregateVersion);
  if (aggregate.room.state !== "running") {
    throw new RoomDomainError("room_state_conflict", "A turn can begin only while the Room is running", {
      state: aggregate.room.state,
    });
  }
  if (aggregate.activeTurnId !== null) {
    throw new RoomDomainError("turn_identity_conflict", `Room already has active turn ${aggregate.activeTurnId}`);
  }
  if (aggregate.turns.some((turn) => turn.id === input.id || turn.sequence === input.sequence)) {
    throw new RoomDomainError("turn_identity_conflict", `Turn ${input.id} or sequence ${input.sequence} already exists`);
  }
  const turn: RoomTurnRecordV1 = {
    contractVersion: 1,
    id: input.id,
    roomId: aggregate.room.id,
    sequence: input.sequence,
    protocolPhaseId: input.protocolPhaseId,
    membershipVersion: aggregate.membershipVersion,
    state: "running",
    startedAt: input.now,
    endedAt: null,
  };
  return bumpAggregate(
    { ...aggregate, activeTurnId: turn.id, turns: [...aggregate.turns, turn] },
    input.now,
  );
}

export interface SettleRoomTurnInput {
  readonly turnId: RoomTurnId;
  readonly outcome: Extract<RoomTurnState, "completed" | "cancelled" | "uncertain">;
  readonly expectedAggregateVersion: number;
  readonly now: IsoTimestamp;
}

export function settleRoomTurn(aggregate: RoomAggregateV1, input: SettleRoomTurnInput): RoomAggregateV1 {
  assertAggregateVersion(aggregate, input.expectedAggregateVersion);
  if (aggregate.activeTurnId !== input.turnId) {
    throw new RoomDomainError("turn_not_found", `Turn ${input.turnId} is not the active turn`, {
      activeTurnId: aggregate.activeTurnId,
    });
  }
  const turn = aggregate.turns.find((candidate) => candidate.id === input.turnId);
  if (!turn || !["running", "waiting"].includes(turn.state)) {
    throw new RoomDomainError("turn_not_found", `Active turn ${input.turnId} is not settleable`);
  }
  const turns = aggregate.turns.map((candidate) =>
    candidate.id === input.turnId
      ? { ...candidate, state: input.outcome, endedAt: input.now }
      : candidate,
  );
  return bumpAggregate({ ...aggregate, activeTurnId: null, turns }, input.now);
}

export interface RequestRoomBindingReplacementInput {
  readonly changeId: string;
  readonly seatId: RoomSeatId;
  readonly replacement: RoomBindingReplacementV1;
  readonly reason: string;
  readonly expectedAggregateVersion: number;
  readonly requestedAt: IsoTimestamp;
}

export function requestRoomBindingReplacement(
  aggregate: RoomAggregateV1,
  input: RequestRoomBindingReplacementInput,
): RoomAggregateV1 {
  assertAggregateVersion(aggregate, input.expectedAggregateVersion);
  if (aggregate.room.state !== "running" && aggregate.room.state !== "paused") {
    throw new RoomDomainError("room_state_conflict", "Binding replacement requires a running or paused Room");
  }
  const seat = requireSeat(aggregate, input.seatId);
  if (!seat.activeBindingId || !aggregate.bindings.some((binding) => binding.id === seat.activeBindingId)) {
    throw new RoomDomainError("binding_not_found", `Seat ${seat.id} has no active binding`);
  }
  if (aggregate.pendingMembershipChanges.some((change) => change.seatId === seat.id)) {
    throw new RoomDomainError("membership_change_conflict", `Seat ${seat.id} already has a pending membership change`);
  }
  if (aggregate.pendingMembershipChanges.some((change) => change.id === input.changeId)) {
    throw new RoomDomainError("membership_change_conflict", `Membership change ${input.changeId} already exists`);
  }
  assertReplacementIdentityAvailable(aggregate, input.replacement);
  const change: PendingRoomMembershipChangeV1 = {
    id: input.changeId,
    roomId: aggregate.room.id,
    seatId: seat.id,
    kind: "replace_binding",
    replacement: { ...input.replacement },
    reason: input.reason,
    effectiveAfterTurnId: aggregate.activeTurnId,
    requestedAt: input.requestedAt,
    state: "waiting_turn_boundary",
  };
  return bumpAggregate(
    { ...aggregate, pendingMembershipChanges: [...aggregate.pendingMembershipChanges, change] },
    input.requestedAt,
  );
}

export interface ApplyRoomMembershipChangesInput {
  readonly turnId: RoomTurnId;
  readonly expectedAggregateVersion: number;
  readonly now: IsoTimestamp;
}

export function applyRoomMembershipChangesAtTurnBoundary(
  aggregate: RoomAggregateV1,
  input: ApplyRoomMembershipChangesInput,
): RoomAggregateV1 {
  assertAggregateVersion(aggregate, input.expectedAggregateVersion);
  const boundaryTurn = aggregate.turns.find((turn) => turn.id === input.turnId);
  if (
    !boundaryTurn ||
    aggregate.activeTurnId === input.turnId ||
    !["completed", "cancelled", "uncertain"].includes(boundaryTurn.state)
  ) {
    throw new RoomDomainError("turn_boundary_required", `Turn ${input.turnId} has not reached a safe boundary`);
  }
  const applicable = aggregate.pendingMembershipChanges.filter(
    (change) => change.effectiveAfterTurnId === input.turnId,
  );
  if (applicable.length === 0) {
    throw new RoomDomainError("membership_change_conflict", `No membership changes target turn ${input.turnId}`);
  }

  let seats = [...aggregate.seats];
  let bindings = [...aggregate.bindings];
  for (const change of applicable) {
    const seat = seats.find((candidate) => candidate.id === change.seatId);
    if (!seat?.activeBindingId) {
      throw new RoomDomainError("binding_not_found", `Seat ${change.seatId} has no active binding at the boundary`);
    }
    const oldBinding = bindings.find((binding) => binding.id === seat.activeBindingId);
    if (!oldBinding) {
      throw new RoomDomainError("binding_not_found", `Binding ${seat.activeBindingId} does not exist`);
    }
    const generation = nextBindingGeneration({ ...aggregate, bindings }, seat.id);
    const replacement = createBindingRecord(
      aggregate.room.id,
      seat.id,
      generation,
      change.replacement,
      input.now,
    );
    bindings = bindings.map((binding) =>
      binding.id === oldBinding.id
        ? {
            ...binding,
            state: "replaced" as const,
            detachedAt: input.now,
            replacedByBindingId: replacement.id,
          }
        : binding,
    );
    bindings.push(replacement);
    seats = seats.map((candidate) =>
      candidate.id === seat.id
        ? {
            ...candidate,
            activeBindingId: replacement.id,
            state: aggregate.room.state === "running" ? "active" as const : "paused" as const,
            updatedAt: input.now,
          }
        : candidate,
    );
  }

  const applicableIds = new Set(applicable.map((change) => change.id));
  return bumpAggregate(
    {
      ...aggregate,
      membershipVersion: aggregate.membershipVersion + 1,
      seats,
      bindings,
      pendingMembershipChanges: aggregate.pendingMembershipChanges.filter(
        (change) => !applicableIds.has(change.id),
      ),
    },
    input.now,
  );
}

function assertAggregateVersion(aggregate: RoomAggregateV1, expected: number): void {
  if (aggregate.room.aggregateVersion !== expected) {
    throw new RoomDomainError(
      "aggregate_version_conflict",
      `Expected Room aggregate version ${expected}, found ${aggregate.room.aggregateVersion}`,
      { expected, actual: aggregate.room.aggregateVersion },
    );
  }
}

function assertNoActiveTurn(aggregate: RoomAggregateV1): void {
  if (aggregate.activeTurnId !== null) {
    throw new RoomDomainError(
      "turn_boundary_required",
      `Membership cannot change while turn ${aggregate.activeTurnId} is active`,
      { activeTurnId: aggregate.activeTurnId },
    );
  }
}

function requireSeat(aggregate: RoomAggregateV1, seatId: RoomSeatId): RoomSeatRecordV1 {
  const seat = aggregate.seats.find((candidate) => candidate.id === seatId);
  if (!seat) {
    throw new RoomDomainError("seat_not_found", `Room seat ${seatId} does not exist`, { seatId });
  }
  return seat;
}

function assertReplacementIdentityAvailable(
  aggregate: RoomAggregateV1,
  replacement: RoomBindingReplacementV1,
): void {
  if (aggregate.bindings.some((binding) => binding.id === replacement.id)) {
    throw new RoomDomainError("binding_identity_conflict", `Binding ${replacement.id} already exists`);
  }
  if (
    aggregate.bindings.some(
      (binding) =>
        binding.providerId === replacement.providerId &&
        binding.nativeSessionId === replacement.nativeSessionId &&
        binding.state !== "detached" &&
        binding.state !== "replaced" &&
        binding.state !== "failed",
    )
  ) {
    throw new RoomDomainError(
      "binding_identity_conflict",
      `Native Session ${replacement.providerId}:${replacement.nativeSessionId} is already bound in this Room`,
    );
  }
}

function nextBindingGeneration(aggregate: Pick<RoomAggregateV1, "bindings">, seatId: RoomSeatId): number {
  return aggregate.bindings.reduce(
    (highest, binding) => binding.seatId === seatId ? Math.max(highest, binding.generation) : highest,
    0,
  ) + 1;
}

function createBindingRecord(
  roomId: RoomId,
  seatId: RoomSeatId,
  generation: number,
  input: RoomBindingReplacementV1,
  now: IsoTimestamp,
): RoomBindingRecordV1 {
  return {
    contractVersion: 1,
    id: input.id,
    roomId,
    seatId,
    generation,
    connectorId: input.connectorId,
    providerId: input.providerId,
    nativeSessionId: input.nativeSessionId,
    happierSessionId: input.happierSessionId,
    serverProfileId: input.serverProfileId,
    hostId: input.hostId,
    state: "attached",
    attachedAt: now,
    detachedAt: null,
    replacedByBindingId: null,
  };
}

function bumpAggregate(
  aggregate: RoomAggregateV1,
  now: IsoTimestamp,
  roomPatch: Partial<Pick<RoomRecordV1, "state">> = {},
): RoomAggregateV1 {
  return {
    ...aggregate,
    room: {
      ...aggregate.room,
      ...roomPatch,
      aggregateVersion: aggregate.room.aggregateVersion + 1,
      updatedAt: now,
    },
  };
}
