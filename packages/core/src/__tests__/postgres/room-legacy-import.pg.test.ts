import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
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
import {
  operationalRooms,
  roomBindings,
  roomMembershipChanges,
  roomTurns,
} from "../../postgres/schema/room.js";

interface EmbeddedTestContext {
  readonly dataDir: string;
  readonly lifecycle: EmbeddedPostgresLifecycle;
  connections: PostgresConnections | null;
}

const contexts: EmbeddedTestContext[] = [];
const EMBEDDED_DATABASE_TIMEOUT_MS = 60_000;

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
    // The data directory is inside Vitest's private worker root. Global teardown
    // removes that root after the worker has released Windows AV/indexer handles;
    // recursively deleting thousands of PG files per case can stall this hook.
  }
}, EMBEDDED_DATABASE_TIMEOUT_MS);

async function createLegacyBinding(
  layer: AsyncDataLayer,
  suffix: string,
  persistedFormat: "legacy" | "semantic-v2" | "unsupported-version" = "legacy",
) {
  const taskId = `task-legacy-${suffix}`;
  const cliSessionId = `cli-task-legacy-${suffix}`;
  const sourceBinding = {
    cliSessionId,
    // Legacy bridge naming is inverted relative to the Room contract:
    // nativeSessionId stores Happier's linked Session id, while
    // remoteSessionId is the provider-native Codex/Claude/OpenCode id.
    nativeSessionId: `happier-session-legacy-${suffix}`,
    providerId: "codex" as const,
    remoteSessionId: `codex-thread-legacy-${suffix}`,
    machineId: `windows-host-${suffix}`,
    serverId: `happier-server-${suffix}`,
    linkedAt: "2026-07-17T09:00:00.000Z",
  };
  const persistedBinding = persistedFormat === "semantic-v2"
    ? {
        schemaVersion: 2,
        cliSessionId,
        providerId: sourceBinding.providerId,
        nativeSessionId: sourceBinding.remoteSessionId,
        happierSessionId: sourceBinding.nativeSessionId,
        machineId: sourceBinding.machineId,
        serverProfileId: sourceBinding.serverId,
        linkedAt: sourceBinding.linkedAt,
      }
    : persistedFormat === "unsupported-version"
      ? { ...sourceBinding, schemaVersion: 3 }
      : sourceBinding;
  const session = await new AsyncCliSessionStore(layer).createSession({
    id: cliSessionId,
    taskId,
    purpose: "execute",
    projectId: "project-1",
    adapterId: "happier",
    agentState: "idle",
    nativeSessionId: sourceBinding.nativeSessionId,
    autonomyPosture: {
      autoApprove: false,
      happierDirectSession: persistedBinding,
    },
    worktreePath: `G:\\codex-project\\legacy-${suffix}`,
  });
  return {
    source: {
      taskId,
      cliSessionId,
      providerId: sourceBinding.providerId,
      nativeSessionId: sourceBinding.remoteSessionId,
      happierSessionId: sourceBinding.nativeSessionId,
      machineId: sourceBinding.machineId,
      hostId: `fusion-host-${suffix}`,
      serverProfileId: sourceBinding.serverId,
      linkedAt: sourceBinding.linkedAt,
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
  it("accepts semantic-v2 metadata and rejects unknown versioned metadata", async () => {
    const context = await startEmbeddedDatabase();
    const layer = createAsyncDataLayer(context.connections!, { projectId: "project-1" });
    const legacy = await createLegacyBinding(layer, "semantic-v2", "semantic-v2");
    const store = new AsyncRoomStore(layer);

    const imported = await store.importLegacyHappierBinding(
      importInput("semantic-v2", legacy.source),
      commandContext("event-import-semantic-v2"),
    );

    expect(imported.bindings).toEqual([expect.objectContaining({
      id: "binding-import-semantic-v2",
      nativeSessionId: "codex-thread-legacy-semantic-v2",
      happierSessionId: "happier-session-legacy-semantic-v2",
      serverProfileId: "happier-server-semantic-v2",
      machineId: "windows-host-semantic-v2",
      hostId: "fusion-host-semantic-v2",
    })]);
    expect((await layer.db
      .select()
      .from(cliSessions)
      .where(eq(cliSessions.id, legacy.source.cliSessionId)))[0]).toEqual(legacy.row);

    const unsupported = await createLegacyBinding(
      layer,
      "unsupported-version",
      "unsupported-version",
    );
    await expect(store.importLegacyHappierBinding(
      importInput("unsupported-version", unsupported.source),
      commandContext("event-import-unsupported-version"),
    )).rejects.toThrow(/integrity|version/iu);
    expect(await store.getRoom("room-import-unsupported-version")).toBeUndefined();
  }, EMBEDDED_DATABASE_TIMEOUT_MS);

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
        happierSessionId: legacy.source.happierSessionId,
        serverProfileId: legacy.source.serverProfileId,
        machineId: legacy.source.machineId,
        hostId: legacy.source.hostId,
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
  }, EMBEDDED_DATABASE_TIMEOUT_MS);

  it("admits exactly one winner when legacy import races a pending membership reservation", async () => {
    const context = await startEmbeddedDatabase();
    const legacyLayer = createAsyncDataLayer(context.connections!, { projectId: "project-1" });
    const targetLayer = createAsyncDataLayer(context.connections!, { projectId: "project-2" });
    const legacy = await createLegacyBinding(legacyLayer, "concurrent-pending", "semantic-v2");
    const legacyStore = new AsyncRoomStore(legacyLayer);
    const targetStore = new AsyncRoomStore(targetLayer, { projectId: "project-2" });
    const roomId = "room-import-concurrent-pending-target";
    await targetStore.createRoom(
      {
        id: roomId,
        projectId: "project-2",
        objective: "Race one global Session identity through two supported entry points",
        protocolId: "implementation",
        protocolVersion: 1,
        now: "2026-07-17T09:03:00.000Z",
      },
      commandContext("event-concurrent-pending-room-created"),
    );
    await targetStore.transitionLifecycle(
      roomId,
      { to: "ready", expectedAggregateVersion: 0, now: "2026-07-17T09:03:30.000Z" },
      commandContext("event-concurrent-pending-room-ready"),
    );
    await targetStore.transitionLifecycle(
      roomId,
      { to: "running", expectedAggregateVersion: 1, now: "2026-07-17T09:04:00.000Z" },
      commandContext("event-concurrent-pending-room-running"),
    );
    const turnId = `${roomId}-turn-1`;
    await targetLayer.db.insert(roomTurns).values({
      id: turnId,
      projectId: "project-2",
      roomId,
      sequence: 1,
      protocolPhaseId: "implementation",
      membershipVersion: 0,
      state: "running",
      startedAt: "2026-07-17T09:04:00.000Z",
      endedAt: null,
    });
    await targetLayer.db
      .update(operationalRooms)
      .set({ activeTurnId: turnId, updatedAt: "2026-07-17T09:04:00.000Z" })
      .where(and(
        eq(operationalRooms.projectId, "project-2"),
        eq(operationalRooms.id, roomId),
      ));
    const target = await targetStore.getRoom(roomId);
    if (!target) throw new Error("target Room was not persisted");

    const outcomes = await Promise.allSettled([
      legacyStore.importLegacyHappierBinding(
        importInput("concurrent-pending", legacy.source),
        commandContext("event-import-concurrent-pending"),
      ),
      targetStore.requestMembershipChange(
        {
          roomId,
          changeId: "change-concurrent-legacy-pending",
          idempotencyKey: "membership:concurrent-legacy-pending",
          expectedAggregateVersion: target.room.aggregateVersion,
          expectedMembershipVersion: target.membershipVersion,
          activateAt: "next_turn_boundary",
          mutation: {
            action: "add",
            seat: {
              id: `${roomId}-seat-producer`,
              role: "producer",
              permissionScope: ["room:message"],
            },
            binding: {
              id: `${roomId}-binding-producer`,
              connectorId: "happier",
              providerId: legacy.source.providerId,
              nativeSessionId: legacy.source.nativeSessionId,
              happierSessionId: legacy.source.happierSessionId,
              serverProfileId: legacy.source.serverProfileId,
              machineId: legacy.source.machineId,
              hostId: legacy.source.hostId,
            },
          },
          reason: "concurrently reserve the legacy Session through membership",
          requestedAt: "2026-07-17T09:05:00.000Z",
        },
        commandContext("event-membership-concurrent-legacy-pending"),
      ),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
    );
    expect(["binding_identity_conflict", "legacy_binding_integrity_conflict"]).toContain(
      rejected?.reason?.code,
    );
    const activeOwners = await legacyLayer.db
      .select()
      .from(roomBindings)
      .where(and(
        eq(roomBindings.providerId, legacy.source.providerId),
        eq(roomBindings.nativeSessionId, legacy.source.nativeSessionId),
        eq(roomBindings.state, "attached"),
      ));
    const pendingOwners = await legacyLayer.db
      .select()
      .from(roomMembershipChanges)
      .where(and(
        eq(roomMembershipChanges.reservedProviderId, legacy.source.providerId),
        eq(roomMembershipChanges.reservedNativeSessionId, legacy.source.nativeSessionId),
        eq(roomMembershipChanges.state, "waiting_turn_boundary"),
      ));
    expect(activeOwners.length + pendingOwners.length).toBe(1);
  }, EMBEDDED_DATABASE_TIMEOUT_MS);

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
  }, EMBEDDED_DATABASE_TIMEOUT_MS);
});
