import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AsyncRoomStore, type RoomCommandContext } from "../../async-room-store.js";
import type { RoomAggregateV1 } from "../../room-domain.js";
import { createConnectionSetFromUrl, type PostgresConnections } from "../../postgres/connection.js";
import { createAsyncDataLayer } from "../../postgres/data-layer.js";
import { EmbeddedPostgresLifecycle } from "../../postgres/embedded-lifecycle.js";
import { applySchemaBaseline } from "../../postgres/schema-applier.js";

interface EmbeddedTestContext {
  readonly dataDir: string;
  readonly lifecycle: EmbeddedPostgresLifecycle;
  connections: PostgresConnections | null;
}

const contexts: EmbeddedTestContext[] = [];

async function startEmbeddedDatabase(): Promise<EmbeddedTestContext> {
  const dataDir = mkdtempSync(join(tmpdir(), "fusion-room-runnable-list-"));
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
    rmSync(context.dataDir, { recursive: true, force: true });
  }
});

function command(eventId: string, occurredAt: string): RoomCommandContext {
  return {
    eventId,
    actorType: "controller",
    actorId: "room-controller-test",
    correlationId: `correlation-${eventId}`,
    causationId: null,
    occurredAt,
  };
}

async function createRunningRoom(
  store: AsyncRoomStore,
  projectId: string,
  roomId: string,
  createdAt: string,
  readyAt: string,
  runningAt: string,
): Promise<RoomAggregateV1> {
  const created = await store.createRoom({
    id: roomId,
    projectId,
    objective: `Run ${roomId}`,
    protocolId: "implementation",
    protocolVersion: 1,
    now: createdAt,
  }, command(`${roomId}-created`, createdAt));
  const ready = await store.transitionLifecycle(roomId, {
    to: "ready",
    expectedAggregateVersion: created.room.aggregateVersion,
    now: readyAt,
  }, command(`${roomId}-ready`, readyAt));
  return store.transitionLifecycle(roomId, {
    to: "running",
    expectedAggregateVersion: ready.room.aggregateVersion,
    now: runningAt,
  }, command(`${roomId}-running`, runningAt));
}

describe("AsyncRoomStore runnable Room discovery", () => {
  it("lists only this project's running Rooms in deterministic update order", async () => {
    const context = await startEmbeddedDatabase();
    const projectOne = new AsyncRoomStore(createAsyncDataLayer(context.connections!, { projectId: "project-1" }));
    const projectTwo = new AsyncRoomStore(createAsyncDataLayer(context.connections!, { projectId: "project-2" }));
    await createRunningRoom(
      projectOne,
      "project-1",
      "room-later",
      "2026-07-17T12:00:00.000Z",
      "2026-07-17T12:01:00.000Z",
      "2026-07-17T12:05:00.000Z",
    );
    const earlier = await createRunningRoom(
      projectOne,
      "project-1",
      "room-earlier",
      "2026-07-17T12:00:01.000Z",
      "2026-07-17T12:01:01.000Z",
      "2026-07-17T12:03:00.000Z",
    );
    await projectOne.createRoom({
      id: "room-draft",
      projectId: "project-1",
      objective: "Not runnable",
      protocolId: "implementation",
      protocolVersion: 1,
      now: "2026-07-17T12:02:00.000Z",
    }, command("room-draft-created", "2026-07-17T12:02:00.000Z"));
    await createRunningRoom(
      projectTwo,
      "project-2",
      "room-other-project",
      "2026-07-17T12:00:02.000Z",
      "2026-07-17T12:01:02.000Z",
      "2026-07-17T12:02:02.000Z",
    );

    const listRunnableRooms = (projectOne as unknown as {
      listRunnableRooms?: () => Promise<readonly RoomAggregateV1[]>;
    }).listRunnableRooms;
    expect(listRunnableRooms, "Task 4.2 requires durable runnable-Room discovery").toBeTypeOf("function");
    await expect(listRunnableRooms!.call(projectOne)).resolves.toMatchObject([
      { room: { id: "room-earlier", state: "running" } },
      { room: { id: "room-later", state: "running" } },
    ]);

    await projectOne.transitionLifecycle("room-earlier", {
      to: "paused",
      expectedAggregateVersion: earlier.room.aggregateVersion,
      now: "2026-07-17T12:06:00.000Z",
    }, command("room-earlier-paused", "2026-07-17T12:06:00.000Z"));
    await expect(listRunnableRooms!.call(projectOne)).resolves.toMatchObject([
      { room: { id: "room-later", state: "running" } },
    ]);
  }, 60_000);
});
