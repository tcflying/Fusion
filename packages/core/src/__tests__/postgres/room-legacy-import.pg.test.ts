import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";

import { AsyncCliSessionStore } from "../../async-cli-session-store.js";
import { AsyncRoomStore } from "../../async-room-store.js";
import { rebuildRoomProjectionFromEvents } from "../../room-projection-replay.js";
import { createConnectionSetFromUrl, type PostgresConnections } from "../../postgres/connection.js";
import { createAsyncDataLayer, type AsyncDataLayer } from "../../postgres/data-layer.js";
import { EmbeddedPostgresLifecycle } from "../../postgres/embedded-lifecycle.js";
import { applySchemaBaseline } from "../../postgres/schema-applier.js";
import { cliSessions } from "../../postgres/schema/project.js";
import { roomBindings } from "../../postgres/schema/room.js";

interface EmbeddedTestContext {
  readonly dataDir: string;
  readonly lifecycle: EmbeddedPostgresLifecycle;
  connections: PostgresConnections | null;
}

const contexts: EmbeddedTestContext[] = [];

async function startEmbeddedDatabase(): Promise<EmbeddedTestContext> {
  const dataDir = mkdtempSync(join(tmpdir(), "fusion-room-legacy-import-"));
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
    connections: await createConnectionSetFromUrl(backend, { poolMax: 8 }),
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

async function createLegacyBinding(
  layer: AsyncDataLayer,
  suffix: string,
) {
  const taskId = `task-legacy-${suffix}`;
  const cliSessionId = `cli-task-legacy-${suffix}`;
  const binding = {
    cliSessionId,
    nativeSessionId: `codex-thread-legacy-${suffix}`,
    providerId: "codex" as const,
    remoteSessionId: `happier-session-legacy-${suffix}`,
    machineId: `windows-host-${suffix}`,
    serverId: `happier-server-${suffix}`,
    linkedAt: "2026-07-17T09:00:00.000Z",
  };
  const session = await new AsyncCliSessionStore(layer).createSession({
    id: cliSessionId,
    taskId,
    purpose: "execute",
    projectId: "project-1",
    adapterId: "happier",
    agentState: "idle",
    nativeSessionId: binding.nativeSessionId,
    autonomyPosture: {
      autoApprove: false,
      happierDirectSession: binding,
    },
    worktreePath: `G:\\codex-project\\legacy-${suffix}`,
  });
  return {
    source: {
      taskId,
      ...binding,
      cliSessionUpdatedAt: session.updatedAt,
    },
    row: (await layer.db
      .select()
      .from(cliSessions)
      .where(eq(cliSessions.id, cliSessionId)))[0]!,
  };
}

function importInput(
  suffix: string,
  source: Awaited<ReturnType<typeof createLegacyBinding>>["source"],
) {
  return {
    room: {
      id: `room-import-${suffix}`,
      objective: `Continue legacy task ${source.taskId} in one operational Room`,
      protocolId: "implementation",
      protocolVersion: 1,
    },
    seat: {
      id: `seat-import-${suffix}`,
      role: "producer",
      permissionScope: ["session:read", "session:send"],
    },
    bindingId: `binding-import-${suffix}`,
    source,
    now: "2026-07-17T09:05:00.000Z",
  };
}

function commandContext(eventId: string) {
  return {
    eventId,
    actorType: "human" as const,
    actorId: "operator-1",
    correlationId: `correlation-${eventId}`,
    causationId: null,
    occurredAt: "2026-07-17T09:05:00.000Z",
  };
}

describe("one-way legacy Happier Session import", () => {
  it("creates a one-seat Room while leaving the task-bound CLI Session byte-for-byte unchanged", async () => {
    const context = await startEmbeddedDatabase();
    const layer = createAsyncDataLayer(context.connections!, { projectId: "project-1" });
    const legacy = await createLegacyBinding(layer, "success");
    const store = new AsyncRoomStore(layer);

    const imported = await store.importLegacyHappierBinding(
      importInput("success", legacy.source),
      commandContext("event-import-success"),
    );
    expect(imported).toMatchObject({
      room: { id: "room-import-success", state: "draft", aggregateVersion: 0 },
      membershipVersion: 1,
      seats: [{ id: "seat-import-success", activeBindingId: "binding-import-success" }],
      bindings: [{
        id: "binding-import-success",
        nativeSessionId: legacy.source.nativeSessionId,
        happierSessionId: legacy.source.remoteSessionId,
        serverProfileId: legacy.source.serverId,
        hostId: legacy.source.machineId,
        generation: 1,
      }],
    });
    const after = (await layer.db
      .select()
      .from(cliSessions)
      .where(eq(cliSessions.id, legacy.source.cliSessionId)))[0];
    expect(after).toEqual(legacy.row);

    const events = await store.listEvents(imported.room.id);
    expect(events).toHaveLength(1);
    expect(rebuildRoomProjectionFromEvents(events)).toEqual(imported);

    await expect(
      store.importLegacyHappierBinding(
        importInput("duplicate", legacy.source),
        commandContext("event-import-duplicate"),
      ),
    ).rejects.toThrow(/already.*Room/i);
    expect(await store.getRoom("room-import-duplicate")).toBeUndefined();
    expect((await layer.db
      .select()
      .from(cliSessions)
      .where(eq(cliSessions.id, legacy.source.cliSessionId)))[0]).toEqual(legacy.row);
  });

  it("rolls back Room, seat, and binding writes when the final event append fails", async () => {
    const context = await startEmbeddedDatabase();
    const layer = createAsyncDataLayer(context.connections!, { projectId: "project-1" });
    const legacy = await createLegacyBinding(layer, "rollback");
    const store = new AsyncRoomStore(layer);
    await store.createRoom(
      {
        id: "room-event-owner",
        projectId: "project-1",
        objective: "Own the colliding event ID",
        protocolId: "implementation",
        protocolVersion: 1,
        now: "2026-07-17T09:04:00.000Z",
      },
      commandContext("event-import-collision"),
    );

    await expect(
      store.importLegacyHappierBinding(
        importInput("rollback", legacy.source),
        commandContext("event-import-collision"),
      ),
    ).rejects.toThrow();
    expect(await store.getRoom("room-import-rollback")).toBeUndefined();
    expect(await layer.db
      .select()
      .from(roomBindings)
      .where(
        and(
          eq(roomBindings.projectId, "project-1"),
          eq(roomBindings.id, "binding-import-rollback"),
        ),
      )).toHaveLength(0);
    expect((await layer.db
      .select()
      .from(cliSessions)
      .where(eq(cliSessions.id, legacy.source.cliSessionId)))[0]).toEqual(legacy.row);
  });
});
