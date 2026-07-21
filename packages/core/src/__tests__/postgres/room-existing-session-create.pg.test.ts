import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, inArray } from "drizzle-orm";

import { AsyncRoomStore } from "../../async-room-store.js";
import { rebuildRoomProjectionFromEvents } from "../../room-projection-replay.js";
import { createConnectionSetFromUrl, type PostgresConnections } from "../../postgres/connection.js";
import { createAsyncDataLayer } from "../../postgres/data-layer.js";
import { EmbeddedPostgresLifecycle } from "../../postgres/embedded-lifecycle.js";
import { applySchemaBaseline } from "../../postgres/schema-applier.js";
import {
  operationalRooms,
  roomBindings,
  roomEvents,
  roomIdempotencyKeys,
  roomSeats,
} from "../../postgres/schema/room.js";

interface EmbeddedTestContext {
  readonly lifecycle: EmbeddedPostgresLifecycle;
  connections: PostgresConnections | null;
}

const contexts: EmbeddedTestContext[] = [];
const EMBEDDED_DATABASE_TIMEOUT_MS = 60_000;

async function startEmbeddedDatabase(): Promise<EmbeddedTestContext> {
  const lifecycle = new EmbeddedPostgresLifecycle({
    dataDir: mkdtempSync(join(tmpdir(), "fusion-room-existing-session-create-")),
    database: "fusion",
    user: "postgres",
    password: "password",
  });
  const backend = await lifecycle.start();
  const context = {
    lifecycle,
    connections: await createConnectionSetFromUrl(backend, { poolMax: 8 }),
  } satisfies EmbeddedTestContext;
  contexts.push(context);
  await applySchemaBaseline(context.connections.migration, { pluginHooks: [] });
  return context;
}

beforeAll(async () => {
  await startEmbeddedDatabase();
}, EMBEDDED_DATABASE_TIMEOUT_MS);

afterAll(async () => {
  while (contexts.length > 0) {
    const context = contexts.pop();
    if (!context) continue;
    if (context.connections) {
      await context.connections.close();
      context.connections = null;
    }
    await context.lifecycle.stop();
  }
}, EMBEDDED_DATABASE_TIMEOUT_MS);

function embeddedContext(): EmbeddedTestContext {
  const context = contexts[0];
  if (!context?.connections) throw new Error("Embedded PostgreSQL test context is not ready");
  return context;
}

function createInput(suffix = "success") {
  return {
    room: {
      id: `room-existing-${suffix}`,
      objective: "Continue two exact existing provider Sessions",
      protocolId: "implementation",
      protocolVersion: 1,
    },
    participants: [
      {
        seat: {
          id: `seat-codex-${suffix}`,
          role: "producer",
          permissionScope: ["room:message", "session:send"],
        },
        binding: {
          id: `binding-codex-${suffix}`,
          connectorId: "happier",
          providerId: "codex",
          nativeSessionId: `codex-thread-${suffix}`,
          happierSessionId: `happier-codex-${suffix}`,
          serverProfileId: "server-primary",
          machineId: "machine-windows",
          hostId: "host-local",
        },
      },
      {
        seat: {
          id: `seat-claude-${suffix}`,
          role: "reviewer",
          permissionScope: ["room:message", "session:send"],
        },
        binding: {
          id: `binding-claude-${suffix}`,
          connectorId: "happier",
          providerId: "claude",
          nativeSessionId: `claude-session-${suffix}`,
          happierSessionId: `happier-claude-${suffix}`,
          serverProfileId: "server-primary",
          machineId: "machine-windows",
          hostId: "host-local",
        },
      },
    ],
    now: "2026-07-18T02:20:00.000Z",
  } as const;
}

function commandContext(eventId: string) {
  return {
    eventId,
    actorType: "controller" as const,
    actorId: "room-existing-session-spine",
    correlationId: `correlation-${eventId}`,
    causationId: null,
    occurredAt: "2026-07-18T02:20:00.000Z",
  };
}

/*
FNXC:SessionRoomExistingBindings 2026-07-18-10:25:
An operational Room created from existing Sessions must become visible only as one complete initial aggregate with at least two ready seats and attached generation-1 bindings. The replayable room_created event is committed in the same PostgreSQL transaction as every projection row.
*/
describe.sequential("AsyncRoomStore existing-Session Room creation", () => {
  it("atomically creates a replayable Room with two existing bindings before publishing it", async () => {
    const context = embeddedContext();
    const layer = createAsyncDataLayer(context.connections!, { projectId: "project-1" });
    let resolveVisibleBindingCount: (count: number) => void = () => undefined;
    const visibleBindingCount = new Promise<number>((resolve) => {
      resolveVisibleBindingCount = resolve;
    });
    const store = new AsyncRoomStore(layer, {
      onCommittedEvent: async (event) => {
        const visible = await layer.db
          .select({ id: roomBindings.id })
          .from(roomBindings)
          .where(and(
            eq(roomBindings.projectId, "project-1"),
            eq(roomBindings.roomId, event.roomId),
          ));
        resolveVisibleBindingCount(visible.length);
      },
    });

    const created = await store.createRoomWithExistingBindings(
      createInput(),
      commandContext("event-existing-create-success"),
    );

    expect(created).toMatchObject({
      room: {
        id: "room-existing-success",
        state: "draft",
        aggregateVersion: 0,
      },
      membershipVersion: 1,
    });
    expect(created.seats
      .map((seat) => [seat.id, seat.activeBindingId] as const)
      .toSorted(([left], [right]) => left.localeCompare(right))).toEqual([
      ["seat-claude-success", "binding-claude-success"],
      ["seat-codex-success", "binding-codex-success"],
    ]);
    expect(created.bindings
      .map((binding) => ({
        id: binding.id,
        generation: binding.generation,
        state: binding.state,
      }))
      .toSorted((left, right) => left.id.localeCompare(right.id))).toEqual([
      { id: "binding-claude-success", generation: 1, state: "attached" },
      { id: "binding-codex-success", generation: 1, state: "attached" },
    ]);
    expect(await visibleBindingCount).toBe(2);

    expect(await layer.db
      .select({ id: operationalRooms.id })
      .from(operationalRooms)
      .where(eq(operationalRooms.id, created.room.id))).toHaveLength(1);
    expect(await layer.db
      .select({ id: roomSeats.id })
      .from(roomSeats)
      .where(eq(roomSeats.roomId, created.room.id))).toHaveLength(2);
    expect(await layer.db
      .select({ id: roomBindings.id })
      .from(roomBindings)
      .where(eq(roomBindings.roomId, created.room.id))).toHaveLength(2);
    const events = await layer.db
      .select()
      .from(roomEvents)
      .where(eq(roomEvents.roomId, created.room.id));
    expect(events).toHaveLength(1);
    expect(rebuildRoomProjectionFromEvents(await store.listEvents(created.room.id))).toEqual(created);
  }, EMBEDDED_DATABASE_TIMEOUT_MS);

  it("durably replays the same create result and rejects different input after the Room advances", async () => {
    const context = embeddedContext();
    const layer = createAsyncDataLayer(context.connections!, { projectId: "project-1" });
    const store = new AsyncRoomStore(layer);
    const input = createInput("idempotent");
    const created = await store.createRoomWithExistingBindings(
      input,
      commandContext("event-existing-create-idempotent"),
    );
    await store.transitionLifecycle(
      created.room.id,
      {
        to: "ready",
        expectedAggregateVersion: 0,
        now: "2026-07-18T02:21:00.000Z",
      },
      commandContext("event-existing-create-idempotent-ready"),
    );

    const replayed = await store.createRoomWithExistingBindings(
      { ...input, now: "2026-07-18T02:22:00.000Z" },
      commandContext("event-existing-create-idempotent-retry"),
    );

    expect(replayed).toEqual(created);
    expect(await store.listEvents(created.room.id)).toHaveLength(2);
    expect(await layer.db
      .select({
        commandType: roomIdempotencyKeys.commandType,
        commandHash: roomIdempotencyKeys.commandHash,
        resultEventId: roomIdempotencyKeys.resultEventId,
      })
      .from(roomIdempotencyKeys)
      .where(eq(roomIdempotencyKeys.roomId, created.room.id))).toEqual([{
      commandType: "create_room_with_existing_bindings",
      commandHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      resultEventId: "event-existing-create-idempotent",
    }]);

    await expect(store.createRoomWithExistingBindings(
      {
        ...input,
        room: { ...input.room, objective: "Conflicting replacement objective" },
      },
      commandContext("event-existing-create-idempotent-conflict"),
    )).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(await store.getRoom(created.room.id)).toMatchObject({
      room: { state: "ready", aggregateVersion: 1 },
      membershipVersion: 1,
    });
  }, EMBEDDED_DATABASE_TIMEOUT_MS);

  it("rejects malformed identity and rolls back the whole aggregate on a binding insert failure", async () => {
    const context = embeddedContext();
    const layer = createAsyncDataLayer(context.connections!, { projectId: "project-1" });
    const store = new AsyncRoomStore(layer);
    const base = createInput("invalid-binding");
    const input = {
      ...base,
      participants: [
        base.participants[0],
        {
          ...base.participants[1],
          binding: { ...base.participants[1].binding, happierSessionId: "" },
        },
      ],
    } as const;

    await expect(store.createRoomWithExistingBindings(
      input,
      commandContext("event-existing-create-invalid-binding"),
    )).rejects.toMatchObject({ code: "binding_identity_conflict" });

    expect(await store.getRoom(input.room.id)).toBeUndefined();
    for (const table of [roomSeats, roomBindings, roomEvents, roomIdempotencyKeys] as const) {
      expect(await layer.db
        .select()
        .from(table)
        .where(eq(table.roomId, input.room.id))).toHaveLength(0);
    }

    const ownerInput = createInput("binding-id-owner");
    await store.createRoomWithExistingBindings(
      ownerInput,
      commandContext("event-existing-create-binding-id-owner"),
    );
    const conflictBase = createInput("binding-id-rollback");
    const bindingInsertConflict = {
      ...conflictBase,
      participants: [
        conflictBase.participants[0],
        {
          ...conflictBase.participants[1],
          binding: {
            ...conflictBase.participants[1].binding,
            id: ownerInput.participants[0].binding.id,
          },
        },
      ],
    } as const;
    await expect(store.createRoomWithExistingBindings(
      bindingInsertConflict,
      commandContext("event-existing-create-binding-id-rollback"),
    )).rejects.toThrow();
    expect(await store.getRoom(bindingInsertConflict.room.id)).toBeUndefined();
    for (const table of [roomSeats, roomBindings, roomEvents, roomIdempotencyKeys] as const) {
      expect(await layer.db
        .select()
        .from(table)
        .where(eq(table.roomId, bindingInsertConflict.room.id))).toHaveLength(0);
    }
  }, EMBEDDED_DATABASE_TIMEOUT_MS);

  it("fails closed on global native/Happier conflicts and serializes reversed-order identity races", async () => {
    const context = embeddedContext();
    const firstLayer = createAsyncDataLayer(context.connections!, { projectId: "project-1" });
    const secondLayer = createAsyncDataLayer(context.connections!, { projectId: "project-2" });
    const firstStore = new AsyncRoomStore(firstLayer);
    const secondStore = new AsyncRoomStore(secondLayer);
    const ownerInput = createInput("global-owner");
    await firstStore.createRoomWithExistingBindings(
      ownerInput,
      commandContext("event-existing-create-global-owner"),
    );

    const nativeBase = createInput("global-native-loser");
    const nativeConflict = {
      ...nativeBase,
      participants: [
        {
          ...nativeBase.participants[0],
          binding: {
            ...nativeBase.participants[0].binding,
            providerId: ownerInput.participants[0].binding.providerId,
            nativeSessionId: ownerInput.participants[0].binding.nativeSessionId,
          },
        },
        nativeBase.participants[1],
      ],
    } as const;
    await expect(secondStore.createRoomWithExistingBindings(
      nativeConflict,
      commandContext("event-existing-create-global-native-loser"),
    )).rejects.toMatchObject({ code: "binding_identity_conflict" });
    expect(await secondStore.getRoom(nativeConflict.room.id)).toBeUndefined();

    const happierBase = createInput("global-happier-loser");
    const happierConflict = {
      ...happierBase,
      participants: [
        happierBase.participants[0],
        {
          ...happierBase.participants[1],
          binding: {
            ...happierBase.participants[1].binding,
            connectorId: ownerInput.participants[1].binding.connectorId,
            happierSessionId: ownerInput.participants[1].binding.happierSessionId,
          },
        },
      ],
    } as const;
    await expect(secondStore.createRoomWithExistingBindings(
      happierConflict,
      commandContext("event-existing-create-global-happier-loser"),
    )).rejects.toMatchObject({ code: "binding_identity_conflict" });
    expect(await secondStore.getRoom(happierConflict.room.id)).toBeUndefined();

    const raceFirst = createInput("identity-race-first");
    const raceSecondBase = createInput("identity-race-second");
    const raceSecond = {
      ...raceSecondBase,
      participants: raceSecondBase.participants.map((participant, index) => ({
        ...participant,
        binding: {
          ...participant.binding,
          providerId: raceFirst.participants[index]!.binding.providerId,
          nativeSessionId: raceFirst.participants[index]!.binding.nativeSessionId,
          happierSessionId: raceFirst.participants[index]!.binding.happierSessionId,
        },
      })).reverse(),
    } as const;
    const outcomes = await Promise.allSettled([
      firstStore.createRoomWithExistingBindings(
        raceFirst,
        commandContext("event-existing-create-identity-race-first"),
      ),
      secondStore.createRoomWithExistingBindings(
        raceSecond,
        commandContext("event-existing-create-identity-race-second"),
      ),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
    );
    expect(rejected?.reason).toMatchObject({ code: "binding_identity_conflict" });
    const losingRoomId = outcomes[0]?.status === "rejected"
      ? raceFirst.room.id
      : raceSecond.room.id;
    const losingStore = outcomes[0]?.status === "rejected" ? firstStore : secondStore;
    expect(await losingStore.getRoom(losingRoomId)).toBeUndefined();
    expect(await firstLayer.db
      .select({ id: roomBindings.id })
      .from(roomBindings)
      .where(inArray(
        roomBindings.nativeSessionId,
        raceFirst.participants.map((participant) => participant.binding.nativeSessionId),
      ))).toHaveLength(2);
  }, EMBEDDED_DATABASE_TIMEOUT_MS);
});
