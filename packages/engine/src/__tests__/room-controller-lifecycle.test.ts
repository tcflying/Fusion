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
}

interface RoomControllerApi {
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
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
    const createWorker = () => ({
      runRoom: vi.fn(async ({ lease: workerLease, signal }: RoomWorkerRunInput) => {
        startedEpochs.push(workerLease.epoch);
        workerSignals.set(workerLease.epoch, signal);
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
    await expect(leaseStore.assertFence({
      leaseId: "lease-worker-1-incarnation-1",
      roomId: "room-1",
      kind: "room_worker",
      resourceId: "room-1",
      holderId: "worker-1",
      hostId: "host-1",
      expectedEpoch: 1,
      now,
    })).rejects.toThrow("Stale Room worker fence rejected at epoch 1");
  });
});
