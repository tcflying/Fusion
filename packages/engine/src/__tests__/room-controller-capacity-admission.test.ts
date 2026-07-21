import {
  createRoomAggregate,
  transitionRoomLifecycle,
  type RoomAggregateV1,
  type StoredRoomLeaseV1,
} from "@fusion/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RoomController,
  type RoomControllerLeaseStore,
  type RoomTaskDispatcher,
  type RoomWorkerRunInput,
} from "../room-controller.js";

const NOW = "2026-07-19T15:36:00.000Z";
const CAPACITY_LEASE_TTL_MS = 60_000;
const CAPACITY_RENEWAL_INTERVAL_MS = 5_000;

const controllers: RoomController[] = [];

afterEach(async () => {
  for (const controller of controllers.splice(0)) {
    await controller.stop();
  }
});

function runningRoom(): RoomAggregateV1 {
  const draft = createRoomAggregate({
    id: "room-capacity-admission",
    projectId: "project-capacity-admission",
    objective: "Exercise controller-owned global capacity admission",
    protocolId: "implementation",
    protocolVersion: 1,
    now: "2026-07-19T15:35:57.000Z",
  });
  const ready = transitionRoomLifecycle(draft, {
    to: "ready",
    expectedAggregateVersion: 0,
    now: "2026-07-19T15:35:58.000Z",
  });
  return transitionRoomLifecycle(ready, {
    to: "running",
    expectedAggregateVersion: 1,
    now: "2026-07-19T15:35:59.000Z",
  });
}

function lease(): StoredRoomLeaseV1 {
  return {
    contractVersion: 1,
    id: "lease-capacity-admission",
    roomId: "room-capacity-admission",
    kind: "room_worker",
    resourceId: "room-capacity-admission",
    holderId: "worker-capacity-admission",
    hostId: "host-capacity-admission",
    epoch: 7,
    acquiredAt: NOW,
    heartbeatAt: NOW,
    expiresAt: "2026-07-19T15:37:00.000Z",
    releasedAt: null,
  };
}

interface LeaseStoreHarness extends RoomControllerLeaseStore {
  readonly acquireInputs: Array<Parameters<RoomControllerLeaseStore["acquireLease"]>[0]>;
  readonly renewInputs: Array<Parameters<RoomControllerLeaseStore["renewLease"]>[0]>;
}

function createLeaseStore(onRelease?: () => void): LeaseStoreHarness {
  let current = lease();
  const acquireInputs: LeaseStoreHarness["acquireInputs"] = [];
  const renewInputs: LeaseStoreHarness["renewInputs"] = [];
  return {
    acquireLease: vi.fn(async (input) => {
      acquireInputs.push(input);
      current = {
        ...current,
        acquiredAt: input.now,
        heartbeatAt: input.now,
        expiresAt: input.expiresAt,
        releasedAt: null,
      };
      return { ok: true as const, action: "acquired" as const, lease: current };
    }),
    renewLease: vi.fn(async (input) => {
      renewInputs.push(input);
      current = { ...current, heartbeatAt: input.now, expiresAt: input.expiresAt };
      return { ok: true as const, lease: current };
    }),
    releaseLease: vi.fn(async (input) => {
      current = { ...current, releasedAt: input.now };
      onRelease?.();
      return { ok: true as const, lease: current };
    }),
    assertFence: vi.fn(async () => current),
    acquireInputs,
    renewInputs,
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function acquiredGlobal() {
  return {
    acquire: vi.fn(async () => ({
      action: "acquired" as const,
      reason: "capacity_admitted" as const,
      replayed: false,
      claimId: "capacity-claim-room-capacity-admission",
      fence: 7,
    })),
    release: vi.fn(async () => ({
      action: "released" as const,
      reason: "capacity_admitted" as const,
      replayed: false,
      claimId: "capacity-claim-room-capacity-admission",
      fence: 7,
    })),
    renew: vi.fn(async () => ({
      action: "renewed" as const,
      reason: "capacity_admitted" as const,
      replayed: false,
      claimId: "capacity-claim-room-capacity-admission",
      fence: 7,
    })),
  };
}

function withheldGlobal() {
  return {
    acquire: vi.fn(async () => ({
      action: "held" as const,
      reason: "global_capacity_exhausted" as const,
      replayed: false,
      claimId: null,
      fence: null,
    })),
    release: vi.fn(async () => ({
      action: "released" as const,
      reason: "capacity_admitted" as const,
      replayed: false,
      claimId: "capacity-claim-room-capacity-admission",
      fence: 7,
    })),
    renew: vi.fn(async () => ({
      action: "held" as const,
      reason: "global_capacity_exhausted" as const,
      replayed: false,
      claimId: null,
      fence: null,
    })),
  };
}

function capacityAdmission(
  global: ReturnType<typeof acquiredGlobal>,
  timings: {
    readonly leaseTtlMs?: number;
    readonly renewalIntervalMs?: number;
  } = {},
) {
  return {
    globalAccounting: global,
    workClass: "normal" as const,
    slots: 1,
    leaseTtlMs: timings.leaseTtlMs ?? CAPACITY_LEASE_TTL_MS,
    renewalIntervalMs: timings.renewalIntervalMs ?? CAPACITY_RENEWAL_INTERVAL_MS,
    createClaimId: () => "capacity-claim-room-capacity-admission",
  };
}

function createController(input: {
  readonly worker: { runRoom(input: RoomWorkerRunInput): Promise<void> };
  readonly leaseStore?: RoomControllerLeaseStore;
  readonly capacityAdmission: ReturnType<typeof capacityAdmission>;
  readonly taskDispatcher?: RoomTaskDispatcher;
  readonly audit?: ReturnType<typeof vi.fn>;
  readonly now?: () => string;
  readonly leaseDurationMs?: number;
  readonly pollIntervalMs?: number;
}): RoomController {
  const room = runningRoom();
  const roomStore = {
    listRunnableRooms: async () => [room],
    ...(input.taskDispatcher ? {
      assertWorkerAuthority: async ({ lease: activeLease }: { readonly lease: StoredRoomLeaseV1 }) => ({
        lease: activeLease,
        posture: {
          lifecycleState: "running" as const,
          aggregateVersion: room.room.aggregateVersion,
          humanPaused: false,
          approvalState: "none" as const,
        },
      }),
    } : {}),
  };
  const controller = new RoomController({
    projectId: room.room.projectId,
    workerId: "worker-capacity-admission",
    hostId: "host-capacity-admission",
    roomStore,
    leaseStore: input.leaseStore ?? createLeaseStore(),
    worker: input.worker,
    ...(input.taskDispatcher ? { taskDispatcher: input.taskDispatcher } : {}),
    recordRunAuditEvent: input.audit ?? vi.fn(async () => undefined),
    now: input.now ?? (() => NOW),
    createLeaseId: () => "lease-capacity-admission",
    ...(input.leaseDurationMs === undefined ? {} : { leaseDurationMs: input.leaseDurationMs }),
    ...(input.pollIntervalMs === undefined ? {} : { pollIntervalMs: input.pollIntervalMs }),
    capacityAdmission: input.capacityAdmission,
  });
  controllers.push(controller);
  return controller;
}

describe("RoomController global capacity admission", () => {
  it("acquires durable global capacity before the dispatcher may claim ready work", async () => {
    const workerStarted = deferred<void>();
    const order: string[] = [];
    const global = acquiredGlobal();
    global.acquire.mockImplementation(async () => {
      order.push("capacity");
      return {
        action: "acquired" as const,
        reason: "capacity_admitted" as const,
        replayed: false,
        claimId: "capacity-claim-room-capacity-admission",
        fence: 7,
      };
    });
    const taskDispatcher = {
      dispatchReadyTasks: vi.fn(async ({ room, lease }) => {
        order.push("dispatch");
        return {
          room,
          lease,
          claimedNodeIds: [],
          skippedNodeIds: [],
          capacityAdmissions: [],
        };
      }),
    } satisfies RoomTaskDispatcher;
    const controller = createController({
      worker: {
        runRoom: vi.fn(async ({ signal }: RoomWorkerRunInput) => {
          workerStarted.resolve();
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        }),
      },
      capacityAdmission: capacityAdmission(global),
      taskDispatcher,
    });

    await controller.start();
    await workerStarted.promise;

    expect(order).toEqual(["capacity", "dispatch"]);
    expect(taskDispatcher.dispatchReadyTasks).toHaveBeenCalledTimes(1);
  });

  it("starts a Room worker after global capacity admits without consulting a controller-level provider gate", async () => {
    const workerStarted = deferred<void>();
    const global = acquiredGlobal();
    const controller = createController({
      worker: {
        runRoom: vi.fn(async ({ signal }: RoomWorkerRunInput) => {
          workerStarted.resolve();
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        }),
      },
      capacityAdmission: capacityAdmission(global),
    });

    await controller.start();
    await workerStarted.promise;

    expect(global.acquire).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "project-capacity-admission",
      roomId: "room-capacity-admission",
      leaseId: "lease-capacity-admission",
      fence: 7,
      workClass: "normal",
      slots: 1,
    }));
  });

  it("uses the central capacity TTL for Room lease and claim acquire/renew expiry", async () => {
    let currentNow = NOW;
    const workerStarted = deferred<void>();
    const global = acquiredGlobal();
    const leaseStore = createLeaseStore();
    const controller = createController({
      worker: {
        runRoom: vi.fn(async ({ signal }: RoomWorkerRunInput) => {
          workerStarted.resolve();
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        }),
      },
      leaseStore,
      capacityAdmission: capacityAdmission(global, {
        leaseTtlMs: 15_000,
        renewalIntervalMs: 5_000,
      }),
      now: () => currentNow,
    });

    await controller.start();
    await workerStarted.promise;

    expect(leaseStore.acquireInputs[0]).toMatchObject({
      expiresAt: "2026-07-19T15:36:15.000Z",
    });
    expect(global.acquire).toHaveBeenCalledWith(expect.objectContaining({
      expiresAt: "2026-07-19T15:36:15.000Z",
    }));

    currentNow = "2026-07-19T15:36:05.000Z";
    await controller.reconcile("central-ttl-renewal");

    expect(leaseStore.renewInputs[leaseStore.renewInputs.length - 1]).toMatchObject({
      expiresAt: "2026-07-19T15:36:20.000Z",
    });
    expect(global.renew).toHaveBeenLastCalledWith(expect.objectContaining({
      expiresAt: "2026-07-19T15:36:20.000Z",
    }));
  });

  it("reconciles no slower than the central capacity renewal interval", async () => {
    vi.useFakeTimers();
    try {
      const workerStarted = deferred<void>();
      const global = acquiredGlobal();
      const controller = createController({
        worker: {
          runRoom: vi.fn(async ({ signal }: RoomWorkerRunInput) => {
            workerStarted.resolve();
            await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
          }),
        },
        capacityAdmission: capacityAdmission(global),
        pollIntervalMs: 60_000,
      });

      await controller.start();
      await workerStarted.promise;
      await vi.advanceTimersByTimeAsync(CAPACITY_RENEWAL_INTERVAL_MS);

      expect(global.renew).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects invalid central timings and local TTL mismatches before any worker can start", () => {
    const cases = [
      {
        name: "non-positive central TTL",
        timings: { leaseTtlMs: 0, renewalIntervalMs: 1 },
        leaseDurationMs: undefined,
        error: /capacityAdmission\.leaseTtlMs must be a positive safe integer/,
      },
      {
        name: "non-positive central renewal interval",
        timings: { leaseTtlMs: 10, renewalIntervalMs: 0 },
        leaseDurationMs: undefined,
        error: /capacityAdmission\.renewalIntervalMs must be a positive safe integer/,
      },
      {
        name: "renewal interval equal to central TTL",
        timings: { leaseTtlMs: 10, renewalIntervalMs: 10 },
        leaseDurationMs: undefined,
        error: /renewalIntervalMs must be strictly less than capacityAdmission\.leaseTtlMs/,
      },
      {
        name: "explicit local TTL mismatch",
        timings: { leaseTtlMs: 10, renewalIntervalMs: 1 },
        leaseDurationMs: 11,
        error: /leaseDurationMs must match capacityAdmission\.leaseTtlMs/,
      },
    ];

    for (const testCase of cases) {
      const global = acquiredGlobal();
      const runRoom = vi.fn(async () => undefined);

      expect(() => createController({
        worker: { runRoom },
        capacityAdmission: capacityAdmission(global, testCase.timings),
        ...(testCase.leaseDurationMs === undefined ? {} : { leaseDurationMs: testCase.leaseDurationMs }),
      })).toThrow(testCase.error);
      expect(runRoom).not.toHaveBeenCalled();
      expect(global.acquire).not.toHaveBeenCalled();
    }
  });

  it("withholds a Room worker on global capacity denial and records the durable reason", async () => {
    const global = withheldGlobal();
    const audit = vi.fn(async () => undefined);
    const runRoom = vi.fn(async () => undefined);
    const taskDispatcher = {
      dispatchReadyTasks: vi.fn(async ({ room, lease }) => ({
        room,
        lease,
        claimedNodeIds: [],
        skippedNodeIds: [],
        capacityAdmissions: [],
      })),
    } satisfies RoomTaskDispatcher;
    const controller = createController({
      worker: { runRoom },
      capacityAdmission: capacityAdmission(global as ReturnType<typeof acquiredGlobal>),
      audit,
      taskDispatcher,
    });

    await controller.start();

    expect(global.acquire).toHaveBeenCalledTimes(1);
    expect(global.release).not.toHaveBeenCalled();
    expect(runRoom).not.toHaveBeenCalled();
    expect(taskDispatcher.dispatchReadyTasks).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "room:worker-capacity-withheld",
      metadata: expect.objectContaining({
        admissionScope: "global",
        reason: "global_capacity_exhausted",
      }),
    }));
  });

  it("compensates an acquired global claim when the worker-start audit fails", async () => {
    const global = acquiredGlobal();
    const audit = vi.fn(async (event: { readonly mutationType: string }) => {
      if (event.mutationType === "room:worker-started") throw new Error("start audit unavailable");
    });
    const runRoom = vi.fn(async () => undefined);
    const controller = createController({
      worker: { runRoom },
      capacityAdmission: capacityAdmission(global),
      audit,
    });

    await controller.start();
    await vi.waitFor(() => expect(global.release).toHaveBeenCalledTimes(1));

    expect(runRoom).not.toHaveBeenCalled();
    expect(global.release).toHaveBeenCalledWith(expect.objectContaining({
      claimId: "capacity-claim-room-capacity-admission",
      leaseId: "lease-capacity-admission",
      fence: 7,
    }));
  });

  it("releases an admitted global claim exactly once when the worker fails", async () => {
    const leaseReleased = deferred<void>();
    const global = acquiredGlobal();
    const controller = createController({
      worker: {
        runRoom: vi.fn(async () => {
          throw new Error("worker failure");
        }),
      },
      leaseStore: createLeaseStore(() => leaseReleased.resolve()),
      capacityAdmission: capacityAdmission(global),
    });

    await controller.start();
    await leaseReleased.promise;

    expect(global.release).toHaveBeenCalledTimes(1);
    expect(global.release).toHaveBeenCalledWith(expect.objectContaining({
      claimId: "capacity-claim-room-capacity-admission",
      leaseId: "lease-capacity-admission",
      fence: 7,
    }));
  });

  it("releases an admitted global claim exactly once when the worker completes", async () => {
    const leaseReleased = deferred<void>();
    const global = acquiredGlobal();
    const controller = createController({
      worker: { runRoom: vi.fn(async () => undefined) },
      leaseStore: createLeaseStore(() => leaseReleased.resolve()),
      capacityAdmission: capacityAdmission(global),
    });

    await controller.start();
    await leaseReleased.promise;

    expect(global.release).toHaveBeenCalledTimes(1);
  });

  it("keeps the Room lease fenced until a transient central release is durably acknowledged", async () => {
    const leaseReleased = deferred<void>();
    const global = acquiredGlobal();
    global.release
      .mockRejectedValueOnce(new Error("central release unavailable #1"))
      .mockRejectedValueOnce(new Error("central release unavailable #2"))
      .mockRejectedValueOnce(new Error("central release unavailable #3"));
    const runRoom = vi.fn(async () => undefined);
    const leaseStore = createLeaseStore(() => leaseReleased.resolve());
    const controller = createController({
      worker: { runRoom },
      leaseStore,
      capacityAdmission: capacityAdmission(global),
    });

    await controller.start();
    await vi.waitFor(() => expect(global.release).toHaveBeenCalledTimes(3));

    expect(leaseStore.releaseLease).not.toHaveBeenCalled();
    expect(runRoom).toHaveBeenCalledTimes(1);
    expect(global.release.mock.calls.map(([input]) => input)).toEqual([
      expect.objectContaining({
        claimId: "capacity-claim-room-capacity-admission",
        operationId: "room-capacity-release:capacity-claim-room-capacity-admission",
        leaseId: "lease-capacity-admission",
        fence: 7,
      }),
      expect.objectContaining({
        claimId: "capacity-claim-room-capacity-admission",
        operationId: "room-capacity-release:capacity-claim-room-capacity-admission",
        leaseId: "lease-capacity-admission",
        fence: 7,
      }),
      expect.objectContaining({
        claimId: "capacity-claim-room-capacity-admission",
        operationId: "room-capacity-release:capacity-claim-room-capacity-admission",
        leaseId: "lease-capacity-admission",
        fence: 7,
      }),
    ]);

    await controller.reconcile("retry-pending-central-release");
    await leaseReleased.promise;

    expect(global.release).toHaveBeenCalledTimes(4);
    expect(global.release).toHaveBeenLastCalledWith(expect.objectContaining({
      claimId: "capacity-claim-room-capacity-admission",
      operationId: "room-capacity-release:capacity-claim-room-capacity-admission",
      leaseId: "lease-capacity-admission",
      fence: 7,
    }));
    expect(leaseStore.releaseLease).toHaveBeenCalledTimes(1);
    expect(runRoom).toHaveBeenCalledTimes(1);
  });

  it("drains a pending central capacity release during bounded controller shutdown", async () => {
    const leaseReleased = deferred<void>();
    const global = acquiredGlobal();
    global.release
      .mockRejectedValueOnce(new Error("central release unavailable #1"))
      .mockRejectedValueOnce(new Error("central release unavailable #2"))
      .mockRejectedValueOnce(new Error("central release unavailable #3"));
    const leaseStore = createLeaseStore(() => leaseReleased.resolve());
    const controller = createController({
      worker: { runRoom: vi.fn(async () => undefined) },
      leaseStore,
      capacityAdmission: capacityAdmission(global),
    });

    await controller.start();
    await vi.waitFor(() => expect(global.release).toHaveBeenCalledTimes(3));
    expect(leaseStore.releaseLease).not.toHaveBeenCalled();

    await controller.stop();
    await leaseReleased.promise;

    expect(global.release).toHaveBeenCalledTimes(4);
    expect(leaseStore.releaseLease).toHaveBeenCalledTimes(1);
  });

  it("aborts and compensates the active global claim when a worker lease renewal cannot renew its fenced capacity claim", async () => {
    let currentNow = NOW;
    const workerStarted = deferred<void>();
    const workerAborted = vi.fn();
    const global = acquiredGlobal();
    global.renew.mockResolvedValueOnce({
      action: "held",
      reason: "global_capacity_exhausted",
      replayed: false,
      claimId: null,
      fence: null,
    });
    const audit = vi.fn(async () => undefined);
    const controller = createController({
      worker: {
        runRoom: vi.fn(async ({ signal }: RoomWorkerRunInput) => {
          workerStarted.resolve();
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => {
            workerAborted();
            resolve();
          }, { once: true }));
        }),
      },
      capacityAdmission: capacityAdmission(global),
      audit,
      now: () => currentNow,
    });

    await controller.start();
    await workerStarted.promise;
    currentNow = "2026-07-19T15:36:30.000Z";
    await controller.reconcile("renewal-test");

    expect(global.renew).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "project-capacity-admission",
      roomId: "room-capacity-admission",
      claimId: "capacity-claim-room-capacity-admission",
      leaseId: "lease-capacity-admission",
      fence: 7,
      asOf: "2026-07-19T15:36:30.000Z",
      expiresAt: "2026-07-19T15:37:30.000Z",
    }));
    expect(workerAborted).toHaveBeenCalledTimes(1);
    expect(global.release).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      mutationType: "room:worker-capacity-withheld",
      metadata: expect.objectContaining({
        admissionScope: "global",
        reason: "global_capacity_exhausted",
      }),
    }));
  });
});
