import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";

import {
  AsyncRoomStore,
  type DurableRoomMessageTargetV1,
  type RouteOperatorMessageResultV1,
  type RoomCommittedEventListener,
  type StoredRoutedOperatorMessageV1,
} from "../../async-room-store.js";
import { createConnectionSetFromUrl, type PostgresConnections } from "../../postgres/connection.js";
import { createAsyncDataLayer, type AsyncDataLayer } from "../../postgres/data-layer.js";
import { EmbeddedPostgresLifecycle } from "../../postgres/embedded-lifecycle.js";
import { applySchemaBaseline } from "../../postgres/schema-applier.js";
import {
  roomBindings,
  roomIdempotencyKeys,
  roomMessages,
  roomOutbox,
  roomSeats,
} from "../../postgres/schema/room.js";
import type {
  RoomAuthorityEnvelopeV1,
  RoomControllerCommandEnvelopeV1,
  RoomMessageTargetV1,
} from "../../room-contracts/controller.js";
import { hashRoomValue } from "../../room-integrity.js";

interface EmbeddedTestContext {
  readonly dataDir: string;
  readonly lifecycle: EmbeddedPostgresLifecycle;
  connections: PostgresConnections | null;
}

/*
FNXC:SessionRoomMessageRouting 2026-07-17-20:31:
Task 4.4 requires one transactional backend command that resolves controller, all, durable group, and explicit-seat selectors at commit time. The command must authenticate the structured authority envelope, freeze explicit target records with binding lineage, retain idempotency and expected-version provenance, fail closed before partial writes, and commit independently of browser listeners.

The retained RED initially asserted this missing production seam through a local interface. The GREEN suite now imports the canonical exported result/target/message contracts so later type drift fails at this boundary.
*/
interface ExpectedRoomMessageRoutingStore {
  routeOperatorMessage(
    envelope: RoomControllerCommandEnvelopeV1,
  ): Promise<RouteOperatorMessageResultV1>;
  getRoutedMessage(messageId: string): Promise<StoredRoutedOperatorMessageV1 | null>;
  listMessageTargets(messageId: string): Promise<readonly DurableRoomMessageTargetV1[]>;
}

interface RoutingFixture {
  readonly layer: AsyncDataLayer;
  readonly store: AsyncRoomStore;
  readonly roomId: string;
}

const PROJECT_ID = "project-room-routing";
const ROOM_ID = "room-routing-1";
const CREATED_AT = "2026-07-17T12:00:00.000Z";
let sharedContext: EmbeddedTestContext | null = null;
let sharedLayer: AsyncDataLayer | null = null;

const seatFixtures = [
  { id: "seat-implementer", role: "implementer", bindingId: "binding-implementer", providerId: "codex" },
  { id: "seat-reviewer-a", role: "reviewer", bindingId: "binding-reviewer-a", providerId: "claude" },
  { id: "seat-reviewer-b", role: "reviewer", bindingId: "binding-reviewer-b", providerId: "opencode" },
] as const;

async function startEmbeddedDatabase(): Promise<EmbeddedTestContext> {
  const dataDir = mkdtempSync(join(tmpdir(), "fusion-room-message-routing-"));
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

beforeAll(async () => {
  sharedContext = await startEmbeddedDatabase();
  sharedLayer = createAsyncDataLayer(sharedContext.connections!, { projectId: PROJECT_ID });
}, 60_000);

beforeEach(async () => {
  if (!sharedLayer) throw new Error("Room routing PostgreSQL fixture was not started");
  await sharedLayer.db.execute(sql.raw("TRUNCATE TABLE project.operational_rooms RESTART IDENTITY CASCADE"));
});

afterAll(async () => {
  const context = sharedContext;
  sharedContext = null;
  sharedLayer = null;
  if (!context) return;
  if (context.connections) {
    await context.connections.close();
    context.connections = null;
  }
  await context.lifecycle.stop();
  rmSync(context.dataDir, { recursive: true, force: true });
}, 60_000);

async function createRoutingFixture(
  onCommittedEvent?: RoomCommittedEventListener,
): Promise<RoutingFixture> {
  if (!sharedLayer) throw new Error("Room routing PostgreSQL fixture was not started");
  const layer = sharedLayer;
  const store = new AsyncRoomStore(layer, { onCommittedEvent });
  await store.createRoom(
    {
      id: ROOM_ID,
      projectId: PROJECT_ID,
      objective: "Route operator messages durably",
      protocolId: "implementation",
      protocolVersion: 1,
      now: CREATED_AT,
    },
    {
      eventId: "event-room-routing-created",
      actorType: "human",
      actorId: "operator-1",
      correlationId: "correlation-room-routing-created",
      causationId: null,
      occurredAt: CREATED_AT,
    },
  );

  await layer.db.insert(roomSeats).values(seatFixtures.map((seat) => ({
    id: seat.id,
    projectId: PROJECT_ID,
    roomId: ROOM_ID,
    role: seat.role,
    roleVersion: 1,
    roleHistory: [],
    permissionScope: ["room:message:receive"],
    state: "active",
    activeBindingId: seat.bindingId,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  })));
  await layer.db.insert(roomBindings).values(seatFixtures.map((seat) => ({
    id: seat.bindingId,
    projectId: PROJECT_ID,
    roomId: ROOM_ID,
    seatId: seat.id,
    generation: 1,
    connectorId: "happier",
    providerId: seat.providerId,
    nativeSessionId: `native-${seat.id}`,
    happierSessionId: `happier-${seat.id}`,
    serverProfileId: "server-profile-1",
    machineId: `machine-${seat.id}`,
    hostId: "windows-host-1",
    state: "attached",
    attachedAt: CREATED_AT,
  })));

  return { layer, store, roomId: ROOM_ID };
}

function requireRoutingSeam(store: AsyncRoomStore): ExpectedRoomMessageRoutingStore {
  const candidate = store as unknown as Partial<ExpectedRoomMessageRoutingStore>;
  expect(
    candidate.routeOperatorMessage,
    "Task 4.4 requires AsyncRoomStore.routeOperatorMessage(envelope)",
  ).toBeTypeOf("function");
  expect(
    candidate.getRoutedMessage,
    "Task 4.4 requires a durable routed-message read API",
  ).toBeTypeOf("function");
  expect(
    candidate.listMessageTargets,
    "Task 4.4 requires explicit durable target records",
  ).toBeTypeOf("function");
  return candidate as ExpectedRoomMessageRoutingStore;
}

function authorityFor(seatIds: readonly string[] = seatFixtures.map((seat) => seat.id)):
RoomAuthorityEnvelopeV1 {
  return {
    actorType: "human",
    actorId: "operator-1",
    deviceId: "device-operator-1",
    role: "operator",
    allowedActions: ["room:message:route"],
    projectId: PROJECT_ID,
    roomId: ROOM_ID,
    nodeIds: [],
    seatIds,
    evidenceRefs: ["policy:operator-message-routing:v1"],
  };
}

function routeEnvelope(
  suffix: string,
  target: RoomMessageTargetV1,
  options: {
    readonly expectedAggregateVersion?: number;
    readonly authority?: RoomAuthorityEnvelopeV1;
    readonly content?: string;
    readonly issuedAt?: string;
  } = {},
): RoomControllerCommandEnvelopeV1 {
  const minute = String(Math.min(59, Math.max(1, suffix.length))).padStart(2, "0");
  const issuedAt = options.issuedAt ?? `2026-07-17T12:${minute}:00.000Z`;
  const content = options.content ?? `Operator message ${suffix}`;
  return {
    contractVersion: 1,
    apiVersion: "room.v1",
    commandId: `command-route-${suffix}`,
    idempotencyKey: `device-operator-1:route-${suffix}`,
    correlationId: `correlation-route-${suffix}`,
    roomId: ROOM_ID,
    projectId: PROJECT_ID,
    expectedAggregateVersion: options.expectedAggregateVersion ?? 0,
    issuedAt,
    authority: options.authority ?? authorityFor(),
    command: {
      type: "route_message",
      intent: "instruction",
      target,
      content,
      contentHash: hashRoomValue(content),
      nodeId: null,
    },
  };
}

describe("AsyncRoomStore routed operator messages (Task 4.4)", () => {
  it("routes a controller message as a durable controller target without seat delivery", async () => {
    const fixture = await createRoutingFixture();
    const router = requireRoutingSeam(fixture.store);
    const envelope = routeEnvelope("controller", { kind: "controller" });

    const result = await router.routeOperatorMessage(envelope);

    expect(result.replayed).toBe(false);
    expect(result.message).toMatchObject({
      roomId: fixture.roomId,
      originType: "operator",
      originId: envelope.authority.actorId,
      target: { kind: "controller" },
      targetSeatIds: [],
      idempotencyKey: envelope.idempotencyKey,
      expectedAggregateVersion: envelope.expectedAggregateVersion,
      authorityEnvelope: envelope.authority,
    });
    expect(result.deliveries).toEqual([]);
    expect(result.targets).toEqual([
      expect.objectContaining({
        projectId: PROJECT_ID,
        roomId: fixture.roomId,
        messageId: result.message.id,
        selectorKind: "controller",
        selectorRef: null,
        targetKind: "controller",
        seatId: null,
        bindingId: null,
        ordinal: 0,
      }),
    ]);
    expect(result.event).toMatchObject({
      eventType: "message_routed",
      aggregateVersion: 1,
      actorType: "human",
      actorId: envelope.authority.actorId,
    });

    const freshRouter = requireRoutingSeam(new AsyncRoomStore(fixture.layer));
    await expect(freshRouter.getRoutedMessage(result.message.id)).resolves.toEqual(result.message);
    await expect(freshRouter.listMessageTargets(result.message.id)).resolves.toEqual(result.targets);
  });

  it("resolves the all selector to every active seat and its current binding", async () => {
    const fixture = await createRoutingFixture();
    const router = requireRoutingSeam(fixture.store);
    const envelope = routeEnvelope("all", { kind: "all" });

    const result = await router.routeOperatorMessage(envelope);

    expect(result.message.target).toEqual({ kind: "all" });
    expect(result.message.targetSeatIds).toEqual(seatFixtures.map((seat) => seat.id));
    expect(result.targets).toEqual(seatFixtures.map((seat, ordinal) => expect.objectContaining({
      messageId: result.message.id,
      selectorKind: "all",
      selectorRef: null,
      targetKind: "seat",
      seatId: seat.id,
      bindingId: seat.bindingId,
      ordinal,
    })));
    expect(result.deliveries).toEqual(seatFixtures.map((seat) => expect.objectContaining({
      roomId: fixture.roomId,
      logicalMessageId: result.message.id,
      bindingId: seat.bindingId,
      idempotencyKey: `${envelope.idempotencyKey}:${seat.bindingId}`,
      state: "pending",
    })));

    const freshRouter = requireRoutingSeam(new AsyncRoomStore(fixture.layer));
    await expect(freshRouter.listMessageTargets(result.message.id)).resolves.toEqual(result.targets);
  });

  it("resolves a durable role group to members only", async () => {
    const fixture = await createRoutingFixture();
    const router = requireRoutingSeam(fixture.store);
    const reviewerSeats = seatFixtures.filter((seat) => seat.role === "reviewer");
    const envelope = routeEnvelope(
      "group-reviewers",
      { kind: "group", groupId: "role:reviewer" },
      { authority: authorityFor(reviewerSeats.map((seat) => seat.id)) },
    );

    const result = await router.routeOperatorMessage(envelope);

    expect(result.message.target).toEqual({ kind: "group", groupId: "role:reviewer" });
    expect(result.message.targetSeatIds).toEqual(reviewerSeats.map((seat) => seat.id));
    expect(result.targets).toEqual(reviewerSeats.map((seat, ordinal) => expect.objectContaining({
      selectorKind: "group",
      selectorRef: "role:reviewer",
      targetKind: "seat",
      seatId: seat.id,
      bindingId: seat.bindingId,
      ordinal,
    })));
    expect(result.deliveries.map((delivery) => delivery.bindingId)).toEqual(
      reviewerSeats.map((seat) => seat.bindingId),
    );
    expect(result.deliveries).toHaveLength(2);
  });

  it("routes to only the explicitly selected seats in selector order", async () => {
    const fixture = await createRoutingFixture();
    const router = requireRoutingSeam(fixture.store);
    const selectedSeats = [seatFixtures[2], seatFixtures[0]] as const;
    const envelope = routeEnvelope(
      "selected-seats",
      { kind: "seats", seatIds: selectedSeats.map((seat) => seat.id) },
      { authority: authorityFor(selectedSeats.map((seat) => seat.id)) },
    );

    const result = await router.routeOperatorMessage(envelope);

    expect(result.message.target).toEqual({
      kind: "seats",
      seatIds: selectedSeats.map((seat) => seat.id),
    });
    expect(result.message.targetSeatIds).toEqual(selectedSeats.map((seat) => seat.id));
    expect(result.targets).toEqual(selectedSeats.map((seat, ordinal) => expect.objectContaining({
      selectorKind: "seats",
      selectorRef: null,
      targetKind: "seat",
      seatId: seat.id,
      bindingId: seat.bindingId,
      ordinal,
    })));
    expect(result.deliveries.map((delivery) => delivery.bindingId)).toEqual(
      selectedSeats.map((seat) => seat.bindingId),
    );
  });

  it("rejects database drift between a frozen target seat and another seat's binding", async () => {
    const fixture = await createRoutingFixture();
    const router = requireRoutingSeam(fixture.store);
    const targetSeat = seatFixtures[0];
    const foreignBinding = seatFixtures[1].bindingId;
    const result = await router.routeOperatorMessage(routeEnvelope(
      "binding-lineage",
      { kind: "seats", seatIds: [targetSeat.id] },
      { authority: authorityFor([targetSeat.id]) },
    ));

    await expect(fixture.layer.db.execute(sql`
      UPDATE project.room_message_targets
      SET binding_id = ${foreignBinding}
      WHERE id = ${result.targets[0]!.id}
    `)).rejects.toThrow();

    await expect(router.listMessageTargets(result.message.id)).resolves.toEqual(result.targets);
  });

  it("durably preserves authority, target, idempotency, and expected-version provenance", async () => {
    const fixture = await createRoutingFixture();
    const router = requireRoutingSeam(fixture.store);
    const targetSeat = seatFixtures[0];
    const authority = authorityFor([targetSeat.id]);
    const envelope = routeEnvelope(
      "durable-envelope",
      { kind: "seats", seatIds: [targetSeat.id] },
      { authority },
    );

    const first = await router.routeOperatorMessage(envelope);
    const replay = await router.routeOperatorMessage({
      ...envelope,
      issuedAt: "2026-07-17T12:59:00.000Z",
    });

    expect(first.replayed).toBe(false);
    expect(replay).toEqual({ ...first, replayed: true });
    expect(first.message).toMatchObject({
      target: envelope.command.type === "route_message" ? envelope.command.target : undefined,
      targetSeatIds: [targetSeat.id],
      authorityEnvelope: authority,
      idempotencyKey: envelope.idempotencyKey,
      expectedAggregateVersion: envelope.expectedAggregateVersion,
    });
    expect(first.targets).toEqual([
      expect.objectContaining({
        messageId: first.message.id,
        seatId: targetSeat.id,
        bindingId: targetSeat.bindingId,
      }),
    ]);

    const freshRouter = requireRoutingSeam(new AsyncRoomStore(fixture.layer));
    await expect(freshRouter.getRoutedMessage(first.message.id)).resolves.toEqual(first.message);
    await expect(freshRouter.listMessageTargets(first.message.id)).resolves.toEqual(first.targets);

    const persistedMessages = await fixture.layer.db.select().from(roomMessages);
    expect(persistedMessages).toHaveLength(1);
    expect(persistedMessages[0]).toMatchObject({
      id: first.message.id,
      authority,
      target: { kind: "seats", seatIds: [targetSeat.id] },
    });
    expect(await fixture.layer.db.select().from(roomOutbox)).toHaveLength(1);
    expect(await fixture.layer.db.select().from(roomIdempotencyKeys)).toEqual([
      expect.objectContaining({
        roomId: fixture.roomId,
        idempotencyKey: envelope.idempotencyKey,
        commandType: "route_message",
        resultEventId: first.event.id,
      }),
    ]);
    expect((await fixture.store.getRoom(fixture.roomId))?.room.aggregateVersion).toBe(1);

    const staleEnvelope = routeEnvelope(
      "stale-version",
      { kind: "seats", seatIds: [targetSeat.id] },
      { authority, expectedAggregateVersion: 0 },
    );
    await expect(router.routeOperatorMessage(staleEnvelope)).rejects.toMatchObject({
      code: "aggregate_version_conflict",
    });
    expect(await fixture.layer.db.select().from(roomMessages)).toHaveLength(1);
    expect(await fixture.layer.db.select().from(roomOutbox)).toHaveLength(1);
    expect((await fixture.store.getRoom(fixture.roomId))?.room.aggregateVersion).toBe(1);
  });

  it("fails closed on malformed runtime envelopes and chronology regression", async () => {
    const fixture = await createRoutingFixture();
    const router = requireRoutingSeam(fixture.store);
    const valid = routeEnvelope("runtime-validation", { kind: "controller" });
    const malformed: unknown[] = [
      { ...valid, issuedAt: "not-an-iso-timestamp" },
      {
        ...valid,
        command: { ...valid.command, intent: "free_form" },
      },
      {
        ...valid,
        command: { ...valid.command, target: { kind: "broadcast" } },
      },
      {
        ...valid,
        authority: { ...valid.authority, allowedActions: "room:message:route" },
      },
      { ...valid, issuedAt: "2026-07-17T11:59:59.999Z" },
    ];

    for (const envelope of malformed) {
      await expect(router.routeOperatorMessage(
        envelope as RoomControllerCommandEnvelopeV1,
      )).rejects.toMatchObject({ code: "routing_command_invalid" });
    }

    expect(await fixture.layer.db.select().from(roomMessages)).toEqual([]);
    expect(await fixture.layer.db.select().from(roomOutbox)).toEqual([]);
    expect(await fixture.layer.db.select().from(roomIdempotencyKeys)).toEqual([]);
    expect((await fixture.store.getRoom(fixture.roomId))?.room.aggregateVersion).toBe(0);
    expect((await fixture.store.listEvents(fixture.roomId)).map((event) => event.eventType)).toEqual([
      "room_created",
    ]);
  });

  it("fails closed when an operator targets a seat outside the authority envelope", async () => {
    const fixture = await createRoutingFixture();
    const router = requireRoutingSeam(fixture.store);
    const authorizedSeat = seatFixtures[0];
    const outOfScopeSeat = seatFixtures[1];
    const envelope = routeEnvelope(
      "authority-overreach",
      { kind: "seats", seatIds: [outOfScopeSeat.id] },
      { authority: authorityFor([authorizedSeat.id]) },
    );

    await expect(router.routeOperatorMessage(envelope)).rejects.toMatchObject({
      code: "authority_scope_violation",
    });

    expect(await fixture.layer.db.select().from(roomMessages)).toEqual([]);
    expect(await fixture.layer.db.select().from(roomOutbox)).toEqual([]);
    expect(await fixture.layer.db.select().from(roomIdempotencyKeys)).toEqual([]);
    expect((await fixture.store.getRoom(fixture.roomId))?.room.aggregateVersion).toBe(0);
    expect((await fixture.store.listEvents(fixture.roomId)).map((event) => event.eventType)).toEqual([
      "room_created",
    ]);
  });

  it("fails closed when a routed message claims a node outside the authority envelope", async () => {
    const fixture = await createRoutingFixture();
    const router = requireRoutingSeam(fixture.store);
    const targetSeat = seatFixtures[0];
    const base = routeEnvelope(
      "node-overreach",
      { kind: "seats", seatIds: [targetSeat.id] },
      { authority: authorityFor([targetSeat.id]) },
    );
    if (base.command.type !== "route_message") throw new Error("Expected route_message fixture");
    const envelope: RoomControllerCommandEnvelopeV1 = {
      ...base,
      command: { ...base.command, nodeId: "node-outside-authority" },
    };

    await expect(router.routeOperatorMessage(envelope)).rejects.toMatchObject({
      code: "authority_scope_violation",
    });

    expect(await fixture.layer.db.select().from(roomMessages)).toEqual([]);
    expect(await fixture.layer.db.select().from(roomOutbox)).toEqual([]);
    expect(await fixture.layer.db.select().from(roomIdempotencyKeys)).toEqual([]);
    expect((await fixture.store.getRoom(fixture.roomId))?.room.aggregateVersion).toBe(0);
  });

  it("fails closed when an explicitly selected seat does not exist", async () => {
    const fixture = await createRoutingFixture();
    const router = requireRoutingSeam(fixture.store);
    const missingSeatId = "seat-does-not-exist";
    const envelope = routeEnvelope(
      "missing-seat",
      { kind: "seats", seatIds: [missingSeatId] },
      { authority: authorityFor([missingSeatId]) },
    );

    await expect(router.routeOperatorMessage(envelope)).rejects.toMatchObject({
      code: "routing_target_not_found",
    });

    expect(await fixture.layer.db.select().from(roomMessages)).toEqual([]);
    expect(await fixture.layer.db.select().from(roomOutbox)).toEqual([]);
    expect(await fixture.layer.db.select().from(roomIdempotencyKeys)).toEqual([]);
    expect((await fixture.store.getRoom(fixture.roomId))?.room.aggregateVersion).toBe(0);
  });

  it("fails closed when the selected group does not exist", async () => {
    const fixture = await createRoutingFixture();
    const router = requireRoutingSeam(fixture.store);
    const envelope = routeEnvelope(
      "missing-group",
      { kind: "group", groupId: "role:does-not-exist" },
    );

    await expect(router.routeOperatorMessage(envelope)).rejects.toMatchObject({
      code: "routing_group_not_found",
    });

    expect(await fixture.layer.db.select().from(roomMessages)).toEqual([]);
    expect(await fixture.layer.db.select().from(roomOutbox)).toEqual([]);
    expect(await fixture.layer.db.select().from(roomIdempotencyKeys)).toEqual([]);
    expect((await fixture.store.getRoom(fixture.roomId))?.room.aggregateVersion).toBe(0);
  });

  it("preserves terminal Room immutability before any routed-message write", async () => {
    const fixture = await createRoutingFixture();
    const router = requireRoutingSeam(fixture.store);
    await fixture.layer.db.execute(sql`
      UPDATE project.operational_rooms
      SET lifecycle_state = 'completed'
      WHERE project_id = ${PROJECT_ID} AND id = ${fixture.roomId}
    `);

    await expect(router.routeOperatorMessage(
      routeEnvelope("terminal-room", { kind: "controller" }),
    )).rejects.toMatchObject({ code: "terminal_state_immutable" });

    expect(await fixture.layer.db.select().from(roomMessages)).toEqual([]);
    expect(await fixture.layer.db.select().from(roomOutbox)).toEqual([]);
    expect(await fixture.layer.db.select().from(roomIdempotencyKeys)).toEqual([]);
    expect((await fixture.store.getRoom(fixture.roomId))?.room).toMatchObject({
      state: "completed",
      aggregateVersion: 0,
    });
  });

  it("does not enqueue provider work while the Room is human-paused", async () => {
    const fixture = await createRoutingFixture();
    const router = requireRoutingSeam(fixture.store);
    await fixture.layer.db.execute(sql`
      UPDATE project.operational_rooms
      SET lifecycle_state = 'paused'
      WHERE project_id = ${PROJECT_ID} AND id = ${fixture.roomId}
    `);
    const targetSeat = seatFixtures[0];

    await expect(router.routeOperatorMessage(routeEnvelope(
      "paused-room",
      { kind: "seats", seatIds: [targetSeat.id] },
      { authority: authorityFor([targetSeat.id]) },
    ))).rejects.toMatchObject({ code: "room_state_conflict" });

    expect(await fixture.layer.db.select().from(roomMessages)).toEqual([]);
    expect(await fixture.layer.db.select().from(roomOutbox)).toEqual([]);
    expect(await fixture.layer.db.select().from(roomIdempotencyKeys)).toEqual([]);
    expect((await fixture.store.getRoom(fixture.roomId))?.room).toMatchObject({
      state: "paused",
      aggregateVersion: 0,
    });
  });

  it("freezes resolved targets at command commit despite later membership changes", async () => {
    const fixture = await createRoutingFixture();
    const router = requireRoutingSeam(fixture.store);
    const firstEnvelope = routeEnvelope("freeze-before-add", { kind: "all" });

    const first = await router.routeOperatorMessage(firstEnvelope);
    const frozenTargets = first.targets.map((target) => ({
      seatId: target.seatId,
      bindingId: target.bindingId,
      ordinal: target.ordinal,
    }));

    const lateSeat = {
      id: "seat-added-later",
      role: "reviewer",
      bindingId: "binding-added-later",
      providerId: "codex",
    } as const;
    await fixture.layer.db.insert(roomSeats).values({
      id: lateSeat.id,
      projectId: PROJECT_ID,
      roomId: fixture.roomId,
      role: lateSeat.role,
      roleVersion: 1,
      roleHistory: [],
      permissionScope: ["room:message:receive"],
      state: "active",
      activeBindingId: lateSeat.bindingId,
      createdAt: "2026-07-17T12:20:00.000Z",
      updatedAt: "2026-07-17T12:20:00.000Z",
    });
    await fixture.layer.db.insert(roomBindings).values({
      id: lateSeat.bindingId,
      projectId: PROJECT_ID,
      roomId: fixture.roomId,
      seatId: lateSeat.id,
      generation: 1,
      connectorId: "happier",
      providerId: lateSeat.providerId,
      nativeSessionId: `native-${lateSeat.id}`,
      happierSessionId: `happier-${lateSeat.id}`,
      serverProfileId: "server-profile-1",
      machineId: `machine-${lateSeat.id}`,
      hostId: "windows-host-1",
      state: "attached",
      attachedAt: "2026-07-17T12:20:00.000Z",
    });

    const freshRouter = requireRoutingSeam(new AsyncRoomStore(fixture.layer));
    const reloadedFirstTargets = await freshRouter.listMessageTargets(first.message.id);
    expect(reloadedFirstTargets.map((target) => ({
      seatId: target.seatId,
      bindingId: target.bindingId,
      ordinal: target.ordinal,
    }))).toEqual(frozenTargets);
    expect(reloadedFirstTargets.some((target) => target.seatId === lateSeat.id)).toBe(false);
    expect((await freshRouter.getRoutedMessage(first.message.id))?.targetSeatIds).toEqual(
      seatFixtures.map((seat) => seat.id),
    );

    const secondEnvelope = routeEnvelope(
      "freeze-after-add",
      { kind: "all" },
      {
        expectedAggregateVersion: 1,
        authority: authorityFor([...seatFixtures.map((seat) => seat.id), lateSeat.id]),
        issuedAt: "2026-07-17T12:21:00.000Z",
      },
    );
    const second = await freshRouter.routeOperatorMessage(secondEnvelope);
    expect(second.message.targetSeatIds).toEqual([
      ...seatFixtures.map((seat) => seat.id),
      lateSeat.id,
    ]);
    await expect(freshRouter.listMessageTargets(first.message.id)).resolves.toEqual(reloadedFirstTargets);
  });

  it("commits successfully when a UI projection listener is absent or throws post-commit", async () => {
    let routedListenerCalls = 0;
    const fixture = await createRoutingFixture(async (event) => {
      if (event.eventType !== "message_routed") return;
      routedListenerCalls += 1;
      throw new Error("simulated browser projection disconnect");
    });
    const router = requireRoutingSeam(fixture.store);
    const targetSeat = seatFixtures[0];
    const envelope = routeEnvelope(
      "browser-independent",
      { kind: "seats", seatIds: [targetSeat.id] },
      { authority: authorityFor([targetSeat.id]) },
    );

    const result = await router.routeOperatorMessage(envelope);
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(result.replayed).toBe(false);
    expect(routedListenerCalls).toBe(1);
    expect((await fixture.store.getRoom(fixture.roomId))?.room.aggregateVersion).toBe(1);
    const listenerFreeRouter = requireRoutingSeam(new AsyncRoomStore(fixture.layer));
    await expect(listenerFreeRouter.getRoutedMessage(result.message.id)).resolves.toEqual(result.message);
    await expect(listenerFreeRouter.listMessageTargets(result.message.id)).resolves.toEqual(result.targets);
  });
});
