import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { AsyncRoomStore, type RoomCommandContext } from "../../async-room-store.js";
import { AsyncRoomCheckpointStore } from "../../async-room-checkpoint-store.js";
import type { RoomAggregateV1, RoomBindingReplacementV1 } from "../../room-domain.js";
import { createConnectionSetFromUrl, type PostgresConnections } from "../../postgres/connection.js";
import { createAsyncDataLayer, type AsyncDataLayer } from "../../postgres/data-layer.js";
import { EmbeddedPostgresLifecycle } from "../../postgres/embedded-lifecycle.js";
import { applySchemaBaseline } from "../../postgres/schema-applier.js";
import {
  operationalRooms,
  roomBindings,
  roomMembershipChanges,
  roomSeats,
  roomTurns,
} from "../../postgres/schema/room.js";

interface SeedParticipant {
  readonly seatId: string;
  readonly role: string;
  readonly permissionScope: readonly string[];
  readonly binding: RoomBindingReplacementV1;
}

interface EmbeddedTestContext {
  readonly dataDir: string;
  readonly lifecycle: EmbeddedPostgresLifecycle;
  connections: PostgresConnections | null;
}

interface AddParticipantMutation {
  readonly action: "add";
  readonly seat: {
    readonly id: string;
    readonly role: string;
    readonly permissionScope: readonly string[];
  };
  readonly binding: RoomBindingReplacementV1;
}

interface RemoveParticipantMutation {
  readonly action: "remove";
  readonly seatId: string;
}

interface PauseParticipantMutation {
  readonly action: "pause";
  readonly seatId: string;
}

interface ReplaceParticipantMutation {
  readonly action: "replace";
  readonly seatId: string;
  readonly replacement: RoomBindingReplacementV1;
}

interface ChangeParticipantRoleMutation {
  readonly action: "change_role";
  readonly seatId: string;
  readonly role: string;
}

type RoomMembershipMutation =
  | AddParticipantMutation
  | RemoveParticipantMutation
  | PauseParticipantMutation
  | ReplaceParticipantMutation
  | ChangeParticipantRoleMutation;

interface RequestRoomMembershipChangeInput {
  readonly roomId: string;
  readonly changeId: string;
  readonly idempotencyKey: string;
  readonly expectedAggregateVersion: number;
  readonly expectedMembershipVersion: number;
  readonly activateAt: "next_turn_boundary";
  readonly mutation: RoomMembershipMutation;
  readonly reason: string;
  readonly requestedAt: string;
}

interface ApplyRoomMembershipChangesAtTurnBoundaryInput {
  readonly roomId: string;
  readonly turnId: string;
  readonly idempotencyKey?: string;
  readonly expectedAggregateVersion: number;
  readonly expectedMembershipVersion: number;
  readonly now: string;
}

/*
FNXC:SessionRoomMembership 2026-07-17-20:22:
Task 4.3 requires every participant and role mutation to be an optimistic,
durable request that activates only at a recorded turn boundary. Replacement
must create a new binding generation, preserve old lineage, and reject reuse of
an active native identity rather than silently impersonating that Session.

This RED contract names the smallest PostgreSQL seam expected on AsyncRoomStore.
The local interface keeps the suite type-correct until production exports the
API; runtime assertions deliberately fail when either production method is absent.
*/
interface RoomMembershipMutationStoreApi {
  requestMembershipChange(
    input: RequestRoomMembershipChangeInput,
    context: RoomCommandContext,
  ): Promise<RoomAggregateV1>;
  applyMembershipChangesAtTurnBoundary(
    input: ApplyRoomMembershipChangesAtTurnBoundaryInput,
    context: RoomCommandContext,
  ): Promise<RoomAggregateV1>;
}

interface ActiveTurnFixture {
  readonly layer: AsyncDataLayer;
  readonly store: AsyncRoomStore;
  readonly roomId: string;
  readonly turnId: string;
  readonly aggregate: RoomAggregateV1;
}

const PROJECT_ID = "project-room-membership";
const BASE_TIME = "2026-07-17T12:00:00.000Z";
const REQUEST_TIME = "2026-07-17T12:01:00.000Z";
const BOUNDARY_TIME = "2026-07-17T12:02:00.000Z";

function seedParticipant(
  seatId: string,
  role: string,
  providerId: string,
  nativeSessionId: string,
): SeedParticipant {
  return {
    seatId,
    role,
    permissionScope: ["room:message"],
    binding: {
      id: `binding-${seatId}-generation-1`,
      connectorId: "happier",
      providerId,
      nativeSessionId,
      happierSessionId: `happier-${nativeSessionId}`,
      serverProfileId: "server-profile-1",
      machineId: `machine-${seatId}`,
      hostId: "windows-host-1",
    },
  };
}

function commandContext(eventId: string, occurredAt: string): RoomCommandContext {
  return {
    eventId,
    actorType: "human",
    actorId: "operator-1",
    correlationId: `correlation-${eventId}`,
    causationId: null,
    occurredAt,
  };
}

function requireRequestMembershipChange(
  store: AsyncRoomStore,
): RoomMembershipMutationStoreApi["requestMembershipChange"] {
  const method = (store as unknown as Partial<RoomMembershipMutationStoreApi>).requestMembershipChange;
  expect(
    method,
    "Missing target production API: AsyncRoomStore.requestMembershipChange(input, context)",
  ).toBeTypeOf("function");
  return (input, context) => method!.call(store, input, context);
}

function requireApplyMembershipChangesAtTurnBoundary(
  store: AsyncRoomStore,
): RoomMembershipMutationStoreApi["applyMembershipChangesAtTurnBoundary"] {
  const method = (store as unknown as Partial<RoomMembershipMutationStoreApi>)
    .applyMembershipChangesAtTurnBoundary;
  expect(
    method,
    "Missing target production API: AsyncRoomStore.applyMembershipChangesAtTurnBoundary(input, context)",
  ).toBeTypeOf("function");
  return (input, context) => method!.call(store, input, context);
}

async function startEmbeddedDatabase(): Promise<EmbeddedTestContext> {
  const dataDir = mkdtempSync(join(tmpdir(), "fusion-room-membership-mutations-"));
  const lifecycle = new EmbeddedPostgresLifecycle({
    dataDir,
    database: "fusion",
    user: "postgres",
    password: "password",
  });
  const backend = await lifecycle.start();
  const context = {
    dataDir,
    lifecycle,
    connections: await createConnectionSetFromUrl(backend, { poolMax: 4 }),
  } satisfies EmbeddedTestContext;
  await applySchemaBaseline(context.connections.migration, { pluginHooks: [] });
  return context;
}

async function createActiveTurnFixture(
  roomId: string,
  participants: readonly SeedParticipant[] = [
    seedParticipant(
      `${roomId}-seat-producer`,
      "producer",
      "codex",
      `${roomId}-codex-thread-active`,
    ),
  ],
  projectId: string = PROJECT_ID,
): Promise<ActiveTurnFixture> {
  const layer = projectId === PROJECT_ID
    ? sharedLayer
    : createAsyncDataLayer(sharedContext.connections!, { projectId });
  const store = new AsyncRoomStore(layer, { projectId });
  await store.createRoom(
    {
      id: roomId,
      projectId,
      objective: "Mutate Room membership only at turn boundaries",
      protocolId: "implementation",
      protocolVersion: 1,
      now: BASE_TIME,
    },
    commandContext(`${roomId}-created`, BASE_TIME),
  );

  await layer.db.insert(roomSeats).values(participants.map((participant) => ({
    id: participant.seatId,
    projectId,
    roomId,
    role: participant.role,
    roleVersion: 1,
    roleHistory: [],
    permissionScope: [...participant.permissionScope],
    state: "active",
    activeBindingId: participant.binding.id,
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
  })));
  await layer.db.insert(roomBindings).values(participants.map((participant) => ({
    id: participant.binding.id,
    projectId,
    roomId,
    seatId: participant.seatId,
    generation: 1,
    connectorId: participant.binding.connectorId,
    providerId: participant.binding.providerId,
    nativeSessionId: participant.binding.nativeSessionId,
    happierSessionId: participant.binding.happierSessionId,
    serverProfileId: participant.binding.serverProfileId,
    machineId: participant.binding.machineId,
    hostId: participant.binding.hostId,
    state: "attached",
    attachedAt: BASE_TIME,
  })));
  await layer.db
    .update(operationalRooms)
    .set({ membershipVersion: 1 })
    .where(and(eq(operationalRooms.projectId, projectId), eq(operationalRooms.id, roomId)));

  const ready = await store.transitionLifecycle(
    roomId,
    { to: "ready", expectedAggregateVersion: 0, now: BASE_TIME },
    commandContext(`${roomId}-ready`, BASE_TIME),
  );
  const running = await store.transitionLifecycle(
    roomId,
    { to: "running", expectedAggregateVersion: ready.room.aggregateVersion, now: BASE_TIME },
    commandContext(`${roomId}-running`, BASE_TIME),
  );
  const turnId = `${roomId}-turn-1`;
  await layer.db.insert(roomTurns).values({
    id: turnId,
    projectId,
    roomId,
    sequence: 1,
    protocolPhaseId: "implementation",
    membershipVersion: 1,
    state: "running",
    startedAt: BASE_TIME,
    endedAt: null,
  });
  await layer.db
    .update(operationalRooms)
    .set({ activeTurnId: turnId, updatedAt: BASE_TIME })
    .where(and(eq(operationalRooms.projectId, projectId), eq(operationalRooms.id, roomId)));

  const aggregate = await store.getRoom(roomId);
  if (!aggregate) throw new Error(`Fixture Room ${roomId} was not persisted`);
  expect(aggregate.room.aggregateVersion).toBe(running.room.aggregateVersion);
  expect(aggregate.membershipVersion).toBe(1);
  expect(aggregate.activeTurnId).toBe(turnId);
  await new AsyncRoomCheckpointStore(layer, { projectId }).createCheckpoint({
    id: `${roomId}-membership-baseline`,
    roomId,
    turnId,
    expectedAggregateVersion: aggregate.room.aggregateVersion,
    protocolState: {},
    dagVersion: 0,
    bindingCursors: {},
    artifactRefs: [],
    now: BASE_TIME,
  });
  return { layer, store, roomId, turnId, aggregate };
}

async function settleActiveTurnFixture(fixture: ActiveTurnFixture): Promise<void> {
  await fixture.layer.db
    .update(roomTurns)
    .set({ state: "completed", endedAt: BOUNDARY_TIME })
    .where(
      and(
        eq(roomTurns.projectId, PROJECT_ID),
        eq(roomTurns.roomId, fixture.roomId),
        eq(roomTurns.id, fixture.turnId),
      ),
    );
  await fixture.layer.db
    .update(operationalRooms)
    .set({ activeTurnId: null, updatedAt: BOUNDARY_TIME })
    .where(and(eq(operationalRooms.projectId, PROJECT_ID), eq(operationalRooms.id, fixture.roomId)));
}

const sharedContext = await startEmbeddedDatabase();
const sharedLayer = createAsyncDataLayer(sharedContext.connections!, { projectId: PROJECT_ID });

afterAll(async () => {
  if (sharedContext.connections) {
    await sharedContext.connections.close();
    sharedContext.connections = null;
  }
  await sharedContext.lifecycle.stop();
  rmSync(sharedContext.dataDir, { recursive: true, force: true });
});

describe("AsyncRoomStore PostgreSQL membership mutations", () => {
  it("queues participant add during an active turn and activates it at the boundary", async () => {
    const fixture = await createActiveTurnFixture("room-membership-add");
    const addedSeatId = `${fixture.roomId}-seat-reviewer`;
    const addedBindingId = `${fixture.roomId}-binding-seat-reviewer-generation-1`;
    const addedNativeSessionId = `${fixture.roomId}-claude-session-reviewer`;
    const requestMembershipChange = requireRequestMembershipChange(fixture.store);
    const requested = await requestMembershipChange(
      {
        roomId: fixture.roomId,
        changeId: "change-add-reviewer",
        idempotencyKey: "membership:add-reviewer",
        expectedAggregateVersion: fixture.aggregate.room.aggregateVersion,
        expectedMembershipVersion: fixture.aggregate.membershipVersion,
        activateAt: "next_turn_boundary",
        mutation: {
          action: "add",
          seat: {
            id: addedSeatId,
            role: "reviewer",
            permissionScope: ["room:message", "candidate:review"],
          },
          binding: {
            id: addedBindingId,
            connectorId: "happier",
            providerId: "claude",
            nativeSessionId: addedNativeSessionId,
            happierSessionId: `happier-${addedNativeSessionId}`,
            serverProfileId: "server-profile-1",
            machineId: `${fixture.roomId}-machine-seat-reviewer`,
            hostId: "windows-host-1",
          },
        },
        reason: "add an independent reviewer",
        requestedAt: REQUEST_TIME,
      },
      commandContext("event-change-add-reviewer-requested", REQUEST_TIME),
    );

    expect(requested.room.aggregateVersion).toBe(fixture.aggregate.room.aggregateVersion + 1);
    expect(requested.membershipVersion).toBe(fixture.aggregate.membershipVersion);
    expect(requested.seats.some((seat) => seat.id === addedSeatId)).toBe(false);
    expect(await fixture.layer.db.select().from(roomMembershipChanges)).toContainEqual(
      expect.objectContaining({
        id: "change-add-reviewer",
        kind: "add",
        state: "waiting_turn_boundary",
        effectiveAfterTurnId: fixture.turnId,
      }),
    );

    await settleActiveTurnFixture(fixture);
    const applyAtBoundary = requireApplyMembershipChangesAtTurnBoundary(fixture.store);
    const activated = await applyAtBoundary(
      {
        roomId: fixture.roomId,
        turnId: fixture.turnId,
        expectedAggregateVersion: requested.room.aggregateVersion,
        expectedMembershipVersion: requested.membershipVersion,
        now: BOUNDARY_TIME,
      },
      commandContext("event-change-add-reviewer-activated", BOUNDARY_TIME),
    );

    expect(activated.room.aggregateVersion).toBe(requested.room.aggregateVersion + 1);
    expect(activated.membershipVersion).toBe(requested.membershipVersion + 1);
    expect(activated.seats).toContainEqual(expect.objectContaining({
      id: addedSeatId,
      role: "reviewer",
      roleVersion: 1,
      state: "active",
      activeBindingId: addedBindingId,
    }));
    expect(activated.bindings).toContainEqual(expect.objectContaining({
      id: addedBindingId,
      seatId: addedSeatId,
      generation: 1,
      providerId: "claude",
      nativeSessionId: addedNativeSessionId,
      state: "attached",
    }));
    expect(await fixture.layer.db.select().from(roomMembershipChanges)).toContainEqual(
      expect.objectContaining({
        id: "change-add-reviewer",
        state: "applied",
        appliedAt: BOUNDARY_TIME,
      }),
    );
    expect((await fixture.store.listEvents(fixture.roomId)).map((event) => event.eventType)).toEqual([
      "room_created",
      "room_lifecycle_transitioned",
      "room_lifecycle_transitioned",
      "membership_change_requested",
      "membership_change_activated",
    ]);
    const replayed = await new AsyncRoomCheckpointStore(fixture.layer, {
      projectId: PROJECT_ID,
    }).replayProjection(fixture.roomId);
    expect(replayed.aggregate).toEqual(activated);
  });

  it("replays an identical membership request idempotently without duplicating rows or events", async () => {
    const fixture = await createActiveTurnFixture("room-membership-idempotent-request");
    const input: RequestRoomMembershipChangeInput = {
      roomId: fixture.roomId,
      changeId: "change-idempotent-pause",
      idempotencyKey: "membership:idempotent-pause",
      expectedAggregateVersion: fixture.aggregate.room.aggregateVersion,
      expectedMembershipVersion: fixture.aggregate.membershipVersion,
      activateAt: "next_turn_boundary",
      mutation: { action: "pause", seatId: fixture.aggregate.seats[0]!.id },
      reason: "one durable membership request",
      requestedAt: REQUEST_TIME,
    };
    const requestMembershipChange = requireRequestMembershipChange(fixture.store);
    const first = await requestMembershipChange(
      input,
      commandContext("event-change-idempotent-pause", REQUEST_TIME),
    );
    const replay = await requestMembershipChange(
      input,
      commandContext("event-change-idempotent-pause-retry", REQUEST_TIME),
    );

    expect(replay).toEqual(first);
    expect(await fixture.layer.db
      .select()
      .from(roomMembershipChanges)
      .where(eq(roomMembershipChanges.roomId, fixture.roomId))).toHaveLength(1);
    expect(await fixture.store.listEvents(fixture.roomId)).toHaveLength(4);
  });

  it("replays the original membership-request result even after that change was activated", async () => {
    const fixture = await createActiveTurnFixture("room-membership-idempotent-after-boundary");
    const input: RequestRoomMembershipChangeInput = {
      roomId: fixture.roomId,
      changeId: "change-idempotent-after-boundary",
      idempotencyKey: "membership:idempotent-after-boundary",
      expectedAggregateVersion: fixture.aggregate.room.aggregateVersion,
      expectedMembershipVersion: fixture.aggregate.membershipVersion,
      activateAt: "next_turn_boundary",
      mutation: { action: "pause", seatId: fixture.aggregate.seats[0]!.id },
      reason: "retry the exact committed command after activation",
      requestedAt: REQUEST_TIME,
    };
    const requestMembershipChange = requireRequestMembershipChange(fixture.store);
    const requested = await requestMembershipChange(
      input,
      commandContext("event-change-idempotent-after-boundary", REQUEST_TIME),
    );
    await settleActiveTurnFixture(fixture);
    await requireApplyMembershipChangesAtTurnBoundary(fixture.store)(
      {
        roomId: fixture.roomId,
        turnId: fixture.turnId,
        expectedAggregateVersion: requested.room.aggregateVersion,
        expectedMembershipVersion: requested.membershipVersion,
        now: BOUNDARY_TIME,
      },
      commandContext("event-change-idempotent-after-boundary-activated", BOUNDARY_TIME),
    );

    const replay = await requestMembershipChange(
      input,
      commandContext("event-change-idempotent-after-boundary-retry", BOUNDARY_TIME),
    );

    expect(replay).toEqual(requested);
    expect(await fixture.layer.db
      .select()
      .from(roomMembershipChanges)
      .where(eq(roomMembershipChanges.roomId, fixture.roomId))).toHaveLength(1);
    expect(await fixture.store.listEvents(fixture.roomId)).toHaveLength(5);
  });

  it("replays a committed boundary activation idempotently after an acknowledgement loss", async () => {
    const fixture = await createActiveTurnFixture("room-membership-idempotent-boundary");
    const requested = await requireRequestMembershipChange(fixture.store)(
      {
        roomId: fixture.roomId,
        changeId: "change-idempotent-boundary-pause",
        idempotencyKey: "membership:idempotent-boundary-pause",
        expectedAggregateVersion: fixture.aggregate.room.aggregateVersion,
        expectedMembershipVersion: fixture.aggregate.membershipVersion,
        activateAt: "next_turn_boundary",
        mutation: { action: "pause", seatId: fixture.aggregate.seats[0]!.id },
        reason: "retry the committed boundary after losing its acknowledgement",
        requestedAt: REQUEST_TIME,
      },
      commandContext("event-change-idempotent-boundary-requested", REQUEST_TIME),
    );
    await settleActiveTurnFixture(fixture);
    const input: ApplyRoomMembershipChangesAtTurnBoundaryInput = {
      roomId: fixture.roomId,
      turnId: fixture.turnId,
      idempotencyKey: "membership-boundary:turn-1",
      expectedAggregateVersion: requested.room.aggregateVersion,
      expectedMembershipVersion: requested.membershipVersion,
      now: BOUNDARY_TIME,
    };
    const applyAtBoundary = requireApplyMembershipChangesAtTurnBoundary(fixture.store);
    const first = await applyAtBoundary(
      input,
      commandContext("event-change-idempotent-boundary-activated", BOUNDARY_TIME),
    );
    const replay = await applyAtBoundary(
      input,
      commandContext("event-change-idempotent-boundary-retry", BOUNDARY_TIME),
    );

    expect(replay).toEqual(first);
    expect((await fixture.store.listEvents(fixture.roomId)).filter(
      (event) => event.eventType === "membership_change_activated",
    )).toHaveLength(1);
  });

  it("queues participant pause during an active turn and pauses the binding at the boundary", async () => {
    const fixture = await createActiveTurnFixture("room-membership-pause");
    const originalSeat = fixture.aggregate.seats[0]!;
    const originalBinding = fixture.aggregate.bindings[0]!;
    const requestMembershipChange = requireRequestMembershipChange(fixture.store);
    const requested = await requestMembershipChange(
      {
        roomId: fixture.roomId,
        changeId: "change-pause-producer",
        idempotencyKey: "membership:pause-producer",
        expectedAggregateVersion: fixture.aggregate.room.aggregateVersion,
        expectedMembershipVersion: fixture.aggregate.membershipVersion,
        activateAt: "next_turn_boundary",
        mutation: { action: "pause", seatId: originalSeat.id },
        reason: "operator pauses this participant after its current turn",
        requestedAt: REQUEST_TIME,
      },
      commandContext("event-change-pause-producer-requested", REQUEST_TIME),
    );

    expect(requested.membershipVersion).toBe(fixture.aggregate.membershipVersion);
    expect(requested.seats[0]).toMatchObject({
      id: originalSeat.id,
      state: "active",
      activeBindingId: originalBinding.id,
    });
    expect(requested.bindings[0]).toMatchObject({ id: originalBinding.id, state: "attached" });

    await settleActiveTurnFixture(fixture);
    const applyAtBoundary = requireApplyMembershipChangesAtTurnBoundary(fixture.store);
    const activated = await applyAtBoundary(
      {
        roomId: fixture.roomId,
        turnId: fixture.turnId,
        expectedAggregateVersion: requested.room.aggregateVersion,
        expectedMembershipVersion: requested.membershipVersion,
        now: BOUNDARY_TIME,
      },
      commandContext("event-change-pause-producer-activated", BOUNDARY_TIME),
    );

    expect(activated.membershipVersion).toBe(requested.membershipVersion + 1);
    expect(activated.seats[0]).toMatchObject({
      id: originalSeat.id,
      state: "paused",
      activeBindingId: originalBinding.id,
    });
    expect(activated.bindings).toHaveLength(1);
    expect(activated.bindings[0]).toMatchObject({
      id: originalBinding.id,
      state: "paused",
      detachedAt: null,
      replacedByBindingId: null,
    });
  });

  it("queues participant removal and detaches its binding only at the boundary", async () => {
    const fixture = await createActiveTurnFixture("room-membership-remove");
    const originalSeat = fixture.aggregate.seats[0]!;
    const originalBinding = fixture.aggregate.bindings[0]!;
    const immutableIdentity = {
      id: originalBinding.id,
      generation: originalBinding.generation,
      connectorId: originalBinding.connectorId,
      providerId: originalBinding.providerId,
      nativeSessionId: originalBinding.nativeSessionId,
      happierSessionId: originalBinding.happierSessionId,
      hostId: originalBinding.hostId,
      attachedAt: originalBinding.attachedAt,
    };
    const requestMembershipChange = requireRequestMembershipChange(fixture.store);
    const requested = await requestMembershipChange(
      {
        roomId: fixture.roomId,
        changeId: "change-remove-producer",
        idempotencyKey: "membership:remove-producer",
        expectedAggregateVersion: fixture.aggregate.room.aggregateVersion,
        expectedMembershipVersion: fixture.aggregate.membershipVersion,
        activateAt: "next_turn_boundary",
        mutation: { action: "remove", seatId: originalSeat.id },
        reason: "participant completed its assignment",
        requestedAt: REQUEST_TIME,
      },
      commandContext("event-change-remove-producer-requested", REQUEST_TIME),
    );

    expect(requested.seats[0]).toMatchObject({
      id: originalSeat.id,
      state: "active",
      activeBindingId: originalBinding.id,
    });
    expect(requested.bindings[0]).toMatchObject({ ...immutableIdentity, state: "attached" });

    await settleActiveTurnFixture(fixture);
    const applyAtBoundary = requireApplyMembershipChangesAtTurnBoundary(fixture.store);
    const activated = await applyAtBoundary(
      {
        roomId: fixture.roomId,
        turnId: fixture.turnId,
        expectedAggregateVersion: requested.room.aggregateVersion,
        expectedMembershipVersion: requested.membershipVersion,
        now: BOUNDARY_TIME,
      },
      commandContext("event-change-remove-producer-activated", BOUNDARY_TIME),
    );

    expect(activated.membershipVersion).toBe(requested.membershipVersion + 1);
    expect(activated.seats[0]).toMatchObject({
      id: originalSeat.id,
      state: "removed",
      activeBindingId: null,
    });
    expect(activated.bindings).toHaveLength(1);
    expect(activated.bindings[0]).toMatchObject({
      ...immutableIdentity,
      state: "detached",
      detachedAt: BOUNDARY_TIME,
      replacedByBindingId: null,
    });
  });

  it("replaces a participant with a new binding generation and preserves immutable lineage", async () => {
    const fixture = await createActiveTurnFixture("room-membership-replace");
    const originalSeat = fixture.aggregate.seats[0]!;
    const originalBinding = fixture.aggregate.bindings[0]!;
    const immutableIdentity = {
      id: originalBinding.id,
      roomId: originalBinding.roomId,
      seatId: originalBinding.seatId,
      generation: originalBinding.generation,
      connectorId: originalBinding.connectorId,
      providerId: originalBinding.providerId,
      nativeSessionId: originalBinding.nativeSessionId,
      happierSessionId: originalBinding.happierSessionId,
      serverProfileId: originalBinding.serverProfileId,
      machineId: originalBinding.machineId,
      hostId: originalBinding.hostId,
      attachedAt: originalBinding.attachedAt,
    };
    const replacement: RoomBindingReplacementV1 = {
      id: `${fixture.roomId}-binding-seat-producer-generation-2`,
      connectorId: "happier",
      providerId: "opencode",
      nativeSessionId: `${fixture.roomId}-opencode-session-replacement`,
      happierSessionId: `${fixture.roomId}-happier-opencode-session-replacement`,
      serverProfileId: "server-profile-2",
      machineId: `${fixture.roomId}-machine-seat-producer-replacement`,
      hostId: "windows-host-2",
    };
    const requestMembershipChange = requireRequestMembershipChange(fixture.store);
    const requested = await requestMembershipChange(
      {
        roomId: fixture.roomId,
        changeId: "change-replace-producer",
        idempotencyKey: "membership:replace-producer",
        expectedAggregateVersion: fixture.aggregate.room.aggregateVersion,
        expectedMembershipVersion: fixture.aggregate.membershipVersion,
        activateAt: "next_turn_boundary",
        mutation: { action: "replace", seatId: originalSeat.id, replacement },
        reason: "the original native Session is lost after bounded recovery",
        requestedAt: REQUEST_TIME,
      },
      commandContext("event-change-replace-producer-requested", REQUEST_TIME),
    );

    expect(requested.seats[0]?.activeBindingId).toBe(originalBinding.id);
    expect(requested.bindings).toEqual([
      expect.objectContaining({ ...immutableIdentity, state: "attached", replacedByBindingId: null }),
    ]);

    await settleActiveTurnFixture(fixture);
    const applyAtBoundary = requireApplyMembershipChangesAtTurnBoundary(fixture.store);
    const activated = await applyAtBoundary(
      {
        roomId: fixture.roomId,
        turnId: fixture.turnId,
        expectedAggregateVersion: requested.room.aggregateVersion,
        expectedMembershipVersion: requested.membershipVersion,
        now: BOUNDARY_TIME,
      },
      commandContext("event-change-replace-producer-activated", BOUNDARY_TIME),
    );

    expect(activated.membershipVersion).toBe(requested.membershipVersion + 1);
    expect(activated.seats[0]).toMatchObject({
      id: originalSeat.id,
      activeBindingId: replacement.id,
      state: "active",
    });
    expect(activated.bindings).toHaveLength(2);
    expect(activated.bindings[0]).toMatchObject({
      ...immutableIdentity,
      state: "replaced",
      detachedAt: BOUNDARY_TIME,
      replacedByBindingId: replacement.id,
    });
    expect(activated.bindings[1]).toMatchObject({
      ...replacement,
      seatId: originalSeat.id,
      generation: originalBinding.generation + 1,
      state: "attached",
      attachedAt: BOUNDARY_TIME,
      detachedAt: null,
      replacedByBindingId: null,
    });
    expect(await fixture.store.getBinding(originalBinding.id)).toMatchObject({
      ...immutableIdentity,
      state: "replaced",
      replacedByBindingId: replacement.id,
    });
  });

  it("activates a role change only after the current turn boundary", async () => {
    const fixture = await createActiveTurnFixture("room-membership-role-change");
    const originalSeat = fixture.aggregate.seats[0]!;
    const requestMembershipChange = requireRequestMembershipChange(fixture.store);
    const requested = await requestMembershipChange(
      {
        roomId: fixture.roomId,
        changeId: "change-producer-to-reviewer",
        idempotencyKey: "membership:producer-to-reviewer",
        expectedAggregateVersion: fixture.aggregate.room.aggregateVersion,
        expectedMembershipVersion: fixture.aggregate.membershipVersion,
        activateAt: "next_turn_boundary",
        mutation: { action: "change_role", seatId: originalSeat.id, role: "reviewer" },
        reason: "move the participant into independent review for the next turn",
        requestedAt: REQUEST_TIME,
      },
      commandContext("event-change-producer-to-reviewer-requested", REQUEST_TIME),
    );

    expect(requested.membershipVersion).toBe(fixture.aggregate.membershipVersion);
    expect(requested.seats[0]).toMatchObject({
      id: originalSeat.id,
      role: "producer",
      roleVersion: 1,
    });
    expect(requested.turns[0]).toMatchObject({
      id: fixture.turnId,
      state: "running",
      membershipVersion: fixture.aggregate.membershipVersion,
    });

    await settleActiveTurnFixture(fixture);
    const applyAtBoundary = requireApplyMembershipChangesAtTurnBoundary(fixture.store);
    const activated = await applyAtBoundary(
      {
        roomId: fixture.roomId,
        turnId: fixture.turnId,
        expectedAggregateVersion: requested.room.aggregateVersion,
        expectedMembershipVersion: requested.membershipVersion,
        now: BOUNDARY_TIME,
      },
      commandContext("event-change-producer-to-reviewer-activated", BOUNDARY_TIME),
    );

    expect(activated.membershipVersion).toBe(requested.membershipVersion + 1);
    expect(activated.seats[0]).toMatchObject({
      id: originalSeat.id,
      role: "reviewer",
      roleVersion: 2,
    });
    expect(activated.turns[0]).toMatchObject({
      id: fixture.turnId,
      state: "completed",
      membershipVersion: fixture.aggregate.membershipVersion,
    });
    const persistedSeats = await fixture.layer.db
      .select()
      .from(roomSeats)
      .where(and(eq(roomSeats.roomId, fixture.roomId), eq(roomSeats.id, originalSeat.id)));
    expect(persistedSeats[0]?.roleHistory).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "producer", roleVersion: 1 }),
    ]));
  });

  it("rejects replacement that would silently impersonate an active native Session identity", async () => {
    const roomId = "room-membership-native-identity-conflict";
    const producer = seedParticipant(
      `${roomId}-seat-producer`,
      "producer",
      "codex",
      `${roomId}-codex-thread-active`,
    );
    const reviewer = seedParticipant(
      `${roomId}-seat-reviewer`,
      "reviewer",
      "claude",
      `${roomId}-claude-session-active`,
    );
    const fixture = await createActiveTurnFixture(
      roomId,
      [producer, reviewer],
    );
    const before = await fixture.store.getRoom(fixture.roomId);
    const eventCountBefore = (await fixture.store.listEvents(fixture.roomId)).length;
    const requestMembershipChange = requireRequestMembershipChange(fixture.store);

    await expect(requestMembershipChange(
      {
        roomId: fixture.roomId,
        changeId: "change-impersonate-reviewer-session",
        idempotencyKey: "membership:impersonate-reviewer-session",
        expectedAggregateVersion: fixture.aggregate.room.aggregateVersion,
        expectedMembershipVersion: fixture.aggregate.membershipVersion,
        activateAt: "next_turn_boundary",
        mutation: {
          action: "replace",
          seatId: producer.seatId,
          replacement: {
            id: `${roomId}-binding-seat-producer-generation-2`,
            connectorId: reviewer.binding.connectorId,
            providerId: reviewer.binding.providerId,
            nativeSessionId: reviewer.binding.nativeSessionId,
            happierSessionId: reviewer.binding.happierSessionId,
            serverProfileId: reviewer.binding.serverProfileId,
            machineId: reviewer.binding.machineId,
            hostId: reviewer.binding.hostId,
          },
        },
        reason: "must be rejected because this identity is already active",
        requestedAt: REQUEST_TIME,
      },
      commandContext("event-change-impersonate-reviewer-session", REQUEST_TIME),
    )).rejects.toMatchObject({ code: "binding_identity_conflict" });

    expect(await fixture.store.getRoom(fixture.roomId)).toEqual(before);
    expect(await fixture.layer.db
      .select()
      .from(roomBindings)
      .where(eq(roomBindings.roomId, fixture.roomId))).toHaveLength(2);
    expect(await fixture.layer.db
      .select()
      .from(roomMembershipChanges)
      .where(eq(roomMembershipChanges.roomId, fixture.roomId))).toHaveLength(0);
    expect(await fixture.store.listEvents(fixture.roomId)).toHaveLength(eventCountBefore);
  });

  it("rejects cross-project duplicate native and Happier identity reservations", async () => {
    const sharedNativeSessionId = "shared-cross-project-native-session";
    const sharedHappierSessionId = `happier-${sharedNativeSessionId}`;
    const sourceProjectId = `${PROJECT_ID}-source`;
    const targetProjectId = `${PROJECT_ID}-target`;
    const sourceFixture = await createActiveTurnFixture(
      "room-membership-cross-project-source",
      [
        seedParticipant(
          "room-membership-cross-project-source-seat-producer",
          "producer",
          "claude",
          sharedNativeSessionId,
        ),
      ],
      sourceProjectId,
    );
    const targetFixture = await createActiveTurnFixture(
      "room-membership-cross-project-target",
      undefined,
      targetProjectId,
    );
    const requestMembershipChange = requireRequestMembershipChange(targetFixture.store);

    await expect(requestMembershipChange(
      {
        roomId: targetFixture.roomId,
        changeId: "change-cross-project-duplicate-binding",
        idempotencyKey: "membership:cross-project-duplicate-binding",
        expectedAggregateVersion: targetFixture.aggregate.room.aggregateVersion,
        expectedMembershipVersion: targetFixture.aggregate.membershipVersion,
        activateAt: "next_turn_boundary",
        mutation: {
          action: "add",
          seat: {
            id: `${targetFixture.roomId}-seat-reviewer`,
            role: "reviewer",
            permissionScope: ["room:message"],
          },
          binding: {
            id: `${targetFixture.roomId}-binding-reviewer-generation-1`,
            connectorId: "happier",
            providerId: "claude",
            nativeSessionId: sharedNativeSessionId,
            happierSessionId: sharedHappierSessionId,
            serverProfileId: "server-profile-1",
            machineId: `${targetFixture.roomId}-machine-reviewer`,
            hostId: "windows-host-1",
          },
        },
        reason: "must reject duplicate binding identity even when it lives in another project",
        requestedAt: REQUEST_TIME,
      },
      commandContext("event-change-cross-project-duplicate-binding", REQUEST_TIME),
    )).rejects.toMatchObject({ code: "binding_identity_conflict" });

    expect(await sourceFixture.store.getRoom(sourceFixture.roomId)).toEqual(sourceFixture.aggregate);
    expect(await targetFixture.layer.db
      .select()
      .from(roomMembershipChanges)
      .where(eq(roomMembershipChanges.roomId, targetFixture.roomId))).toHaveLength(0);
    expect(await targetFixture.store.listEvents(targetFixture.roomId)).toHaveLength(3);
  });

  it("rejects a missing-seat request before a later poisoned boundary batch can block the valid change", async () => {
    const fixture = await createActiveTurnFixture("room-membership-missing-seat-batch");
    const originalSeat = fixture.aggregate.seats[0]!;
    const requestMembershipChange = requireRequestMembershipChange(fixture.store);
    await expect(requestMembershipChange(
      {
        roomId: fixture.roomId,
        changeId: "change-missing-seat-pause",
        idempotencyKey: "membership:missing-seat-pause",
        expectedAggregateVersion: fixture.aggregate.room.aggregateVersion,
        expectedMembershipVersion: fixture.aggregate.membershipVersion,
        activateAt: "next_turn_boundary",
        mutation: { action: "pause", seatId: `${fixture.roomId}-seat-missing` },
        reason: "missing seat must fail fast",
        requestedAt: REQUEST_TIME,
      },
      commandContext("event-change-missing-seat-pause", REQUEST_TIME),
    )).rejects.toMatchObject({ code: "seat_not_found" });

    expect(await fixture.layer.db
      .select()
      .from(roomMembershipChanges)
      .where(eq(roomMembershipChanges.roomId, fixture.roomId))).toHaveLength(0);

    const validRequest = await requestMembershipChange(
      {
        roomId: fixture.roomId,
        changeId: "change-valid-pause-after-missing-seat",
        idempotencyKey: "membership:valid-pause-after-missing-seat",
        expectedAggregateVersion: fixture.aggregate.room.aggregateVersion,
        expectedMembershipVersion: fixture.aggregate.membershipVersion,
        activateAt: "next_turn_boundary",
        mutation: { action: "pause", seatId: originalSeat.id },
        reason: "legitimate boundary batch should still apply",
        requestedAt: REQUEST_TIME,
      },
      commandContext("event-change-valid-pause-after-missing-seat", REQUEST_TIME),
    );

    await fixture.layer.db.insert(roomMembershipChanges).values({
      id: "change-poison-missing-seat",
      projectId: PROJECT_ID,
      roomId: fixture.roomId,
      seatId: `${fixture.roomId}-seat-poison`,
      kind: "pause",
      payload: {},
      reason: "poisoned pending membership change",
      requestedAt: "2026-07-17T12:01:30.000Z",
      requestedBy: "operator-1",
      effectiveAfterTurnId: fixture.turnId,
      appliedAt: null,
      state: "waiting_turn_boundary",
    });

    await settleActiveTurnFixture(fixture);
    const activated = await requireApplyMembershipChangesAtTurnBoundary(fixture.store)(
      {
        roomId: fixture.roomId,
        turnId: fixture.turnId,
        expectedAggregateVersion: validRequest.room.aggregateVersion,
        expectedMembershipVersion: validRequest.membershipVersion,
        now: BOUNDARY_TIME,
      },
      commandContext("event-change-valid-pause-after-missing-seat-activated", BOUNDARY_TIME),
    );

    expect(activated.seats[0]).toMatchObject({
      id: originalSeat.id,
      state: "paused",
    });
    expect(await fixture.layer.db
      .select()
      .from(roomMembershipChanges)
      .where(eq(roomMembershipChanges.id, "change-poison-missing-seat"))).toEqual([
      expect.objectContaining({
        state: "failed",
        failedAt: BOUNDARY_TIME,
        failureCode: "missing_request_event",
      }),
    ]);
    const activation = (await fixture.store.listEvents(fixture.roomId)).find(
      (event) => event.eventType === "membership_change_activated",
    );
    expect(activation?.payload).toMatchObject({
      projectionVersion: 2,
      outcomes: [{ changeId: "change-valid-pause-after-missing-seat", status: "applied" }],
      quarantinedChangeIds: ["change-poison-missing-seat"],
    });
    expect((await new AsyncRoomCheckpointStore(fixture.layer, {
      projectId: PROJECT_ID,
    }).replayProjection(fixture.roomId)).aggregate).toEqual(activated);
  });

  it("reserves a future binding identity when the first pending add is accepted", async () => {
    const fixture = await createActiveTurnFixture("room-membership-future-identity-conflict");
    const requestMembershipChange = requireRequestMembershipChange(fixture.store);
    const sharedNativeSessionId = `${fixture.roomId}-claude-session-shared`;
    const first = await requestMembershipChange(
      {
        roomId: fixture.roomId,
        changeId: "change-add-future-reviewer-a",
        idempotencyKey: "membership:add-future-reviewer-a",
        expectedAggregateVersion: fixture.aggregate.room.aggregateVersion,
        expectedMembershipVersion: fixture.aggregate.membershipVersion,
        activateAt: "next_turn_boundary",
        mutation: {
          action: "add",
          seat: {
            id: `${fixture.roomId}-seat-reviewer-a`,
            role: "reviewer",
            permissionScope: ["room:message"],
          },
          binding: {
            id: `${fixture.roomId}-binding-reviewer-a`,
            connectorId: "happier",
            providerId: "claude",
            nativeSessionId: sharedNativeSessionId,
            happierSessionId: `happier-${sharedNativeSessionId}`,
            serverProfileId: "server-profile-1",
            machineId: `${fixture.roomId}-machine-reviewer-a`,
            hostId: "windows-host-1",
          },
        },
        reason: "reserve the future identity for reviewer A",
        requestedAt: REQUEST_TIME,
      },
      commandContext("event-add-future-reviewer-a", REQUEST_TIME),
    );

    await expect(requestMembershipChange(
      {
        roomId: fixture.roomId,
        changeId: "change-add-future-reviewer-b",
        idempotencyKey: "membership:add-future-reviewer-b",
        expectedAggregateVersion: first.room.aggregateVersion,
        expectedMembershipVersion: first.membershipVersion,
        activateAt: "next_turn_boundary",
        mutation: {
          action: "add",
          seat: {
            id: `${fixture.roomId}-seat-reviewer-b`,
            role: "reviewer",
            permissionScope: ["room:message"],
          },
          binding: {
            id: `${fixture.roomId}-binding-reviewer-b`,
            connectorId: "happier",
            providerId: "claude",
            nativeSessionId: sharedNativeSessionId,
            happierSessionId: `happier-${sharedNativeSessionId}`,
            serverProfileId: "server-profile-1",
            machineId: `${fixture.roomId}-machine-reviewer-b`,
            hostId: "windows-host-1",
          },
        },
        reason: "must not steal reviewer A's pending identity reservation",
        requestedAt: "2026-07-17T12:01:01.000Z",
      },
      commandContext("event-add-future-reviewer-b", "2026-07-17T12:01:01.000Z"),
    )).rejects.toMatchObject({ code: "binding_identity_conflict" });

    expect(await fixture.layer.db
      .select()
      .from(roomMembershipChanges)
      .where(eq(roomMembershipChanges.roomId, fixture.roomId))).toHaveLength(1);
  });

  it("admits exactly one concurrent cross-project reservation for the same Session identity", async () => {
    const sharedNativeSessionId = "shared-concurrent-native-session";
    const fixtures = await Promise.all([
      createActiveTurnFixture(
        "room-membership-concurrent-reservation-a",
        undefined,
        `${PROJECT_ID}-concurrent-a`,
      ),
      createActiveTurnFixture(
        "room-membership-concurrent-reservation-b",
        undefined,
        `${PROJECT_ID}-concurrent-b`,
      ),
    ]);
    const inputFor = (
      fixture: ActiveTurnFixture,
      suffix: string,
    ): RequestRoomMembershipChangeInput => ({
      roomId: fixture.roomId,
      changeId: `change-concurrent-reservation-${suffix}`,
      idempotencyKey: `membership:concurrent-reservation-${suffix}`,
      expectedAggregateVersion: fixture.aggregate.room.aggregateVersion,
      expectedMembershipVersion: fixture.aggregate.membershipVersion,
      activateAt: "next_turn_boundary",
      mutation: {
        action: "add",
        seat: {
          id: `${fixture.roomId}-seat-reviewer`,
          role: "reviewer",
          permissionScope: ["room:message"],
        },
        binding: {
          id: `${fixture.roomId}-binding-reviewer`,
          connectorId: "happier",
          providerId: "claude",
          nativeSessionId: sharedNativeSessionId,
          happierSessionId: `happier-${sharedNativeSessionId}`,
          serverProfileId: "server-profile-1",
          machineId: `${fixture.roomId}-machine-reviewer`,
          hostId: "windows-host-1",
        },
      },
      reason: "concurrently reserve one machine-wide Session identity",
      requestedAt: REQUEST_TIME,
    });

    const outcomes = await Promise.allSettled(fixtures.map((fixture, index) => (
      requireRequestMembershipChange(fixture.store)(
        inputFor(fixture, index === 0 ? "a" : "b"),
        commandContext(`event-concurrent-reservation-${index}`, REQUEST_TIME),
      )
    )));

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
    );
    expect(rejected?.reason).toMatchObject({ code: "binding_identity_conflict" });
    expect(await sharedLayer.db
      .select()
      .from(roomMembershipChanges)
      .where(and(
        eq(roomMembershipChanges.reservedProviderId, "claude"),
        eq(roomMembershipChanges.reservedNativeSessionId, sharedNativeSessionId),
        eq(roomMembershipChanges.state, "waiting_turn_boundary"),
      ))).toHaveLength(1);
  });

  it("quarantines an unledgered boundary row with a replayable idempotent result", async () => {
    const fixture = await createActiveTurnFixture("room-membership-unledgered-boundary-row");
    await fixture.layer.db.insert(roomMembershipChanges).values({
      id: "change-unledgered-pause",
      projectId: PROJECT_ID,
      roomId: fixture.roomId,
      seatId: fixture.aggregate.seats[0]!.id,
      kind: "pause",
      payload: {},
      reason: "simulate a row that bypassed the command/event ledger",
      requestedAt: REQUEST_TIME,
      requestedBy: "unknown-writer",
      effectiveAfterTurnId: fixture.turnId,
      appliedAt: null,
      state: "waiting_turn_boundary",
    });
    await settleActiveTurnFixture(fixture);
    const input: ApplyRoomMembershipChangesAtTurnBoundaryInput = {
      roomId: fixture.roomId,
      turnId: fixture.turnId,
      idempotencyKey: "membership:unledgered-boundary-row",
      expectedAggregateVersion: fixture.aggregate.room.aggregateVersion,
      expectedMembershipVersion: fixture.aggregate.membershipVersion,
      now: BOUNDARY_TIME,
    };
    const applyAtBoundary = requireApplyMembershipChangesAtTurnBoundary(fixture.store);

    const first = await applyAtBoundary(
      input,
      commandContext("event-unledgered-boundary-row", BOUNDARY_TIME),
    );
    const replay = await applyAtBoundary(
      input,
      commandContext("event-unledgered-boundary-row-retry", BOUNDARY_TIME),
    );

    expect(first.room.aggregateVersion).toBe(fixture.aggregate.room.aggregateVersion + 1);
    expect(first.membershipVersion).toBe(fixture.aggregate.membershipVersion);
    expect(replay).toEqual(first);
    expect(await fixture.layer.db
      .select()
      .from(roomMembershipChanges)
      .where(eq(roomMembershipChanges.id, "change-unledgered-pause"))).toEqual([
      expect.objectContaining({
        state: "failed",
        failedAt: BOUNDARY_TIME,
        failureCode: "missing_request_event",
      }),
    ]);
    const events = await fixture.store.listEvents(fixture.roomId);
    expect(events).toHaveLength(4);
    expect(events.at(-1)?.payload).toMatchObject({
      projectionVersion: 2,
      outcomes: [],
      quarantinedChangeIds: ["change-unledgered-pause"],
    });
    expect((await new AsyncRoomCheckpointStore(fixture.layer, {
      projectId: PROJECT_ID,
    }).replayProjection(fixture.roomId)).aggregate).toEqual(first);
  });

  it("rejects applying the previous turn boundary after the next turn has started", async () => {
    const fixture = await createActiveTurnFixture("room-membership-late-boundary");
    const requestMembershipChange = requireRequestMembershipChange(fixture.store);
    const requested = await requestMembershipChange(
      {
        roomId: fixture.roomId,
        changeId: "change-late-boundary-pause",
        idempotencyKey: "membership:late-boundary-pause",
        expectedAggregateVersion: fixture.aggregate.room.aggregateVersion,
        expectedMembershipVersion: fixture.aggregate.membershipVersion,
        activateAt: "next_turn_boundary",
        mutation: { action: "pause", seatId: fixture.aggregate.seats[0]!.id },
        reason: "must not interleave an old membership boundary with the next running turn",
        requestedAt: REQUEST_TIME,
      },
      commandContext("event-change-late-boundary-requested", REQUEST_TIME),
    );

    await settleActiveTurnFixture(fixture);
    const nextTurnId = `${fixture.roomId}-turn-2`;
    await fixture.layer.db.insert(roomTurns).values({
      id: nextTurnId,
      projectId: PROJECT_ID,
      roomId: fixture.roomId,
      sequence: 2,
      protocolPhaseId: "implementation",
      membershipVersion: requested.membershipVersion,
      state: "running",
      startedAt: "2026-07-17T12:02:30.000Z",
      endedAt: null,
    });
    await fixture.layer.db
      .update(operationalRooms)
      .set({ activeTurnId: nextTurnId, updatedAt: "2026-07-17T12:02:30.000Z" })
      .where(and(
        eq(operationalRooms.projectId, PROJECT_ID),
        eq(operationalRooms.id, fixture.roomId),
      ));

    await expect(requireApplyMembershipChangesAtTurnBoundary(fixture.store)(
      {
        roomId: fixture.roomId,
        turnId: fixture.turnId,
        expectedAggregateVersion: requested.room.aggregateVersion,
        expectedMembershipVersion: requested.membershipVersion,
        now: "2026-07-17T12:03:00.000Z",
      },
      commandContext("event-change-late-boundary-activated", "2026-07-17T12:03:00.000Z"),
    )).rejects.toMatchObject({ code: "turn_boundary_required" });

    await fixture.layer.db
      .update(roomTurns)
      .set({ state: "completed", endedAt: "2026-07-17T12:03:30.000Z" })
      .where(eq(roomTurns.id, nextTurnId));
    await fixture.layer.db
      .update(operationalRooms)
      .set({ activeTurnId: null, updatedAt: "2026-07-17T12:03:30.000Z" })
      .where(and(
        eq(operationalRooms.projectId, PROJECT_ID),
        eq(operationalRooms.id, fixture.roomId),
      ));
    await expect(requireApplyMembershipChangesAtTurnBoundary(fixture.store)(
      {
        roomId: fixture.roomId,
        turnId: fixture.turnId,
        expectedAggregateVersion: requested.room.aggregateVersion,
        expectedMembershipVersion: requested.membershipVersion,
        now: "2026-07-17T12:04:00.000Z",
      },
      commandContext("event-change-late-boundary-after-next-completed", "2026-07-17T12:04:00.000Z"),
    )).rejects.toMatchObject({ code: "turn_boundary_required" });
  });

  it("fails closed when expected aggregate version is stale", async () => {
    const fixture = await createActiveTurnFixture("room-membership-aggregate-conflict");
    const before = await fixture.store.getRoom(fixture.roomId);
    const eventCountBefore = (await fixture.store.listEvents(fixture.roomId)).length;
    const requestMembershipChange = requireRequestMembershipChange(fixture.store);

    await expect(requestMembershipChange(
      {
        roomId: fixture.roomId,
        changeId: "change-stale-aggregate-version",
        idempotencyKey: "membership:stale-aggregate-version",
        expectedAggregateVersion: fixture.aggregate.room.aggregateVersion - 1,
        expectedMembershipVersion: fixture.aggregate.membershipVersion,
        activateAt: "next_turn_boundary",
        mutation: { action: "pause", seatId: fixture.aggregate.seats[0]!.id },
        reason: "stale operator projection must not overwrite an intervening Room command",
        requestedAt: REQUEST_TIME,
      },
      commandContext("event-change-stale-aggregate-version", REQUEST_TIME),
    )).rejects.toMatchObject({ code: "aggregate_version_conflict" });

    expect(await fixture.store.getRoom(fixture.roomId)).toEqual(before);
    expect(await fixture.layer.db
      .select()
      .from(roomMembershipChanges)
      .where(eq(roomMembershipChanges.roomId, fixture.roomId))).toHaveLength(0);
    expect(await fixture.store.listEvents(fixture.roomId)).toHaveLength(eventCountBefore);
  });

  it("fails closed when expected membership version is stale", async () => {
    const fixture = await createActiveTurnFixture("room-membership-version-conflict");
    const before = await fixture.store.getRoom(fixture.roomId);
    const eventCountBefore = (await fixture.store.listEvents(fixture.roomId)).length;
    const requestMembershipChange = requireRequestMembershipChange(fixture.store);

    await expect(requestMembershipChange(
      {
        roomId: fixture.roomId,
        changeId: "change-stale-membership-version",
        idempotencyKey: "membership:stale-membership-version",
        expectedAggregateVersion: fixture.aggregate.room.aggregateVersion,
        expectedMembershipVersion: fixture.aggregate.membershipVersion - 1,
        activateAt: "next_turn_boundary",
        mutation: { action: "pause", seatId: fixture.aggregate.seats[0]!.id },
        reason: "stale membership view must not overwrite a newer participant set",
        requestedAt: REQUEST_TIME,
      },
      commandContext("event-change-stale-membership-version", REQUEST_TIME),
    )).rejects.toMatchObject({ code: "membership_version_conflict" });

    expect(await fixture.store.getRoom(fixture.roomId)).toEqual(before);
    expect(await fixture.layer.db
      .select()
      .from(roomMembershipChanges)
      .where(eq(roomMembershipChanges.roomId, fixture.roomId))).toHaveLength(0);
    expect(await fixture.store.listEvents(fixture.roomId)).toHaveLength(eventCountBefore);
  });
});
