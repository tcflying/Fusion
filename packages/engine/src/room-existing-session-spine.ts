import {
  assignRoomRoles,
  createRoomCapabilitySnapshot,
  getRoomProtocolDefinition,
  hashRoomValue,
  normalizeRoomRoleAssignmentConstraints,
} from "@fusion/core";
import type {
  AsyncRoomStore,
  CreateRoomWithExistingBindingsInput,
  RoomAggregateV1,
  RoomAuthorityEnvelopeV1,
  RoomBindingRecordV1,
  RoomCapabilitySnapshotInputV1,
  RoomMessageIntent,
  RoomOutboxRecordV1,
  RoomPhaseGateEvidenceProjectionV1,
  RoomPhaseGateEvidenceRecordV1,
  RoomRoleAssignmentConstraintsV1,
  RoomRoleAssignmentProjectionV1,
  RouteRoomProtocolMessageInputV1,
  RouteRoomProtocolMessageResultV1,
  RouteOperatorMessageResultV1,
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
  | "ROOM_EXISTING_SESSION_DELIVERY_CONFLICT"
  | "ROOM_EXISTING_SESSION_ROLE_ASSIGNMENT_INVALID"
  | "ROOM_EXISTING_SESSION_PHASE_BOUNDARY_CONFLICT"
  | "ROOM_EXISTING_SESSION_PROTOCOL_ROUTE_CONFLICT";

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
  | "createRoomWithExistingBindings"
  | "getRoom"
  | "recordRoomPhaseGateEvidence"
  | "transitionRoomRoleAssignment"
  | "routeRoomProtocolMessage"
  | "routeOperatorMessage"
> & RoomConnectorIngestionStore;

/**
 * The caller must attest concrete binding capabilities rather than inferring
 * them from a provider or connector label. The core policy validates the
 * certification and user locks/forbids before any existing Session is attached.
 */
export interface RoomRoleAssignmentConfigurationV1 {
  readonly capabilitySnapshot: RoomCapabilitySnapshotInputV1;
  readonly constraints: RoomRoleAssignmentConstraintsV1;
}

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
  readonly roleAssignment: RoomRoleAssignmentConfigurationV1;
}

export interface TransitionRoomRoleAssignmentAtCompletedTurnBoundaryInput {
  readonly roomId: string;
  readonly expectedAggregateVersion: number;
  readonly boundaryTurnId: string;
  readonly targetPhaseId: string;
  readonly phaseGateEvidenceId: string;
  readonly idempotencyKey: string;
  readonly roleAssignment: RoomRoleAssignmentConfigurationV1;
}

export interface RecordRoomPhaseGateEvidenceAtCompletedTurnBoundaryInput {
  readonly roomId: string;
  readonly expectedAggregateVersion: number;
  readonly idempotencyKey: string;
  readonly evidence: RoomPhaseGateEvidenceRecordV1;
}

/**
 * Explicit typed protocol ingress for a Room already bound to existing native
 * Sessions. It intentionally does not reinterpret connector-history text: an
 * adapter must first produce a validated protocol envelope before using it.
 */
export interface RouteStructuredRoomProtocolMessageInput {
  readonly roomId: string;
  readonly expectedAggregateVersion: number;
  readonly idempotencyKey: string;
  readonly message: unknown;
}

export interface SendToRoomSeatInput {
  readonly roomId: string;
  readonly seatId: string;
  readonly expectedAggregateVersion: number;
  readonly commandId: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly intent: RoomMessageIntent;
  readonly content: string;
  readonly authorityEnvelope: RoomAuthorityEnvelopeV1;
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

FNXC:SessionRoomExistingSpine 2026-07-18-11:53:
Targeted sends delegate one complete typed operator command to the canonical
Room routing transaction. That transaction freezes the seat/binding lineage
and commits the message, durable target, and pending outbox intent together.
The durable recovery worker is the sole owner of sender-lease acquisition and
provider dispatch; this seam never becomes a second sender. Restore reads only
durable Room state, while ingestion reloads durable cursors through the
event-first/history-repair path.
The integration suite uses deterministic doubles and is not live-provider proof.

FNXC:SessionRoomExistingSpine 2026-07-19-05:46:
Existing-Session Room creation now requires an explicit per-binding capability
snapshot plus operator locks/forbids. The Engine preflights the immutable policy
before connector ensure or Room persistence, then activates the durable entry
assignment with a causal system command. Later phases use an explicit completed
turn boundary and retain core's atomic CAS/gate enforcement; this is a runtime
seam, not a live-provider certification.
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
    const roleAssignment = preflightEntryRoleAssignment(input);
    const participants: CreateRoomWithExistingBindingsInput["participants"][number][] = [];
    const nativeIdentities = new Set<string>();
    const happierIdentities = new Set<string>();

    for (const request of input.sessions) {
      const connector = await this.options.connectorRegistry.requireVerified({
        connectorId: request.connectorId,
        capability: "ensureExisting",
        requiredHostId: request.requiredHostId,
        allowUnknownRateLimitForReadOnlyAttachment: true,
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
    const creationEventId = `room-existing-session:${input.room.id}:created`;
    const created = await this.options.roomStore.createRoomWithExistingBindings({
      room: { ...input.room },
      participants,
      entryRoleAssignment: roleAssignment,
      now: occurredAt,
    }, {
      eventId: creationEventId,
      actorType: "system",
      actorId: "room-existing-session-spine",
      correlationId: `room-existing-session:${input.room.id}`,
      causationId: null,
      occurredAt,
    });
    return this.requireRoom(created.room.id);
  }

  async transitionRoleAssignmentAtCompletedTurnBoundary(
    input: TransitionRoomRoleAssignmentAtCompletedTurnBoundaryInput,
  ): Promise<RoomRoleAssignmentProjectionV1> {
    validateRoleTransitionRequest(input);
    await this.requireRoom(input.roomId);

    /*
    FNXC:SessionRoomExistingSpine 2026-07-19-06:46:
    An exact completed-turn transition retry must enter AsyncRoomStore before
    this adapter evaluates a stale aggregate or boundary projection. Core owns
    the command hash, result replay, CAS, safe-boundary, gate, and assignment
    policy; prechecking here previously rejected a committed command before
    Core could return its original durable role-assignment result.
    */
    const occurredAt = this.now();
    return this.options.roomStore.transitionRoomRoleAssignment({
      roomId: input.roomId,
      expectedAggregateVersion: input.expectedAggregateVersion,
      boundaryTurnId: input.boundaryTurnId,
      targetPhaseId: input.targetPhaseId,
      phaseGateEvidenceId: input.phaseGateEvidenceId,
      idempotencyKey: input.idempotencyKey,
      capabilitySnapshot: input.roleAssignment.capabilitySnapshot,
      constraints: input.roleAssignment.constraints,
      now: occurredAt,
    }, {
      eventId: `room-existing-session:${input.roomId}:role-assignment:${hashRoomValue(input.idempotencyKey)}`,
      actorType: "system",
      actorId: "room-existing-session-spine",
      correlationId: `room-existing-session:${input.roomId}:phase:${input.targetPhaseId}`,
      causationId: `room-existing-session:${input.roomId}:turn:${input.boundaryTurnId}`,
      occurredAt,
    });
  }

  async recordPhaseGateEvidenceAtCompletedTurnBoundary(
    input: RecordRoomPhaseGateEvidenceAtCompletedTurnBoundaryInput,
  ): Promise<RoomPhaseGateEvidenceProjectionV1> {
    validatePhaseGateEvidenceRequest(input);
    await this.requireRoom(input.roomId);
    const occurredAt = this.now();
    return this.options.roomStore.recordRoomPhaseGateEvidence({
      roomId: input.roomId,
      expectedAggregateVersion: input.expectedAggregateVersion,
      idempotencyKey: input.idempotencyKey,
      evidence: structuredClone(input.evidence),
      now: occurredAt,
    }, {
      eventId: `room-existing-session:${input.roomId}:phase-gate-evidence:${hashRoomValue(input.idempotencyKey)}`,
      actorType: "system",
      actorId: "room-existing-session-spine",
      correlationId: `room-existing-session:${input.roomId}:phase-gate:${input.evidence.id}`,
      causationId: `room-existing-session:${input.roomId}:turn:${input.evidence.turnId}`,
      occurredAt,
    });
  }

  /**
   * Persist one already-structured peer message through the canonical core
   * router. This is the runtime ingress seam for adapters; raw connector
   * history remains evidence-only until an adapter constructs this envelope.
   */
  async routeStructuredProtocolMessage(
    input: RouteStructuredRoomProtocolMessageInput,
  ): Promise<RouteRoomProtocolMessageResultV1> {
    requireNonEmpty(input.roomId, "roomId");
    requireNonEmpty(input.idempotencyKey, "idempotencyKey");
    if (!Number.isSafeInteger(input.expectedAggregateVersion) || input.expectedAggregateVersion < 0) {
      throw new RoomExistingSessionSpineError(
        "ROOM_EXISTING_SESSION_PROTOCOL_ROUTE_CONFLICT",
        "A structured protocol route requires a non-negative expected aggregate version",
      );
    }
    const room = await this.requireRoom(input.roomId);
    if (room.room.aggregateVersion !== input.expectedAggregateVersion) {
      throw new RoomExistingSessionSpineError(
        "ROOM_EXISTING_SESSION_PROTOCOL_ROUTE_CONFLICT",
        "The structured protocol route has a stale Room aggregate version",
      );
    }
    const command: RouteRoomProtocolMessageInputV1 = {
      roomId: input.roomId,
      expectedAggregateVersion: input.expectedAggregateVersion,
      idempotencyKey: input.idempotencyKey,
      message: input.message,
    };
    return this.options.roomStore.routeRoomProtocolMessage(command);
  }

  /**
   * FNXC:SessionRoomMessageRouting 2026-07-19-17:18:
   * Command gateways need the authoritative post-commit event version for an
   * optimistic API acknowledgement. Keep the full routing result available
   * here while the existing single-seat convenience method remains compatible.
   */
  async routeOperatorMessageToSeat(input: SendToRoomSeatInput): Promise<RouteOperatorMessageResultV1> {
    requireNonEmpty(input.roomId, "roomId");
    requireNonEmpty(input.seatId, "seatId");
    requireNonEmpty(input.commandId, "commandId");
    requireNonEmpty(input.correlationId, "correlationId");
    requireNonEmpty(input.idempotencyKey, "idempotencyKey");
    const occurredAt = this.now();
    return this.options.roomStore.routeOperatorMessage({
      contractVersion: 1,
      apiVersion: "room.v1",
      commandId: input.commandId,
      idempotencyKey: input.idempotencyKey,
      correlationId: input.correlationId,
      projectId: this.options.projectId,
      roomId: input.roomId,
      expectedAggregateVersion: input.expectedAggregateVersion,
      issuedAt: occurredAt,
      authority: input.authorityEnvelope,
      command: {
        type: "route_message",
        target: { kind: "seats", seatIds: [input.seatId] },
        intent: input.intent,
        nodeId: null,
        content: input.content,
        contentHash: hashRoomValue(input.content),
      },
    });
  }

  async sendToSeat(input: SendToRoomSeatInput): Promise<RoomOutboxRecordV1> {
    return requireExactRoutedSeatDelivery(
      await this.routeOperatorMessageToSeat(input),
      input.seatId,
    );
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

function preflightEntryRoleAssignment(
  input: CreateRoomWithExistingSessionsInput,
): RoomRoleAssignmentConfigurationV1 {
  const roleAssignment = requireRoleAssignmentConfiguration(input.roleAssignment);
  const protocol = getRoomProtocolDefinition(input.room.protocolId, input.room.protocolVersion);
  if (!protocol || !protocol.phases[0]) {
    throw new RoomExistingSessionSpineError(
      "ROOM_EXISTING_SESSION_ROLE_ASSIGNMENT_INVALID",
      "Existing-Session Room creation requires a supported protocol with an entry phase",
    );
  }
  const snapshot = requireCertifiedBindings(
    roleAssignment.capabilitySnapshot,
    input.sessions.map((session) => session.bindingId),
    "Existing-Session Room creation",
  );
  const constraints = requireRoleAssignmentConstraints(roleAssignment.constraints);
  const assignment = assignRoomRoles({
    protocol,
    phaseId: protocol.phases[0].id,
    capabilitySnapshot: snapshot,
    constraints,
    producerBindingIds: [],
  });
  if (!assignment.ok) {
    throwRoleAssignmentPreflightError("Existing-Session Room creation", assignment.unsatisfied);
  }
  return { capabilitySnapshot: snapshot, constraints };
}

function requireRoleAssignmentConfiguration(
  value: unknown,
): RoomRoleAssignmentConfigurationV1 {
  if (
    !isRecord(value)
    || !isRecord(value.capabilitySnapshot)
    || !isRecord(value.constraints)
  ) {
    throw new RoomExistingSessionSpineError(
      "ROOM_EXISTING_SESSION_ROLE_ASSIGNMENT_INVALID",
      "Explicit capability certifications and role-assignment locks/forbids are required",
    );
  }
  return value as unknown as RoomRoleAssignmentConfigurationV1;
}

function requireCertifiedBindings(
  input: RoomCapabilitySnapshotInputV1,
  expectedBindingIds: readonly string[],
  scope: string,
): RoomCapabilitySnapshotInputV1 {
  const snapshot = createRoomCapabilitySnapshot(input);
  if (!snapshot.ok) throwRoleAssignmentPreflightError(scope, snapshot.unsatisfied);
  const expected = new Set(expectedBindingIds);
  const certified = new Set(snapshot.value.bindings.map((binding) => binding.bindingId));
  if (
    expected.size !== expectedBindingIds.length
    || certified.size !== expected.size
    || [...expected].some((bindingId) => !certified.has(bindingId))
  ) {
    throw new RoomExistingSessionSpineError(
      "ROOM_EXISTING_SESSION_ROLE_ASSIGNMENT_INVALID",
      `${scope} requires exactly one explicit capability certification for every attached binding`,
    );
  }
  return snapshot.value;
}

function requireRoleAssignmentConstraints(
  input: RoomRoleAssignmentConstraintsV1,
): RoomRoleAssignmentConstraintsV1 {
  const constraints = normalizeRoomRoleAssignmentConstraints(input);
  if (!constraints.ok) throwRoleAssignmentPreflightError("Role-assignment constraints", constraints.unsatisfied);
  return constraints.value;
}

function validateRoleTransitionRequest(
  input: TransitionRoomRoleAssignmentAtCompletedTurnBoundaryInput,
): void {
  for (const [field, value] of Object.entries({
    roomId: input.roomId,
    boundaryTurnId: input.boundaryTurnId,
    targetPhaseId: input.targetPhaseId,
    phaseGateEvidenceId: input.phaseGateEvidenceId,
    idempotencyKey: input.idempotencyKey,
  })) {
    requireNonEmpty(value, field);
  }
  if (!Number.isSafeInteger(input.expectedAggregateVersion) || input.expectedAggregateVersion < 0) {
    throw new RoomExistingSessionSpineError(
      "ROOM_EXISTING_SESSION_PHASE_BOUNDARY_CONFLICT",
      "A completed-turn phase transition requires a non-negative expected aggregate version",
    );
  }
}

function validatePhaseGateEvidenceRequest(
  input: RecordRoomPhaseGateEvidenceAtCompletedTurnBoundaryInput,
): void {
  for (const [field, value] of Object.entries({
    roomId: input.roomId,
    idempotencyKey: input.idempotencyKey,
  })) {
    requireNonEmpty(value, field);
  }
  if (!Number.isSafeInteger(input.expectedAggregateVersion) || input.expectedAggregateVersion < 0) {
    throw new RoomExistingSessionSpineError(
      "ROOM_EXISTING_SESSION_PHASE_BOUNDARY_CONFLICT",
      "Phase-gate evidence requires a non-negative expected aggregate version",
    );
  }
  if (!isRecord(input.evidence) || typeof input.evidence.id !== "string" || input.evidence.id.trim().length === 0) {
    throw new RoomExistingSessionSpineError(
      "ROOM_EXISTING_SESSION_ROLE_ASSIGNMENT_INVALID",
      "Phase-gate evidence requires an immutable evidence record with an id",
    );
  }
}

function throwRoleAssignmentPreflightError(
  scope: string,
  unsatisfied: readonly { readonly code: string }[],
): never {
  const codes = [...new Set(unsatisfied.map((failure) => failure.code))].sort().join(", ");
  throw new RoomExistingSessionSpineError(
    "ROOM_EXISTING_SESSION_ROLE_ASSIGNMENT_INVALID",
    `${scope} capability-aware role assignment is not satisfiable${codes ? `: ${codes}` : ""}`,
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function requireNonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) {
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

function requireExactRoutedSeatDelivery(
  routed: RouteOperatorMessageResultV1,
  seatId: string,
): RoomOutboxRecordV1 {
  const target = routed.targets[0];
  const delivery = routed.deliveries[0];
  if (
    routed.targets.length !== 1
    || target?.targetKind !== "seat"
    || target.seatId !== seatId
    || target.bindingId === null
    || routed.deliveries.length !== 1
    || !delivery
    || delivery.bindingId !== target.bindingId
    || delivery.logicalMessageId !== routed.message.id
  ) {
    throw new RoomExistingSessionSpineError(
      "ROOM_EXISTING_SESSION_DELIVERY_CONFLICT",
      "The canonical Room route did not return exactly one frozen seat binding and delivery",
    );
  }
  return delivery;
}
