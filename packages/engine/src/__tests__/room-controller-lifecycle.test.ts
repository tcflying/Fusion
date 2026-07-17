import {
  createRoomAggregate,
  transitionRoomLifecycle,
  type RoomAggregateV1,
  type StoredRoomLeaseV1,
} from "@fusion/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as enginePublicApi from "../index.js";

interface RoomControllerStore {
  listRunnableRooms(): Promise<readonly RoomAggregateV1[]>;
}

interface RoomWorkerLeaseStore {
  getActiveLease(kind: "room_worker", resourceId: string): Promise<StoredRoomLeaseV1 | null>;
  acquireLease(input: {
    leaseId: string;
    roomId: string;
    kind: "room_worker";
    resourceId: string;
    holderId: string;
    hostId: string;
    expectedEpoch: number | null;
    now: string;
    expiresAt: string;
  }): Promise<
    | { ok: true; action: "acquired" | "taken_over"; lease: StoredRoomLeaseV1 }
    | { ok: false; reason: "active" | "stale_epoch"; current: StoredRoomLeaseV1 | null }
  >;
  renewLease(input: {
    leaseId: string;
    roomId: string;
    kind: "room_worker";
    resourceId: string;
    holderId: string;
    hostId: string;
    expectedEpoch: number;
    now: string;
    expiresAt: string;
  }): Promise<
    | { ok: true; lease: StoredRoomLeaseV1 }
    | { ok: false; reason: "not_found" | "stale_fence" | "expired"; current: StoredRoomLeaseV1 | null }
  >;
  releaseLease(input: {
    leaseId: string;
    roomId: string;
    kind: "room_worker";
    resourceId: string;
    holderId: string;
    hostId: string;
    expectedEpoch: number;
    now: string;
  }): Promise<
    | { ok: true; lease: StoredRoomLeaseV1 }
    | { ok: false; reason: "not_found" | "stale_fence" | "expired"; current: StoredRoomLeaseV1 | null }
  >;
  assertFence(input: {
    leaseId: string;
    roomId: string;
    kind: "room_worker";
    resourceId: string;
    holderId: string;
    hostId: string;
    expectedEpoch: number;
    now: string;
  }): Promise<StoredRoomLeaseV1>;
}

interface RoomWorkerRunInput {
  readonly room: RoomAggregateV1;
  readonly lease: StoredRoomLeaseV1;
  readonly signal: AbortSignal;
  readonly assertLeaseAuthority: () => Promise<StoredRoomLeaseV1>;
}

interface RoomControllerOptions {
  readonly projectId: string;
  readonly workerId: string;
  readonly hostId: string;
  readonly roomStore: RoomControllerStore;
  readonly leaseStore: RoomWorkerLeaseStore;
  readonly worker: {
    runRoom(input: RoomWorkerRunInput): Promise<void>;
  };
  readonly now: () => string;
  readonly createLeaseId: (roomId: string, workerId: string) => string;
  readonly leaseDurationMs: number;
  readonly pollIntervalMs: number;
  readonly shutdownGraceMs?: number;
  readonly workerRestartBaseDelayMs?: number;
  readonly workerRestartMaxDelayMs?: number;
  readonly workerRestartMaxRestarts?: number;
}

interface RoomControllerApi {
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
  reconcile(reason?: string): Promise<void>;
}

type RoomControllerConstructor = new (options: RoomControllerOptions) => RoomControllerApi;

const controllers: RoomControllerApi[] = [];

afterEach(async () => {
  for (const controller of controllers.splice(0)) {
    await controller.stop();
  }
  vi.useRealTimers();
});

function runningRoom(): RoomAggregateV1 {
  const draft = createRoomAggregate({
    id: "room-1",
    projectId: "project-1",
    objective: "Continue without browser clients",
    protocolId: "implementation",
    protocolVersion: 1,
    now: "2026-07-17T12:00:00.000Z",
  });
  const ready = transitionRoomLifecycle(draft, {
    to: "ready",
    expectedAggregateVersion: 0,
    now: "2026-07-17T12:00:01.000Z",
  });
  return transitionRoomLifecycle(ready, {
    to: "running",
    expectedAggregateVersion: 1,
    now: "2026-07-17T12:00:02.000Z",
  });
}

function runningRoomWithId(id: string): RoomAggregateV1 {
  const room = runningRoom();
  return {
    ...room,
    room: {
      ...room.room,
      id,
      objective: `Continue durable work for ${id}`,
    },
  };
}

function lease(expiresAt = "2026-07-17T12:01:00.000Z"): StoredRoomLeaseV1 {
  return {
    contractVersion: 1,
    id: "room-1:worker-1",
    roomId: "room-1",
    kind: "room_worker",
    resourceId: "room-1",
    holderId: "worker-1",
    hostId: "host-1",
    epoch: 1,
    acquiredAt: "2026-07-17T12:00:00.000Z",
    heartbeatAt: "2026-07-17T12:00:00.000Z",
    expiresAt,
    releasedAt: null,
  };
}

function createLeaseStore(): RoomWorkerLeaseStore {
  let current = lease();
  return {
    getActiveLease: vi.fn(async () => null),
    acquireLease: vi.fn(async () => ({ ok: true, action: "acquired", lease: current })),
    renewLease: vi.fn(async (input) => {
      current = { ...current, heartbeatAt: input.now, expiresAt: input.expiresAt };
      return { ok: true, lease: current };
    }),
    releaseLease: vi.fn(async (input) => {
      current = { ...current, releasedAt: input.now };
      return { ok: true, lease: current };
    }),
    assertFence: vi.fn(async () => current),
  };
}

function createTakeoverLeaseStore(): RoomWorkerLeaseStore & {
  readonly history: readonly StoredRoomLeaseV1[];
  readonly staleWorkerRejections: number;
} {
  let current: StoredRoomLeaseV1 | null = null;
  const history: StoredRoomLeaseV1[] = [];
  let staleWorkerRejections = 0;

  const acquireLease = vi.fn(async (
    input: Parameters<RoomWorkerLeaseStore["acquireLease"]>[0],
  ): ReturnType<RoomWorkerLeaseStore["acquireLease"]> => {
    if (current && Date.parse(current.expiresAt) > Date.parse(input.now)) {
      return { ok: false, reason: "active", current };
    }
    if (current && input.expectedEpoch !== current.epoch) {
      staleWorkerRejections += 1;
      return { ok: false, reason: "stale_epoch", current };
    }
    if (!current && input.expectedEpoch !== null && input.expectedEpoch !== 0) {
      staleWorkerRejections += 1;
      return { ok: false, reason: "stale_epoch", current: null };
    }

    const action = current ? "taken_over" as const : "acquired" as const;
    const nextEpoch = (current?.epoch ?? 0) + 1;
    if (current) {
      current = { ...current, releasedAt: input.now };
      history[history.length - 1] = current;
    }
    current = {
      contractVersion: 1,
      id: input.leaseId,
      roomId: input.roomId,
      kind: input.kind,
      resourceId: input.resourceId,
      holderId: input.holderId,
      hostId: input.hostId,
      epoch: nextEpoch,
      acquiredAt: input.now,
      heartbeatAt: input.now,
      expiresAt: input.expiresAt,
      releasedAt: null,
    };
    history.push(current);
    return { ok: true, action, lease: current };
  });

  const fenceMatches = (
    input: Parameters<RoomWorkerLeaseStore["assertFence"]>[0],
  ): boolean => Boolean(
    current
    && current.id === input.leaseId
    && current.roomId === input.roomId
    && current.kind === input.kind
    && current.resourceId === input.resourceId
    && current.holderId === input.holderId
    && current.hostId === input.hostId
    && current.epoch === input.expectedEpoch
    && current.releasedAt === null,
  );

  return {
    get history() {
      return history;
    },
    get staleWorkerRejections() {
      return staleWorkerRejections;
    },
    getActiveLease: vi.fn(async () => current),
    acquireLease,
    renewLease: vi.fn(async (input) => {
      if (!current) return { ok: false, reason: "not_found", current: null };
      if (!fenceMatches(input)) {
        staleWorkerRejections += 1;
        return { ok: false, reason: "stale_fence", current };
      }
      if (Date.parse(current.expiresAt) <= Date.parse(input.now)) {
        staleWorkerRejections += 1;
        return { ok: false, reason: "expired", current };
      }
      current = { ...current, heartbeatAt: input.now, expiresAt: input.expiresAt };
      history[history.length - 1] = current;
      return { ok: true, lease: current };
    }),
    releaseLease: vi.fn(async (input) => {
      if (!current) return { ok: false, reason: "not_found", current: null };
      if (!fenceMatches(input)) {
        staleWorkerRejections += 1;
        return { ok: false, reason: "stale_fence", current };
      }
      current = { ...current, releasedAt: input.now };
      history[history.length - 1] = current;
      return { ok: true, lease: current };
    }),
    assertFence: vi.fn(async (input) => {
      if (!current || !fenceMatches(input) || Date.parse(current.expiresAt) <= Date.parse(input.now)) {
        staleWorkerRejections += 1;
        throw new Error(
          `Stale Room worker fence rejected at epoch ${input.expectedEpoch}`,
        );
      }
      return current;
    }),
  };
}

function requireRoomController(reason: string): RoomControllerConstructor {
  const candidate = (enginePublicApi as unknown as {
    RoomController?: RoomControllerConstructor;
  }).RoomController;
  expect(candidate, reason).toBeTypeOf("function");
  return candidate!;
}

/*
FNXC:SessionRoomController 2026-07-17-20:04:
Operational Room work is owned by the backend controller. Closing every browser
client must not cancel the Room worker, its lease, or its authoritative timer.
*/
describe("RoomController backend lifecycle", () => {
  it("continues backend Room work after all browser clients disconnect", async () => {
    vi.useFakeTimers();
    const workerSignals: AbortSignal[] = [];
    const runRoom = vi.fn(async ({ signal }: RoomWorkerRunInput) => {
      workerSignals.push(signal);
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    });
    const leaseStore = createLeaseStore();
    const RoomController = requireRoomController(
      "backend-owned Room lifecycle requires the production RoomController export",
    );
    const controller = new RoomController({
      projectId: "project-1",
      workerId: "worker-1",
      hostId: "host-1",
      roomStore: {
        listRunnableRooms: vi.fn(async () => [runningRoom()]),
      },
      leaseStore,
      worker: { runRoom },
      recordRunAuditEvent: async () => undefined,
      now: () => "2026-07-17T12:00:00.000Z",
      createLeaseId: () => "lease-worker-1-incarnation-1",
      leaseDurationMs: 60_000,
      pollIntervalMs: 1_000,
    });
    controllers.push(controller);

    await controller.start();
    expect(runRoom).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(runRoom).toHaveBeenCalledTimes(1);
    expect(leaseStore.renewLease).toHaveBeenCalled();
    expect(workerSignals).toHaveLength(1);
    expect(workerSignals[0]?.aborted).toBe(false);
  });

  /*
  FNXC:SessionRoomController 2026-07-17-20:11:
  A Room worker must acquire the persisted room_worker lease before it can run
  any Room work, using the Room ID as the fenced resource identity.
  */
  it("acquires a fenced room_worker lease before running the Room worker", async () => {
    const runRoom = vi.fn(async () => undefined);
    const leaseStore = createLeaseStore();
    const RoomController = requireRoomController(
      "Room worker lease acquisition requires the production RoomController export",
    );
    const controller = new RoomController({
      projectId: "project-1",
      workerId: "worker-1",
      hostId: "host-1",
      roomStore: {
        listRunnableRooms: vi.fn(async () => [runningRoom()]),
      },
      leaseStore,
      worker: { runRoom },
      recordRunAuditEvent: async () => undefined,
      now: () => "2026-07-17T12:00:00.000Z",
      createLeaseId: () => "lease-worker-1-incarnation-1",
      leaseDurationMs: 60_000,
      pollIntervalMs: 1_000,
    });
    controllers.push(controller);

    await controller.start();

    expect(leaseStore.acquireLease).toHaveBeenCalledWith({
      leaseId: "lease-worker-1-incarnation-1",
      roomId: "room-1",
      kind: "room_worker",
      resourceId: "room-1",
      holderId: "worker-1",
      hostId: "host-1",
      expectedEpoch: null,
      now: "2026-07-17T12:00:00.000Z",
      expiresAt: "2026-07-17T12:01:00.000Z",
    });
    expect(vi.mocked(leaseStore.acquireLease).mock.invocationCallOrder[0]).toBeLessThan(
      runRoom.mock.invocationCallOrder[0]!,
    );
  });

  /*
  FNXC:SessionRoomController 2026-07-17-20:12:
  Restart recovery must take over only an expired Room-worker lease, advance its
  fencing epoch, and prevent the old epoch from committing after it wakes up.
  */
  it("takes over an expired restart lease with a higher epoch and rejects the stale worker", async () => {
    vi.useFakeTimers();
    let now = "2026-07-17T12:00:00.000Z";
    const leaseStore = createTakeoverLeaseStore();
    const startedEpochs: number[] = [];
    const workerSignals = new Map<number, AbortSignal>();
    const workerAuthority = new Map<number, () => Promise<StoredRoomLeaseV1>>();
    const createWorker = () => ({
      runRoom: vi.fn(async ({
        lease: workerLease,
        signal,
        assertLeaseAuthority,
      }: RoomWorkerRunInput) => {
        startedEpochs.push(workerLease.epoch);
        workerSignals.set(workerLease.epoch, signal);
        workerAuthority.set(workerLease.epoch, assertLeaseAuthority);
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      }),
    });
    const RoomController = requireRoomController(
      "expired Room-worker restart takeover requires the production RoomController export",
    );
    const firstController = new RoomController({
      projectId: "project-1",
      workerId: "worker-1",
      hostId: "host-1",
      roomStore: { listRunnableRooms: vi.fn(async () => [runningRoom()]) },
      leaseStore,
      worker: createWorker(),
      recordRunAuditEvent: async () => undefined,
      now: () => now,
      createLeaseId: () => "lease-worker-1-incarnation-1",
      leaseDurationMs: 60_000,
      pollIntervalMs: 1_000,
    });
    controllers.push(firstController);

    await firstController.start();
    expect(leaseStore.history.map((entry) => entry.epoch)).toEqual([1]);
    expect(startedEpochs).toEqual([1]);

    now = "2026-07-17T12:02:00.000Z";
    const replacementController = new RoomController({
      projectId: "project-1",
      workerId: "worker-2",
      hostId: "host-2",
      roomStore: { listRunnableRooms: vi.fn(async () => [runningRoom()]) },
      leaseStore,
      worker: createWorker(),
      recordRunAuditEvent: async () => undefined,
      now: () => now,
      createLeaseId: () => "lease-worker-2-incarnation-1",
      leaseDurationMs: 60_000,
      pollIntervalMs: 1_000,
    });
    controllers.push(replacementController);

    await replacementController.start();
    expect(leaseStore.history.map((entry) => entry.epoch)).toEqual([1, 2]);
    expect(leaseStore.history[0]?.releasedAt).toBe("2026-07-17T12:02:00.000Z");
    expect(startedEpochs).toEqual([1, 2]);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(leaseStore.staleWorkerRejections).toBeGreaterThan(0);
    expect(workerSignals.get(1)?.aborted).toBe(true);
    expect(workerSignals.get(2)?.aborted).toBe(false);
    await expect(
      workerAuthority.get(1)?.(),
      "the worker-facing authority seam must delegate to leaseStore.assertFence",
    ).rejects.toThrow("Stale Room worker fence rejected at epoch 1");
    expect(leaseStore.assertFence).toHaveBeenCalledWith({
      leaseId: "lease-worker-1-incarnation-1",
      roomId: "room-1",
      kind: "room_worker",
      resourceId: "room-1",
      holderId: "worker-1",
      hostId: "host-1",
      expectedEpoch: 1,
      now,
    });
  });

  it("renews healthy Rooms even while a different Room lease operation is hung", async () => {
    const rooms = [runningRoomWithId("room-1"), runningRoomWithId("room-2")];
    const active = new Map<string, StoredRoomLeaseV1>();
    let hangRoomOneRenew = false;
    let resolveRoomOneRenew!: () => void;
    const roomOneRenewGate = new Promise<void>((resolve) => {
      resolveRoomOneRenew = resolve;
    });
    const renewedRooms: string[] = [];
    const leaseStore: RoomWorkerLeaseStore = {
      getActiveLease: vi.fn(async () => null),
      acquireLease: vi.fn(async (input) => {
        const acquired: StoredRoomLeaseV1 = {
          contractVersion: 1,
          id: input.leaseId,
          roomId: input.roomId,
          kind: "room_worker",
          resourceId: input.resourceId,
          holderId: input.holderId,
          hostId: input.hostId,
          epoch: 1,
          acquiredAt: input.now,
          heartbeatAt: input.now,
          expiresAt: input.expiresAt,
          releasedAt: null,
        };
        active.set(input.roomId, acquired);
        return { ok: true as const, action: "acquired" as const, lease: acquired };
      }),
      renewLease: vi.fn(async (input) => {
        if (input.roomId === "room-1" && hangRoomOneRenew) {
          await roomOneRenewGate;
        }
        renewedRooms.push(input.roomId);
        const current = active.get(input.roomId)!;
        const renewed = { ...current, heartbeatAt: input.now, expiresAt: input.expiresAt };
        active.set(input.roomId, renewed);
        return { ok: true as const, lease: renewed };
      }),
      releaseLease: vi.fn(async (input) => {
        const current = active.get(input.roomId)!;
        const released = { ...current, releasedAt: input.now };
        active.set(input.roomId, released);
        return { ok: true as const, lease: released };
      }),
      assertFence: vi.fn(async (input) => active.get(input.roomId)!),
    };
    const RoomController = requireRoomController("per-Room renewal isolation requires RoomController");
    const controller = new RoomController({
      projectId: "project-1",
      workerId: "worker-1",
      hostId: "host-1",
      roomStore: { listRunnableRooms: vi.fn(async () => rooms) },
      leaseStore,
      worker: {
        runRoom: async ({ signal }) => new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
      },
      recordRunAuditEvent: async () => undefined,
      now: () => "2026-07-17T12:00:00.000Z",
      createLeaseId: (roomId) => `lease-${roomId}`,
      leaseDurationMs: 60_000,
      pollIntervalMs: 1_000,
    });
    controllers.push(controller);
    await controller.start();

    hangRoomOneRenew = true;
    const reconcile = controller.reconcile("fair-renewal-test");
    await Promise.resolve();
    await Promise.resolve();
    try {
      expect(
        renewedRooms,
        "room-2 renewal must start without waiting for room-1's hung renewal",
      ).toContain("room-2");
    } finally {
      resolveRoomOneRenew();
      await reconcile;
    }
  });

  it("uses one total shutdown budget across hung reconcile, workers, and lease release", async () => {
    vi.useFakeTimers();
    let listCalls = 0;
    let resolveReconcile!: (rooms: readonly RoomAggregateV1[]) => void;
    const reconcileGate = new Promise<readonly RoomAggregateV1[]>((resolve) => {
      resolveReconcile = resolve;
    });
    let resolveWorker!: () => void;
    const workerGate = new Promise<void>((resolve) => {
      resolveWorker = resolve;
    });
    let resolveRelease!: () => void;
    const releaseGate = new Promise<void>((resolve) => {
      resolveRelease = resolve;
    });
    const leaseStore = createLeaseStore();
    leaseStore.releaseLease = vi.fn(async (input) => {
      await releaseGate;
      return { ok: true, lease: { ...lease(), releasedAt: input.now } };
    });
    const RoomController = requireRoomController("bounded shutdown requires RoomController");
    const controller = new RoomController({
      projectId: "project-1",
      workerId: "worker-1",
      hostId: "host-1",
      roomStore: {
        listRunnableRooms: vi.fn(async () => {
          listCalls += 1;
          return listCalls === 1 ? [runningRoom()] : reconcileGate;
        }),
      },
      leaseStore,
      worker: { runRoom: vi.fn(async () => workerGate) },
      recordRunAuditEvent: async () => undefined,
      now: () => "2026-07-17T12:00:00.000Z",
      createLeaseId: () => "lease-worker-1-incarnation-1",
      leaseDurationMs: 60_000,
      pollIntervalMs: 1_000,
      shutdownGraceMs: 25,
    });
    controllers.push(controller);
    await controller.start();
    void controller.reconcile("hung-reconcile");
    await Promise.resolve();

    let stopped = false;
    const stopPromise = Promise.resolve(controller.stop()).then(() => {
      stopped = true;
    });
    try {
      await vi.advanceTimersByTimeAsync(25);
      expect(stopped, "stop must return after one total 25ms budget").toBe(true);
    } finally {
      resolveReconcile([]);
      resolveWorker();
      resolveRelease();
      await vi.runAllTimersAsync();
      await stopPromise;
    }
  });

  it("backs off abnormal worker exits, exhausts a restart budget, and resets only on projection change", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T12:00:00.000Z"));
    let projection = runningRoom();
    let epoch = 0;
    const leaseStore: RoomWorkerLeaseStore = {
      getActiveLease: vi.fn(async () => null),
      acquireLease: vi.fn(async (input) => {
        epoch += 1;
        const acquired: StoredRoomLeaseV1 = {
          contractVersion: 1,
          id: `${input.leaseId}-${epoch}`,
          roomId: input.roomId,
          kind: "room_worker",
          resourceId: input.resourceId,
          holderId: input.holderId,
          hostId: input.hostId,
          epoch,
          acquiredAt: input.now,
          heartbeatAt: input.now,
          expiresAt: input.expiresAt,
          releasedAt: null,
        };
        return { ok: true as const, action: "acquired" as const, lease: acquired };
      }),
      renewLease: vi.fn(async () => {
        throw new Error("a completed worker should not be renewed");
      }),
      releaseLease: vi.fn(async (input) => ({
        ok: true as const,
        lease: { ...lease(), id: input.leaseId, epoch: input.expectedEpoch, releasedAt: input.now },
      })),
      assertFence: vi.fn(async () => lease()),
    };
    const runRoom = vi.fn(async () => {
      if (runRoom.mock.calls.length === 2) throw new Error("deterministic worker failure");
    });
    const RoomController = requireRoomController("bounded restart supervision requires RoomController");
    const controller = new RoomController({
      projectId: "project-1",
      workerId: "worker-1",
      hostId: "host-1",
      roomStore: { listRunnableRooms: vi.fn(async () => [projection]) },
      leaseStore,
      worker: { runRoom },
      recordRunAuditEvent: async () => undefined,
      now: () => new Date().toISOString(),
      createLeaseId: () => "lease-room-1",
      leaseDurationMs: 60_000,
      pollIntervalMs: 100,
      workerRestartBaseDelayMs: 100,
      workerRestartMaxDelayMs: 400,
      workerRestartMaxRestarts: 2,
    });
    controllers.push(controller);

    await controller.start();
    await Promise.resolve();
    expect(runRoom).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(99);
    expect(runRoom).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(runRoom).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(199);
    expect(runRoom).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(runRoom).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runRoom, "the exhausted projection must not create more lease epochs").toHaveBeenCalledTimes(3);
    expect(leaseStore.acquireLease).toHaveBeenCalledTimes(3);

    projection = {
      ...projection,
      room: {
        ...projection.room,
        aggregateVersion: projection.room.aggregateVersion + 1,
        updatedAt: new Date().toISOString(),
      },
    };
    await controller.reconcile("projection-changed");
    await Promise.resolve();
    expect(runRoom, "a durable projection change resets the restart budget").toHaveBeenCalledTimes(4);
  });
});
