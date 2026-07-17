import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";

import { AsyncRoomCheckpointStore } from "../../async-room-checkpoint-store.js";
import { AsyncRoomStore } from "../../async-room-store.js";
import {
  applyRoomProjectionEvents,
  rebuildRoomProjectionFromEvents,
} from "../../room-projection-replay.js";
import type { RoomAggregateV1 } from "../../room-domain.js";
import type { RoomEventRecordV1 } from "../../room-contracts/storage.js";
import { hashRoomValue } from "../../room-integrity.js";
import { createConnectionSetFromUrl, type PostgresConnections } from "../../postgres/connection.js";
import { createAsyncDataLayer } from "../../postgres/data-layer.js";
import { EmbeddedPostgresLifecycle } from "../../postgres/embedded-lifecycle.js";
import { applySchemaBaseline } from "../../postgres/schema-applier.js";
import {
  operationalRooms,
  roomCheckpoints,
  roomBindings,
  roomSeats,
  roomTurns,
} from "../../postgres/schema/room.js";

interface EmbeddedTestContext {
  readonly dataDir: string;
  readonly lifecycle: EmbeddedPostgresLifecycle;
  connections: PostgresConnections | null;
}

const contexts: EmbeddedTestContext[] = [];

async function startEmbeddedDatabase(): Promise<EmbeddedTestContext> {
  const dataDir = mkdtempSync(join(tmpdir(), "fusion-room-checkpoint-store-"));
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
    connections: await createConnectionSetFromUrl(backend, { poolMax: 6 }),
  } satisfies EmbeddedTestContext;
  contexts.push(context);
  await applySchemaBaseline(context.connections.migration, { pluginHooks: [] });
  return context;
}

afterEach(async () => {
  while (contexts.length > 0) {
    const context = contexts.pop();
    if (!context) continue;
    if (context.connections) {
      await context.connections.close();
      context.connections = null;
    }
    await context.lifecycle.stop();
    rmSync(context.dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function commandContext(eventId: string, occurredAt: string) {
  return {
    eventId,
    actorType: "controller" as const,
    actorId: "controller-1",
    correlationId: `correlation-${eventId}`,
    causationId: null,
    occurredAt,
  };
}

interface MembershipReplayScenario {
  readonly base: RoomAggregateV1;
  readonly requested: RoomEventRecordV1;
  readonly requestedProjection: RoomAggregateV1;
  readonly activated: RoomEventRecordV1;
  readonly activatedProjection: RoomAggregateV1;
}

interface MembershipReplayAttack {
  readonly name: string;
  readonly attack: (scenario: MembershipReplayScenario) => {
    readonly base: RoomAggregateV1;
    readonly event: RoomEventRecordV1;
  };
}

function createPureMembershipReplayScenario(): MembershipReplayScenario {
  const roomId = "room-pure-membership-replay";
  const turnId = `${roomId}-turn-2`;
  const producerSeatId = `${roomId}-seat-producer`;
  const reviewerSeatId = `${roomId}-seat-reviewer`;
  const producerBindingId = `${roomId}-binding-producer-1`;
  const reviewerBindingId = `${roomId}-binding-reviewer-1`;
  const base: RoomAggregateV1 = {
    room: {
      contractVersion: 1,
      id: roomId,
      projectId: "project-pure-membership-replay",
      objective: "Replay only causally valid membership events",
      protocolId: "implementation",
      protocolVersion: 1,
      state: "running",
      aggregateVersion: 2,
      createdAt: "2026-07-17T08:00:00.000Z",
      updatedAt: "2026-07-17T08:01:00.000Z",
    },
    membershipVersion: 1,
    activeTurnId: turnId,
    seats: [
      {
        contractVersion: 1,
        id: producerSeatId,
        roomId,
        role: "producer",
        state: "active",
        permissionScope: ["room:message"],
        activeBindingId: producerBindingId,
        roleVersion: 1,
        createdAt: "2026-07-17T08:00:00.000Z",
        updatedAt: "2026-07-17T08:00:00.000Z",
      },
      {
        contractVersion: 1,
        id: reviewerSeatId,
        roomId,
        role: "reviewer",
        state: "active",
        permissionScope: ["room:message"],
        activeBindingId: reviewerBindingId,
        roleVersion: 1,
        createdAt: "2026-07-17T08:00:00.000Z",
        updatedAt: "2026-07-17T08:00:00.000Z",
      },
    ],
    bindings: [
      {
        contractVersion: 1,
        id: producerBindingId,
        roomId,
        seatId: producerSeatId,
        generation: 1,
        connectorId: "happier",
        providerId: "codex",
        nativeSessionId: `${roomId}-codex-thread`,
        happierSessionId: `${roomId}-happier-codex-thread`,
        serverProfileId: "server-profile-1",
        machineId: `${roomId}-machine-producer`,
        hostId: "windows-host-1",
        state: "attached",
        attachedAt: "2026-07-17T08:00:00.000Z",
        detachedAt: null,
        replacedByBindingId: null,
      },
      {
        contractVersion: 1,
        id: reviewerBindingId,
        roomId,
        seatId: reviewerSeatId,
        generation: 1,
        connectorId: "happier",
        providerId: "claude",
        nativeSessionId: `${roomId}-claude-session`,
        happierSessionId: `${roomId}-happier-claude-session`,
        serverProfileId: "server-profile-1",
        machineId: `${roomId}-machine-reviewer`,
        hostId: "windows-host-1",
        state: "attached",
        attachedAt: "2026-07-17T08:00:00.000Z",
        detachedAt: null,
        replacedByBindingId: null,
      },
    ],
    turns: [
      {
        contractVersion: 1,
        id: `${roomId}-turn-1`,
        roomId,
        sequence: 1,
        protocolPhaseId: "planning",
        membershipVersion: 1,
        state: "completed",
        startedAt: "2026-07-17T08:00:00.000Z",
        endedAt: "2026-07-17T08:00:30.000Z",
      },
      {
        contractVersion: 1,
        id: turnId,
        roomId,
        sequence: 2,
        protocolPhaseId: "implementation",
        membershipVersion: 1,
        state: "running",
        startedAt: "2026-07-17T08:01:00.000Z",
        endedAt: null,
      },
    ],
    pendingMembershipChanges: [],
  };
  const pending = {
    id: "change-pause-producer",
    roomId,
    seatId: producerSeatId,
    kind: "pause" as const,
    reason: "pause the producer at the durable turn boundary",
    effectiveAfterTurnId: turnId,
    requestedAt: "2026-07-17T08:02:00.000Z",
    state: "waiting_turn_boundary" as const,
  };
  const requestedProjection: RoomAggregateV1 = {
    ...base,
    room: {
      ...base.room,
      aggregateVersion: 3,
      updatedAt: pending.requestedAt,
    },
    pendingMembershipChanges: [pending],
  };
  const requestedPayload = {
    projectionVersion: 1,
    changeId: pending.id,
    changeKind: pending.kind,
    effectiveAfterTurnId: turnId,
    projection: requestedProjection,
    projectionHash: hashRoomValue(requestedProjection),
    updatedAt: pending.requestedAt,
  };
  const requested: RoomEventRecordV1 = {
    contractVersion: 1,
    id: "event-pure-membership-requested",
    roomId,
    projectId: base.room.projectId,
    aggregateVersion: 3,
    eventType: "membership_change_requested",
    actorType: "controller",
    actorId: "controller-1",
    correlationId: "correlation-pure-membership-requested",
    causationId: null,
    payload: requestedPayload,
    occurredAt: pending.requestedAt,
    cursor: "4",
  };
  const boundaryAt = "2026-07-17T08:03:00.000Z";
  const activatedProjection: RoomAggregateV1 = {
    ...requestedProjection,
    room: {
      ...requestedProjection.room,
      aggregateVersion: 4,
      updatedAt: boundaryAt,
    },
    membershipVersion: 2,
    activeTurnId: null,
    seats: requestedProjection.seats.map((seat) => seat.id === producerSeatId
      ? { ...seat, state: "paused" as const, updatedAt: boundaryAt }
      : seat),
    bindings: requestedProjection.bindings.map((binding) => binding.id === producerBindingId
      ? { ...binding, state: "paused" as const }
      : binding),
    turns: requestedProjection.turns.map((turn) => turn.id === turnId
      ? { ...turn, state: "completed" as const, endedAt: boundaryAt }
      : turn),
    pendingMembershipChanges: [],
  };
  const activated: RoomEventRecordV1 = {
    ...requested,
    id: "event-pure-membership-activated",
    aggregateVersion: 4,
    eventType: "membership_change_activated",
    correlationId: "correlation-pure-membership-activated",
    payload: {
      projectionVersion: 1,
      turnId,
      changeIds: [pending.id],
      membershipVersion: 2,
      projection: activatedProjection,
      projectionHash: hashRoomValue(activatedProjection),
      updatedAt: boundaryAt,
    },
    occurredAt: boundaryAt,
    cursor: "5",
  };
  return { base, requested, requestedProjection, activated, activatedProjection };
}

function asMutableRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected mutable test record");
  }
  return value as Record<string, unknown>;
}

function asMutableArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Expected mutable test array");
  return value;
}

function projectionOf(payload: Record<string, unknown>): Record<string, unknown> {
  return asMutableRecord(payload.projection);
}

function pendingOf(projection: Record<string, unknown>, index = 0): Record<string, unknown> {
  return asMutableRecord(asMutableArray(projection.pendingMembershipChanges)[index]);
}

function cloneEventWithPayload(
  event: RoomEventRecordV1,
  mutate: (payload: Record<string, unknown>) => void,
): RoomEventRecordV1 {
  const payload = structuredClone(event.payload) as Record<string, unknown>;
  mutate(payload);
  return { ...event, payload };
}

function cloneEventWithProjection(
  event: RoomEventRecordV1,
  mutate: (projection: Record<string, unknown>, payload: Record<string, unknown>) => void,
): RoomEventRecordV1 {
  return cloneEventWithPayload(event, (payload) => {
    const projection = projectionOf(payload);
    mutate(projection, payload);
    payload.projectionHash = hashRoomValue(projection);
  });
}

function replacePendingChange(
  event: RoomEventRecordV1,
  mutate: (pending: Record<string, unknown>) => void,
): RoomEventRecordV1 {
  return cloneEventWithProjection(event, (projection, payload) => {
    const pending = pendingOf(projection);
    pending.kind = "replace";
    pending.replacement = {
      id: "room-pure-membership-replay-binding-producer-2",
      connectorId: "happier",
      providerId: "opencode",
      nativeSessionId: "room-pure-membership-replay-opencode-session",
      happierSessionId: "room-pure-membership-replay-happier-opencode-session",
      serverProfileId: "server-profile-2",
      machineId: "room-pure-membership-replay-machine-replacement",
      hostId: "windows-host-2",
    };
    payload.changeKind = "replace";
    mutate(pending);
  });
}

async function createMembershipReplayFixture() {
  const context = await startEmbeddedDatabase();
  const projectId = "project-replay-membership-drift";
  const roomId = "room-replay-membership-drift";
  const layer = createAsyncDataLayer(context.connections!, { projectId });
  const roomStore = new AsyncRoomStore(layer, { projectId });
  const checkpointStore = new AsyncRoomCheckpointStore(layer);
  const producerBindingId = `${roomId}-binding-producer-generation-1`;
  const reviewerBindingId = `${roomId}-binding-reviewer-generation-1`;
  const producerNativeSessionId = `${roomId}-codex-thread-active`;
  const reviewerNativeSessionId = `${roomId}-claude-session-active`;

  await roomStore.createRoom(
    {
      id: roomId,
      projectId,
      objective: "Replay only the durable room semantics",
      protocolId: "implementation",
      protocolVersion: 1,
      now: "2026-07-17T09:00:00.000Z",
    },
    commandContext("event-replay-membership-created", "2026-07-17T09:00:00.000Z"),
  );
  await layer.db.insert(roomSeats).values([
    {
      id: `${roomId}-seat-producer`,
      projectId,
      roomId,
      role: "producer",
      roleVersion: 1,
      roleHistory: [],
      permissionScope: ["room:message"],
      state: "active",
      activeBindingId: producerBindingId,
      createdAt: "2026-07-17T09:00:00.000Z",
      updatedAt: "2026-07-17T09:00:00.000Z",
    },
    {
      id: `${roomId}-seat-reviewer`,
      projectId,
      roomId,
      role: "reviewer",
      roleVersion: 1,
      roleHistory: [],
      permissionScope: ["room:message"],
      state: "active",
      activeBindingId: reviewerBindingId,
      createdAt: "2026-07-17T09:00:00.000Z",
      updatedAt: "2026-07-17T09:00:00.000Z",
    },
  ]);
  await layer.db.insert(roomBindings).values([
    {
      id: producerBindingId,
      projectId,
      roomId,
      seatId: `${roomId}-seat-producer`,
      generation: 1,
      connectorId: "happier",
      providerId: "codex",
      nativeSessionId: producerNativeSessionId,
      happierSessionId: `happier-${producerNativeSessionId}`,
      serverProfileId: "server-profile-1",
      machineId: `${roomId}-machine-producer`,
      hostId: "windows-host-1",
      state: "attached",
      attachedAt: "2026-07-17T09:00:00.000Z",
      detachedAt: null,
      replacedByBindingId: null,
      replacementReason: null,
    },
    {
      id: reviewerBindingId,
      projectId,
      roomId,
      seatId: `${roomId}-seat-reviewer`,
      generation: 1,
      connectorId: "happier",
      providerId: "claude",
      nativeSessionId: reviewerNativeSessionId,
      happierSessionId: `happier-${reviewerNativeSessionId}`,
      serverProfileId: "server-profile-1",
      machineId: `${roomId}-machine-reviewer`,
      hostId: "windows-host-1",
      state: "attached",
      attachedAt: "2026-07-17T09:00:00.000Z",
      detachedAt: null,
      replacedByBindingId: null,
      replacementReason: null,
    },
  ]);
  await layer.db
    .update(operationalRooms)
    .set({ membershipVersion: 1 })
    .where(
      and(
        eq(operationalRooms.projectId, projectId),
        eq(operationalRooms.id, roomId),
      ),
    );
  await roomStore.transitionLifecycle(
    roomId,
    { to: "ready", expectedAggregateVersion: 0, now: "2026-07-17T09:00:00.000Z" },
    commandContext("event-replay-membership-ready", "2026-07-17T09:00:00.000Z"),
  );
  const running = await roomStore.transitionLifecycle(
    roomId,
    { to: "running", expectedAggregateVersion: 1, now: "2026-07-17T09:00:00.000Z" },
    commandContext("event-replay-membership-running", "2026-07-17T09:00:00.000Z"),
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
    startedAt: "2026-07-17T09:00:00.000Z",
    endedAt: null,
  });
  await layer.db
    .update(operationalRooms)
    .set({ activeTurnId: turnId, updatedAt: "2026-07-17T09:00:00.000Z" })
    .where(
      and(
        eq(operationalRooms.projectId, projectId),
        eq(operationalRooms.id, roomId),
      ),
    );
  await checkpointStore.createCheckpoint({
    id: `${roomId}-checkpoint`,
    roomId,
    turnId,
    expectedAggregateVersion: running.room.aggregateVersion,
    protocolState: {},
    dagVersion: 0,
    bindingCursors: {},
    artifactRefs: [],
    now: "2026-07-17T09:00:30.000Z",
  });

  const requested = await roomStore.requestMembershipChange(
    {
      roomId,
      changeId: "change-replay-membership-pause",
      idempotencyKey: "membership:replay-membership-pause",
      expectedAggregateVersion: running.room.aggregateVersion,
      expectedMembershipVersion: running.membershipVersion,
      activateAt: "next_turn_boundary",
      mutation: { action: "pause", seatId: `${roomId}-seat-producer` },
      reason: "replay should reject a payload that sneaks in unrelated room drift",
      requestedAt: "2026-07-17T09:01:00.000Z",
    },
    commandContext("event-replay-membership-requested", "2026-07-17T09:01:00.000Z"),
  );
  await layer.db
    .update(roomTurns)
    .set({ state: "completed", endedAt: "2026-07-17T09:02:00.000Z" })
    .where(
      and(
        eq(roomTurns.projectId, projectId),
        eq(roomTurns.roomId, roomId),
        eq(roomTurns.id, turnId),
      ),
    );
  await layer.db
    .update(operationalRooms)
    .set({ activeTurnId: null, updatedAt: "2026-07-17T09:02:00.000Z" })
    .where(
      and(
        eq(operationalRooms.projectId, projectId),
        eq(operationalRooms.id, roomId),
      ),
    );
  const activated = await roomStore.applyMembershipChangesAtTurnBoundary(
    {
      roomId,
      turnId,
      expectedAggregateVersion: requested.room.aggregateVersion,
      expectedMembershipVersion: requested.membershipVersion,
      now: "2026-07-17T09:02:00.000Z",
    },
    commandContext("event-replay-membership-activated", "2026-07-17T09:02:00.000Z"),
  );

  return { layer, roomStore, checkpointStore, roomId, turnId, requested, activated };
}

describe("Session Room checkpoints and projection replay", () => {
  it("rebuilds the complete Room projection from contiguous append-only events", async () => {
    const context = await startEmbeddedDatabase();
    const layer = createAsyncDataLayer(context.connections!, { projectId: "project-1" });
    const roomStore = new AsyncRoomStore(layer);
    await roomStore.createRoom(
      {
        id: "room-replay-1",
        projectId: "project-1",
        objective: "Rebuild only from durable events",
        protocolId: "implementation",
        protocolVersion: 1,
        now: "2026-07-17T07:00:00.000Z",
      },
      commandContext("event-replay-created", "2026-07-17T07:00:00.000Z"),
    );
    await roomStore.transitionLifecycle(
      "room-replay-1",
      { to: "ready", expectedAggregateVersion: 0, now: "2026-07-17T07:01:00.000Z" },
      commandContext("event-replay-ready", "2026-07-17T07:01:00.000Z"),
    );
    await roomStore.transitionLifecycle(
      "room-replay-1",
      { to: "running", expectedAggregateVersion: 1, now: "2026-07-17T07:02:00.000Z" },
      commandContext("event-replay-running", "2026-07-17T07:02:00.000Z"),
    );

    const events = await roomStore.listEvents("room-replay-1");
    expect(events.map((event) => event.aggregateVersion)).toEqual([0, 1, 2]);
    expect(rebuildRoomProjectionFromEvents(events)).toEqual(
      await roomStore.getRoom("room-replay-1"),
    );
    expect(() => rebuildRoomProjectionFromEvents([events[0]!, events[2]!])).toThrow(
      /contiguous.*version/i,
    );
  });

  it("creates a turn checkpoint, replays later events, and rejects a tampered snapshot", async () => {
    const context = await startEmbeddedDatabase();
    const layer = createAsyncDataLayer(context.connections!, { projectId: "project-1" });
    const roomStore = new AsyncRoomStore(layer);
    const checkpointStore = new AsyncRoomCheckpointStore(layer);
    await roomStore.createRoom(
      {
        id: "room-checkpoint-1",
        projectId: "project-1",
        objective: "Resume from a durable turn boundary",
        protocolId: "implementation",
        protocolVersion: 1,
        now: "2026-07-17T08:00:00.000Z",
      },
      commandContext("event-checkpoint-created", "2026-07-17T08:00:00.000Z"),
    );
    await roomStore.transitionLifecycle(
      "room-checkpoint-1",
      { to: "ready", expectedAggregateVersion: 0, now: "2026-07-17T08:01:00.000Z" },
      commandContext("event-checkpoint-ready", "2026-07-17T08:01:00.000Z"),
    );
    await layer.db.insert(roomTurns).values({
      id: "turn-checkpoint-1",
      projectId: "project-1",
      roomId: "room-checkpoint-1",
      sequence: 1,
      protocolPhaseId: "implementation.prepare",
      membershipVersion: 0,
      state: "waiting",
      startedAt: "2026-07-17T08:01:00.000Z",
      endedAt: null,
    });
    await layer.db
      .update(operationalRooms)
      .set({ activeTurnId: "turn-checkpoint-1" })
      .where(
        and(
          eq(operationalRooms.projectId, "project-1"),
          eq(operationalRooms.id, "room-checkpoint-1"),
        ),
      );

    const checkpoint = await checkpointStore.createCheckpoint({
      id: "checkpoint-turn-1",
      roomId: "room-checkpoint-1",
      turnId: "turn-checkpoint-1",
      expectedAggregateVersion: 1,
      protocolState: { phaseId: "implementation.prepare", pendingQuestions: [] },
      dagVersion: 0,
      bindingCursors: {},
      artifactRefs: [],
      now: "2026-07-17T08:01:30.000Z",
    });
    expect(checkpoint).toMatchObject({
      id: "checkpoint-turn-1",
      roomId: "room-checkpoint-1",
      turnId: "turn-checkpoint-1",
      aggregateVersion: 1,
      dagVersion: 0,
      pendingOutboxIds: [],
    });
    expect(checkpoint.projectionHash).toMatch(/^sha256:/);
    expect(Number(checkpoint.eventCursor)).toBeGreaterThan(0);

    await roomStore.transitionLifecycle(
      "room-checkpoint-1",
      { to: "running", expectedAggregateVersion: 1, now: "2026-07-17T08:02:00.000Z" },
      commandContext("event-checkpoint-running", "2026-07-17T08:02:00.000Z"),
    );
    const replayed = await checkpointStore.replayProjection("room-checkpoint-1");
    expect(replayed).toMatchObject({
      checkpointId: "checkpoint-turn-1",
      replayedEventCount: 1,
      aggregate: { room: { state: "running", aggregateVersion: 2 } },
    });
    expect(replayed.aggregate).toEqual(await roomStore.getRoom("room-checkpoint-1"));
    expect(replayed.aggregate.turns.map((turn) => turn.id)).toEqual(["turn-checkpoint-1"]);

    await layer.db
      .update(roomCheckpoints)
      .set({ projection: { tampered: true } })
      .where(
        and(
          eq(roomCheckpoints.projectId, "project-1"),
          eq(roomCheckpoints.id, "checkpoint-turn-1"),
        ),
      );
    await expect(checkpointStore.replayProjection("room-checkpoint-1")).rejects.toThrow(
      /checkpoint.*hash/i,
    );
  });

  it("replays an unmodified production request, settled turn, and membership activation", async () => {
    const fixture = await createMembershipReplayFixture();
    const eventsBeforeReplay = await fixture.roomStore.listEvents(fixture.roomId);

    expect(eventsBeforeReplay.map((event) => event.eventType)).toEqual([
      "room_created",
      "room_lifecycle_transitioned",
      "room_lifecycle_transitioned",
      "membership_change_requested",
      "membership_change_activated",
    ]);
    expect(fixture.requested.activeTurnId).toBe(fixture.turnId);
    expect(fixture.activated.activeTurnId).toBeNull();
    expect(fixture.activated.turns).toContainEqual(expect.objectContaining({
      id: fixture.turnId,
      state: "completed",
      endedAt: "2026-07-17T09:02:00.000Z",
    }));

    const replayed = await fixture.checkpointStore.replayProjection(fixture.roomId);

    expect(replayed.aggregate).toEqual(fixture.activated);
    expect(await fixture.roomStore.listEvents(fixture.roomId)).toEqual(eventsBeforeReplay);

    const activation = structuredClone(eventsBeforeReplay.at(-1)!);
    const beforeActivation = fixture.requested;
    const falseFailure = structuredClone(activation);
    const falseFailurePayload = falseFailure.payload as Record<string, unknown>;
    const falseFailureOutcomes = falseFailurePayload.outcomes as Array<Record<string, unknown>>;
    falseFailureOutcomes[0] = {
      changeId: falseFailureOutcomes[0]!.changeId,
      status: "failed",
      failureCode: "seat_not_found",
    };
    expect(() => applyRoomProjectionEvents(beforeActivation, [falseFailure])).toThrow(
      /falsely failed|invalid failed outcome/iu,
    );

    const smuggledProjection = cloneEventWithProjection(activation, (projection) => {
      const room = projection.room as Record<string, unknown>;
      room.objective = "smuggled unrelated objective";
    });
    expect(() => applyRoomProjectionEvents(beforeActivation, [smuggledProjection])).toThrow(
      /exact version-2 boundary delta/iu,
    );
  }, 60000);

  it("accepts only the exact target-turn boundary transition during membership activation", () => {
    const scenario = createPureMembershipReplayScenario();

    expect(applyRoomProjectionEvents(scenario.base, [
      scenario.requested,
      scenario.activated,
    ])).toEqual(scenario.activatedProjection);
  });

  const requestAttacks: readonly MembershipReplayAttack[] = [
    {
      name: "null effectiveAfterTurnId",
      attack: (scenario) => ({
        base: scenario.base,
        event: cloneEventWithProjection(scenario.requested, (projection, payload) => {
          payload.effectiveAfterTurnId = null;
          pendingOf(projection).effectiveAfterTurnId = null;
        }),
      }),
    },
    {
      name: "wrong effectiveAfterTurnId",
      attack: (scenario) => ({
        base: scenario.base,
        event: cloneEventWithProjection(scenario.requested, (projection, payload) => {
          const wrongTurnId = `${scenario.base.room.id}-turn-99`;
          payload.effectiveAfterTurnId = wrongTurnId;
          pendingOf(projection).effectiveAfterTurnId = wrongTurnId;
        }),
      }),
    },
    {
      name: "duplicate changeId",
      attack: (scenario) => {
        const existing = structuredClone(
          pendingOf(projectionOf(structuredClone(scenario.requested.payload) as Record<string, unknown>)),
        );
        existing.seatId = `${scenario.base.room.id}-seat-reviewer`;
        existing.reason = "existing reviewer pause";
        const baseRecord = structuredClone(scenario.base) as unknown as Record<string, unknown>;
        baseRecord.pendingMembershipChanges = [existing];
        return {
          base: baseRecord as unknown as RoomAggregateV1,
          event: cloneEventWithProjection(scenario.requested, (projection) => {
            projection.pendingMembershipChanges = [
              structuredClone(existing),
              structuredClone(pendingOf(projection)),
            ];
          }),
        };
      },
    },
    {
      name: "missing reason",
      attack: (scenario) => ({
        base: scenario.base,
        event: cloneEventWithProjection(scenario.requested, (projection) => {
          delete pendingOf(projection).reason;
        }),
      }),
    },
    {
      name: "blank reason",
      attack: (scenario) => ({
        base: scenario.base,
        event: cloneEventWithProjection(scenario.requested, (projection) => {
          pendingOf(projection).reason = "   ";
        }),
      }),
    },
    {
      name: "extra event payload root field",
      attack: (scenario) => ({
        base: scenario.base,
        event: cloneEventWithPayload(scenario.requested, (payload) => {
          payload.unexpected = true;
        }),
      }),
    },
    {
      name: "extra projection aggregate field",
      attack: (scenario) => ({
        base: scenario.base,
        event: cloneEventWithProjection(scenario.requested, (projection) => {
          projection.unexpected = true;
        }),
      }),
    },
    {
      name: "extra pending field",
      attack: (scenario) => ({
        base: scenario.base,
        event: cloneEventWithProjection(scenario.requested, (projection) => {
          pendingOf(projection).unexpected = true;
        }),
      }),
    },
    {
      name: "extra nested add seat field",
      attack: (scenario) => ({
        base: scenario.base,
        event: cloneEventWithProjection(scenario.requested, (projection, payload) => {
          const pending = pendingOf(projection);
          const seatId = `${scenario.base.room.id}-seat-observer`;
          pending.kind = "add";
          pending.seatId = seatId;
          pending.seat = {
            id: seatId,
            role: "observer",
            permissionScope: ["room:message"],
            unexpected: true,
          };
          pending.binding = {
            id: `${scenario.base.room.id}-binding-observer-1`,
            connectorId: "happier",
            providerId: "claude",
            nativeSessionId: `${scenario.base.room.id}-observer-session`,
            happierSessionId: `${scenario.base.room.id}-happier-observer-session`,
            serverProfileId: "server-profile-1",
            machineId: `${scenario.base.room.id}-machine-observer`,
            hostId: "windows-host-1",
          };
          payload.changeKind = "add";
        }),
      }),
    },
    {
      name: "extra nested add binding field",
      attack: (scenario) => ({
        base: scenario.base,
        event: cloneEventWithProjection(scenario.requested, (projection, payload) => {
          const pending = pendingOf(projection);
          const seatId = `${scenario.base.room.id}-seat-observer`;
          pending.kind = "add";
          pending.seatId = seatId;
          pending.seat = {
            id: seatId,
            role: "observer",
            permissionScope: ["room:message"],
          };
          pending.binding = {
            id: `${scenario.base.room.id}-binding-observer-1`,
            connectorId: "happier",
            providerId: "claude",
            nativeSessionId: `${scenario.base.room.id}-observer-session`,
            happierSessionId: `${scenario.base.room.id}-happier-observer-session`,
            serverProfileId: "server-profile-1",
            machineId: `${scenario.base.room.id}-machine-observer`,
            hostId: "windows-host-1",
            unexpected: true,
          };
          payload.changeKind = "add";
        }),
      }),
    },
    {
      name: "replace missing replacement",
      attack: (scenario) => ({
        base: scenario.base,
        event: replacePendingChange(scenario.requested, (pending) => {
          delete pending.replacement;
        }),
      }),
    },
    {
      name: "replace payload hidden in binding",
      attack: (scenario) => ({
        base: scenario.base,
        event: replacePendingChange(scenario.requested, (pending) => {
          pending.binding = pending.replacement;
          delete pending.replacement;
        }),
      }),
    },
    {
      name: "replace replacement missing hostId",
      attack: (scenario) => ({
        base: scenario.base,
        event: replacePendingChange(scenario.requested, (pending) => {
          delete asMutableRecord(pending.replacement).hostId;
        }),
      }),
    },
    {
      name: "extra nested replacement field",
      attack: (scenario) => ({
        base: scenario.base,
        event: replacePendingChange(scenario.requested, (pending) => {
          asMutableRecord(pending.replacement).unexpected = true;
        }),
      }),
    },
    {
      name: "objective drift",
      attack: (scenario) => ({
        base: scenario.base,
        event: cloneEventWithProjection(scenario.requested, (projection) => {
          asMutableRecord(projection.room).objective = "smuggled objective";
        }),
      }),
    },
    {
      name: "lifecycle drift",
      attack: (scenario) => ({
        base: scenario.base,
        event: cloneEventWithProjection(scenario.requested, (projection) => {
          asMutableRecord(projection.room).state = "paused";
        }),
      }),
    },
    {
      name: "protocol drift",
      attack: (scenario) => ({
        base: scenario.base,
        event: cloneEventWithProjection(scenario.requested, (projection) => {
          asMutableRecord(projection.room).protocolId = "review";
        }),
      }),
    },
    {
      name: "root activeTurnId drift",
      attack: (scenario) => ({
        base: scenario.base,
        event: cloneEventWithProjection(scenario.requested, (projection) => {
          projection.activeTurnId = `${scenario.base.room.id}-turn-99`;
        }),
      }),
    },
    {
      name: "turn drift",
      attack: (scenario) => ({
        base: scenario.base,
        event: cloneEventWithProjection(scenario.requested, (projection) => {
          asMutableRecord(asMutableArray(projection.turns)[1]).protocolPhaseId = "review";
        }),
      }),
    },
    {
      name: "seat drift",
      attack: (scenario) => ({
        base: scenario.base,
        event: cloneEventWithProjection(scenario.requested, (projection) => {
          asMutableRecord(asMutableArray(projection.seats)[1]).state = "removed";
        }),
      }),
    },
    {
      name: "binding drift",
      attack: (scenario) => ({
        base: scenario.base,
        event: cloneEventWithProjection(scenario.requested, (projection) => {
          asMutableRecord(asMutableArray(projection.bindings)[1]).state = "paused";
        }),
      }),
    },
  ];

  it.each(requestAttacks)(
    "rejects membership_change_requested attack: $name",
    ({ attack }) => {
      const scenario = createPureMembershipReplayScenario();
      const attacked = attack(scenario);

      expect(() => applyRoomProjectionEvents(attacked.base, [attacked.event])).toThrow(
        /membership|projection|payload/i,
      );
    },
  );

  const activationAttacks: readonly MembershipReplayAttack[] = [
    {
      name: "objective drift",
      attack: (scenario) => ({
        base: scenario.requestedProjection,
        event: cloneEventWithProjection(scenario.activated, (projection) => {
          asMutableRecord(projection.room).objective = "smuggled objective";
        }),
      }),
    },
    {
      name: "lifecycle drift",
      attack: (scenario) => ({
        base: scenario.requestedProjection,
        event: cloneEventWithProjection(scenario.activated, (projection) => {
          asMutableRecord(projection.room).state = "paused";
        }),
      }),
    },
    {
      name: "protocol drift",
      attack: (scenario) => ({
        base: scenario.requestedProjection,
        event: cloneEventWithProjection(scenario.activated, (projection) => {
          asMutableRecord(projection.room).protocolVersion = 2;
        }),
      }),
    },
    {
      name: "root activeTurnId drift",
      attack: (scenario) => ({
        base: scenario.requestedProjection,
        event: cloneEventWithProjection(scenario.activated, (projection) => {
          projection.activeTurnId = `${scenario.base.room.id}-turn-99`;
        }),
      }),
    },
    {
      name: "target turn non-state drift",
      attack: (scenario) => ({
        base: scenario.requestedProjection,
        event: cloneEventWithProjection(scenario.activated, (projection) => {
          asMutableRecord(asMutableArray(projection.turns)[1]).protocolPhaseId = "review";
        }),
      }),
    },
    {
      name: "target turn does not settle",
      attack: (scenario) => ({
        base: scenario.requestedProjection,
        event: cloneEventWithProjection(scenario.activated, (projection) => {
          asMutableRecord(asMutableArray(projection.turns)[1]).state = "waiting";
        }),
      }),
    },
    {
      name: "target turn lacks endedAt",
      attack: (scenario) => ({
        base: scenario.requestedProjection,
        event: cloneEventWithProjection(scenario.activated, (projection) => {
          asMutableRecord(asMutableArray(projection.turns)[1]).endedAt = null;
        }),
      }),
    },
    {
      name: "unrelated turn drift",
      attack: (scenario) => ({
        base: scenario.requestedProjection,
        event: cloneEventWithProjection(scenario.activated, (projection) => {
          asMutableRecord(asMutableArray(projection.turns)[0]).state = "cancelled";
        }),
      }),
    },
    {
      name: "unrelated seat drift",
      attack: (scenario) => ({
        base: scenario.requestedProjection,
        event: cloneEventWithProjection(scenario.activated, (projection) => {
          asMutableRecord(asMutableArray(projection.seats)[1]).state = "paused";
        }),
      }),
    },
    {
      name: "unrelated binding drift",
      attack: (scenario) => ({
        base: scenario.requestedProjection,
        event: cloneEventWithProjection(scenario.activated, (projection) => {
          asMutableRecord(asMutableArray(projection.bindings)[1]).state = "paused";
        }),
      }),
    },
  ];

  it.each(activationAttacks)(
    "rejects membership_change_activated attack: $name",
    ({ attack }) => {
      const scenario = createPureMembershipReplayScenario();
      const attacked = attack(scenario);

      expect(() => applyRoomProjectionEvents(attacked.base, [attacked.event])).toThrow(
        /membership|projection|payload/i,
      );
    },
  );

});
