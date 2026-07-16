import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AsyncRoomLeaseStore } from "../../async-room-lease-store.js";
import { AsyncRoomStore } from "../../async-room-store.js";
import { createConnectionSetFromUrl, type PostgresConnections } from "../../postgres/connection.js";
import { createAsyncDataLayer } from "../../postgres/data-layer.js";
import { EmbeddedPostgresLifecycle } from "../../postgres/embedded-lifecycle.js";
import { applySchemaBaseline } from "../../postgres/schema-applier.js";
import { roomBindings, roomSeats } from "../../postgres/schema/room.js";

interface EmbeddedTestContext {
  readonly dataDir: string;
  readonly lifecycle: EmbeddedPostgresLifecycle;
  connections: PostgresConnections | null;
}

const contexts: EmbeddedTestContext[] = [];

async function startEmbeddedDatabase(): Promise<EmbeddedTestContext> {
  const dataDir = mkdtempSync(join(tmpdir(), "fusion-room-lease-store-"));
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

async function createRoom(store: AsyncRoomStore, roomId: string, eventId: string): Promise<void> {
  await store.createRoom(
    {
      id: roomId,
      projectId: "project-1",
      objective: `Lease ${roomId}`,
      protocolId: "implementation",
      protocolVersion: 1,
      now: "2026-07-17T05:00:00.000Z",
    },
    {
      eventId,
      actorType: "human",
      actorId: "operator-1",
      correlationId: eventId,
      causationId: null,
      occurredAt: "2026-07-17T05:00:00.000Z",
    },
  );
}

describe("AsyncRoomLeaseStore PostgreSQL fencing", () => {
  it("increments epochs on expired Room-worker takeover and rejects the stale writer", async () => {
    const context = await startEmbeddedDatabase();
    const layer = createAsyncDataLayer(context.connections!, { projectId: "project-1" });
    await createRoom(new AsyncRoomStore(layer), "room-lease-1", "event-room-lease-1");
    const firstStore = new AsyncRoomLeaseStore(layer);
    const takeoverStore = new AsyncRoomLeaseStore(layer);

    const acquired = await firstStore.acquireLease({
      leaseId: "lease-room-worker-1",
      roomId: "room-lease-1",
      kind: "room_worker",
      resourceId: "room-lease-1",
      holderId: "controller-worker-1",
      hostId: "windows-host-1",
      expectedEpoch: null,
      now: "2026-07-17T05:01:00.000Z",
      expiresAt: "2026-07-17T05:03:00.000Z",
    });
    expect(acquired).toMatchObject({ ok: true, action: "acquired" });
    if (!acquired.ok) throw new Error("initial Room-worker lease was not acquired");
    expect(acquired.lease).toMatchObject({ epoch: 1, heartbeatAt: "2026-07-17T05:01:00.000Z" });

    const staleRenewal = await firstStore.renewLease({
      leaseId: acquired.lease.id,
      roomId: acquired.lease.roomId,
      kind: acquired.lease.kind,
      resourceId: acquired.lease.resourceId,
      holderId: acquired.lease.holderId,
      hostId: acquired.lease.hostId,
      expectedEpoch: 0,
      now: "2026-07-17T05:02:00.000Z",
      expiresAt: "2026-07-17T05:04:00.000Z",
    });
    expect(staleRenewal).toMatchObject({ ok: false, reason: "stale_fence" });

    const renewed = await firstStore.renewLease({
      leaseId: acquired.lease.id,
      roomId: acquired.lease.roomId,
      kind: acquired.lease.kind,
      resourceId: acquired.lease.resourceId,
      holderId: acquired.lease.holderId,
      hostId: acquired.lease.hostId,
      expectedEpoch: 1,
      now: "2026-07-17T05:02:00.000Z",
      expiresAt: "2026-07-17T05:04:00.000Z",
    });
    expect(renewed).toMatchObject({ ok: true, lease: { epoch: 1 } });

    const earlyTakeover = await takeoverStore.acquireLease({
      leaseId: "lease-room-worker-2-early",
      roomId: "room-lease-1",
      kind: "room_worker",
      resourceId: "room-lease-1",
      holderId: "controller-worker-2",
      hostId: "windows-host-2",
      expectedEpoch: 1,
      now: "2026-07-17T05:03:00.000Z",
      expiresAt: "2026-07-17T05:06:00.000Z",
    });
    expect(earlyTakeover).toMatchObject({ ok: false, reason: "active" });

    const takeover = await takeoverStore.acquireLease({
      leaseId: "lease-room-worker-2",
      roomId: "room-lease-1",
      kind: "room_worker",
      resourceId: "room-lease-1",
      holderId: "controller-worker-2",
      hostId: "windows-host-2",
      expectedEpoch: 1,
      now: "2026-07-17T05:05:00.000Z",
      expiresAt: "2026-07-17T05:08:00.000Z",
    });
    expect(takeover).toMatchObject({ ok: true, action: "taken_over", lease: { epoch: 2 } });
    if (!takeover.ok) throw new Error("expired Room-worker lease was not taken over");

    await expect(
      firstStore.assertFence({
        leaseId: acquired.lease.id,
        roomId: acquired.lease.roomId,
        kind: acquired.lease.kind,
        resourceId: acquired.lease.resourceId,
        holderId: acquired.lease.holderId,
        hostId: acquired.lease.hostId,
        expectedEpoch: 1,
        now: "2026-07-17T05:05:01.000Z",
      }),
    ).rejects.toThrow(/stale.*fence/i);
    await expect(
      takeoverStore.assertFence({
        leaseId: takeover.lease.id,
        roomId: takeover.lease.roomId,
        kind: takeover.lease.kind,
        resourceId: takeover.lease.resourceId,
        holderId: takeover.lease.holderId,
        hostId: takeover.lease.hostId,
        expectedEpoch: 2,
        now: "2026-07-17T05:05:01.000Z",
      }),
    ).resolves.toMatchObject({ epoch: 2 });

    const staleRelease = await firstStore.releaseLease({
      leaseId: acquired.lease.id,
      roomId: acquired.lease.roomId,
      kind: acquired.lease.kind,
      resourceId: acquired.lease.resourceId,
      holderId: acquired.lease.holderId,
      hostId: acquired.lease.hostId,
      expectedEpoch: 1,
      now: "2026-07-17T05:05:02.000Z",
    });
    expect(staleRelease).toMatchObject({ ok: false, reason: "stale_fence" });

    const history = await takeoverStore.listLeaseHistory("room_worker", "room-lease-1");
    expect(history.map((lease) => lease.epoch)).toEqual([1, 2]);
    expect(history[0]?.releasedAt).toBe("2026-07-17T05:05:00.000Z");
    expect(history[1]?.releasedAt).toBeNull();
  });

  it("serializes concurrent sender and project-wide workspace claimants", async () => {
    const context = await startEmbeddedDatabase();
    const layer = createAsyncDataLayer(context.connections!, { projectId: "project-1" });
    const roomStore = new AsyncRoomStore(layer);
    await createRoom(roomStore, "room-concurrency-1", "event-room-concurrency-1");
    await createRoom(roomStore, "room-concurrency-2", "event-room-concurrency-2");
    await layer.db.insert(roomSeats).values({
      id: "seat-concurrency-1",
      projectId: "project-1",
      roomId: "room-concurrency-1",
      role: "producer",
      roleVersion: 1,
      roleHistory: [],
      permissionScope: ["session:send"],
      state: "active",
      activeBindingId: "binding-concurrency-1",
      createdAt: "2026-07-17T06:00:00.000Z",
      updatedAt: "2026-07-17T06:00:00.000Z",
    });
    await layer.db.insert(roomBindings).values({
      id: "binding-concurrency-1",
      projectId: "project-1",
      roomId: "room-concurrency-1",
      seatId: "seat-concurrency-1",
      generation: 1,
      connectorId: "happier",
      providerId: "codex",
      nativeSessionId: "codex-thread-concurrency-1",
      happierSessionId: "happier-concurrency-1",
      serverProfileId: "server-1",
      hostId: "windows-host-1",
      state: "attached",
      attachedAt: "2026-07-17T06:00:00.000Z",
    });

    const storeA = new AsyncRoomLeaseStore(layer);
    const storeB = new AsyncRoomLeaseStore(layer);
    await expect(
      storeB.acquireLease({
        leaseId: "lease-sender-wrong-host",
        roomId: "room-concurrency-1",
        kind: "sender",
        resourceId: "binding-concurrency-1",
        holderId: "sender-wrong-host",
        hostId: "windows-host-2",
        expectedEpoch: null,
        now: "2026-07-17T06:00:30.000Z",
        expiresAt: "2026-07-17T06:02:30.000Z",
      }),
    ).rejects.toThrow(/host windows-host-1/i);
    const senderResults = await Promise.all([
      storeA.acquireLease({
        leaseId: "lease-sender-a",
        roomId: "room-concurrency-1",
        kind: "sender",
        resourceId: "binding-concurrency-1",
        holderId: "sender-a",
        hostId: "windows-host-1",
        expectedEpoch: null,
        now: "2026-07-17T06:01:00.000Z",
        expiresAt: "2026-07-17T06:03:00.000Z",
      }),
      storeB.acquireLease({
        leaseId: "lease-sender-b",
        roomId: "room-concurrency-1",
        kind: "sender",
        resourceId: "binding-concurrency-1",
        holderId: "sender-b",
        hostId: "windows-host-1",
        expectedEpoch: null,
        now: "2026-07-17T06:01:00.000Z",
        expiresAt: "2026-07-17T06:03:00.000Z",
      }),
    ]);
    expect(senderResults.filter((result) => result.ok)).toHaveLength(1);
    expect(senderResults.filter((result) => !result.ok)).toHaveLength(1);
    expect(await storeA.listLeaseHistory("sender", "binding-concurrency-1")).toHaveLength(1);

    const workspaceResults = await Promise.all([
      storeA.acquireLease({
        leaseId: "lease-workspace-a",
        roomId: "room-concurrency-1",
        kind: "workspace",
        resourceId: "G:\\codex-project\\shared-workspace",
        holderId: "workspace-writer-a",
        hostId: "windows-host-1",
        expectedEpoch: null,
        now: "2026-07-17T06:01:00.000Z",
        expiresAt: "2026-07-17T06:03:00.000Z",
      }),
      storeB.acquireLease({
        leaseId: "lease-workspace-b",
        roomId: "room-concurrency-2",
        kind: "workspace",
        resourceId: "G:\\codex-project\\shared-workspace",
        holderId: "workspace-writer-b",
        hostId: "windows-host-2",
        expectedEpoch: null,
        now: "2026-07-17T06:01:00.000Z",
        expiresAt: "2026-07-17T06:03:00.000Z",
      }),
    ]);
    expect(workspaceResults.filter((result) => result.ok)).toHaveLength(1);
    expect(workspaceResults.filter((result) => !result.ok)).toHaveLength(1);
    expect(
      await storeA.listLeaseHistory("workspace", "G:\\codex-project\\shared-workspace"),
    ).toHaveLength(1);
  });
});
