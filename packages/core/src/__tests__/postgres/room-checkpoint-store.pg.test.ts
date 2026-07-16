import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";

import { AsyncRoomCheckpointStore } from "../../async-room-checkpoint-store.js";
import { AsyncRoomStore } from "../../async-room-store.js";
import { rebuildRoomProjectionFromEvents } from "../../room-projection-replay.js";
import { createConnectionSetFromUrl, type PostgresConnections } from "../../postgres/connection.js";
import { createAsyncDataLayer } from "../../postgres/data-layer.js";
import { EmbeddedPostgresLifecycle } from "../../postgres/embedded-lifecycle.js";
import { applySchemaBaseline } from "../../postgres/schema-applier.js";
import {
  operationalRooms,
  roomCheckpoints,
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
});
