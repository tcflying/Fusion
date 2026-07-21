import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AsyncRoomStore,
  MAX_ROOM_SUMMARY_LIST_LIMIT,
  type RoomCommandContext,
} from "../../async-room-store.js";
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
  const dataDir = mkdtempSync(join(tmpdir(), "fusion-room-list-rooms-"));
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
    actorType: "human",
    actorId: "room-list-operator",
    correlationId: `correlation-${eventId}`,
    causationId: null,
    occurredAt,
  };
}

async function createRoom(
  store: AsyncRoomStore,
  projectId: string,
  roomId: string,
  now: string,
): Promise<void> {
  await store.createRoom({
    id: roomId,
    projectId,
    objective: `Objective for ${roomId}`,
    protocolId: "implementation",
    protocolVersion: 1,
    now,
  }, command(`${roomId}-created`, now));
}

describe("AsyncRoomStore Room summary listing", () => {
  it("pages deterministic current summaries without leaking projection internals", async () => {
    const context = await startEmbeddedDatabase();
    const projectOne = new AsyncRoomStore(
      createAsyncDataLayer(context.connections!, { projectId: "project-1" }),
    );
    const projectTwo = new AsyncRoomStore(
      createAsyncDataLayer(context.connections!, { projectId: "project-2" }),
    );

    await createRoom(projectOne, "project-1", "room-alpha", "2026-07-19T16:00:00.000Z");
    await createRoom(projectOne, "project-1", "room-beta", "2026-07-19T16:00:00.000Z");
    await createRoom(projectOne, "project-1", "room-gamma", "2026-07-19T16:01:00.000Z");
    await createRoom(projectTwo, "project-2", "room-foreign-a", "2026-07-19T15:59:00.000Z");
    await createRoom(projectTwo, "project-2", "room-foreign-b", "2026-07-19T16:02:00.000Z");

    const firstPage = await projectOne.listRoomSummaries({ limit: 2 });
    expect(firstPage.rooms.map((room) => room.id)).toEqual(["room-alpha", "room-beta"]);
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    expect(Object.keys(firstPage.rooms[0] ?? {}).sort()).toEqual([
      "activeTurnId",
      "aggregateVersion",
      "contractVersion",
      "createdAt",
      "id",
      "lifecycleState",
      "membershipVersion",
      "objective",
      "projectId",
      "protocolId",
      "protocolVersion",
      "seatCount",
      "updatedAt",
    ]);

    const aggregate = await projectOne.getRoom("room-alpha");
    expect(aggregate).toBeDefined();
    expect(firstPage.rooms[0]).toMatchObject({
      contractVersion: 1,
      id: aggregate!.room.id,
      projectId: aggregate!.room.projectId,
      objective: aggregate!.room.objective,
      protocolId: aggregate!.room.protocolId,
      protocolVersion: aggregate!.room.protocolVersion,
      lifecycleState: aggregate!.room.state,
      aggregateVersion: aggregate!.room.aggregateVersion,
      membershipVersion: aggregate!.membershipVersion,
      activeTurnId: aggregate!.activeTurnId,
      seatCount: aggregate!.seats.length,
      createdAt: aggregate!.room.createdAt,
      updatedAt: aggregate!.room.updatedAt,
    });

    const secondPage = await projectOne.listRoomSummaries({
      limit: 2,
      cursor: firstPage.nextCursor,
    });
    expect(secondPage.rooms.map((room) => room.id)).toEqual(["room-gamma"]);
    expect(secondPage.nextCursor).toBeNull();

    const foreignPage = await projectTwo.listRoomSummaries({ limit: 1 });
    await expect(projectOne.listRoomSummaries({
      limit: 1,
      cursor: foreignPage.nextCursor,
    })).rejects.toMatchObject({ code: "room_list_invalid" });
  }, 60_000);

  it("rejects malformed cursors and unbounded list limits", async () => {
    const context = await startEmbeddedDatabase();
    const store = new AsyncRoomStore(
      createAsyncDataLayer(context.connections!, { projectId: "project-1" }),
    );

    await expect(store.listRoomSummaries({ limit: 0 })).rejects.toMatchObject({
      code: "room_list_invalid",
    });
    await expect(store.listRoomSummaries({ limit: MAX_ROOM_SUMMARY_LIST_LIMIT + 1 })).rejects.toMatchObject({
      code: "room_list_invalid",
    });
    await expect(store.listRoomSummaries({ cursor: "not-a-room-cursor" })).rejects.toMatchObject({
      code: "room_list_invalid",
    });
  }, 60_000);
});
