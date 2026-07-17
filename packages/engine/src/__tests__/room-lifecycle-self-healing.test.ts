import {
  createRoomAggregate,
  transitionRoomLifecycle,
  type RoomAggregateV1,
  type RoomLifecycleState,
  type RunAuditEventInput,
  type StoredRoomLeaseV1,
} from "@fusion/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RoomController,
  type RoomControllerLeaseStore,
  type RoomControllerOptions,
  type RoomControllerRoomStore,
  type RoomWorker,
} from "../room-controller.js";

type RoomLifecycleAuditMutationType =
  | "room:worker-lease-acquired"
  | "room:worker-lease-taken-over"
  | "room:worker-lease-lost"
  | "room:worker-started"
  | "room:worker-stopped"
  | "room:worker-stop-timeout"
  | "room:worker-recovery-failed"
  | "room:worker-recovery-withheld";

type RoomLifecycleAuditEvent = RunAuditEventInput & {
  readonly mutationType: RoomLifecycleAuditMutationType;
};

type RecordRoomLifecycleAuditEvent = (
  event: RoomLifecycleAuditEvent,
) => Promise<void>;

interface RoomLifecycleRecoveryPosture {
  readonly lifecycleState: RoomLifecycleState;
  readonly aggregateVersion: number;
  readonly humanPaused: boolean;
  readonly approvalState: "none" | "waiting" | "blocked";
}

interface RoomLifecycleRecoveryStore extends RoomControllerRoomStore {
  getRecoveryPosture?(roomId: string): Promise<RoomLifecycleRecoveryPosture>;
}

interface RoomLifecycleControllerOptions extends RoomControllerOptions {
  readonly recordRunAuditEvent: RecordRoomLifecycleAuditEvent;
}

interface HarnessOptions {
  readonly rooms?: readonly RoomAggregateV1[];
  readonly acquireAction?: "acquired" | "taken_over";
  readonly acquireEpoch?: number;
  readonly renewFailure?: "not_found" | "stale_fence" | "expired";
  readonly worker?: RoomWorker;
  readonly checkpointStore?: RoomControllerOptions["checkpointStore"];
  readonly recoveryPostures?: Readonly<Record<string, RoomLifecycleRecoveryPosture>>;
  readonly recordRunAuditEventImpl?: RecordRoomLifecycleAuditEvent;
  readonly shutdownGraceMs?: number;
}

interface RoomControllerHarness {
  readonly controller: RoomController;
  readonly roomStore: RoomLifecycleRecoveryStore;
  readonly leaseStore: RoomControllerLeaseStore;
  readonly leaseState: FakeRoomLeaseState;
  readonly worker: RoomWorker;
  readonly recordRunAuditEvent: ReturnType<typeof vi.fn<RecordRoomLifecycleAuditEvent>>;
}

interface FakeRoomLeaseState {
  current: StoredRoomLeaseV1 | null;
  readonly mutations: Array<"acquire" | "renew" | "release">;
}

const controllers: RoomController[] = [];
const FIXED_NOW = "2026-07-17T13:23:00.000Z";
const SECRET_OBJECTIVE = "DO-NOT-AUDIT room objective";
const SECRET_WORKER_ERROR = "DO-NOT-AUDIT worker error";

afterEach(async () => {
  for (const controller of controllers.splice(0)) {
    await controller.stop();
  }
  vi.useRealTimers();
});

function roomInState(
  id: string,
  state:
    | "running"
    | "paused"
    | "blocked"
    | "completed"
    | "completed_with_risks"
    | "partial"
    | "cancelled"
    | "failed"
    | "archived" = "running",
): RoomAggregateV1 {
  const draft = createRoomAggregate({
    id,
    projectId: "project-1",
    objective: `${SECRET_OBJECTIVE} ${id}`,
    protocolId: "implementation",
    protocolVersion: 1,
    now: "2026-07-17T13:20:00.000Z",
  });
  const ready = transitionRoomLifecycle(draft, {
    to: "ready",
    expectedAggregateVersion: draft.room.aggregateVersion,
    now: "2026-07-17T13:20:01.000Z",
  });
  if (state === "paused") {
    return transitionRoomLifecycle(ready, {
      to: "paused",
      expectedAggregateVersion: ready.room.aggregateVersion,
      now: "2026-07-17T13:20:02.000Z",
    });
  }
  const running = transitionRoomLifecycle(ready, {
    to: "running",
    expectedAggregateVersion: ready.room.aggregateVersion,
    now: "2026-07-17T13:20:02.000Z",
  });
  if (state === "running") return running;
  const next = transitionRoomLifecycle(running, {
    to: state === "archived" ? "completed" : state,
    expectedAggregateVersion: running.room.aggregateVersion,
    now: "2026-07-17T13:20:03.000Z",
  });
  if (state !== "archived") return next;
  return transitionRoomLifecycle(next, {
    to: "archived",
    expectedAggregateVersion: next.room.aggregateVersion,
    now: "2026-07-17T13:20:04.000Z",
  });
}

function holdUntilAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function recoveryPosture(
  lifecycleState: RoomLifecycleState,
  options: {
    readonly aggregateVersion?: number;
    readonly humanPaused?: boolean;
    readonly approvalState?: RoomLifecycleRecoveryPosture["approvalState"];
  } = {},
): RoomLifecycleRecoveryPosture {
  return {
    lifecycleState,
    aggregateVersion: options.aggregateVersion ?? 3,
    humanPaused: options.humanPaused ?? false,
    approvalState: options.approvalState ?? "none",
  };
}

function createLeaseStore(options: HarnessOptions): {
  readonly leaseStore: RoomControllerLeaseStore;
  readonly state: FakeRoomLeaseState;
} {
  const state: FakeRoomLeaseState = {
    current: null,
    mutations: [],
  };
  const leaseStore: RoomControllerLeaseStore = {
    acquireLease: vi.fn(async (input) => {
      state.current = {
        contractVersion: 1,
        id: input.leaseId,
        roomId: input.roomId,
        kind: input.kind,
        resourceId: input.resourceId,
        holderId: input.holderId,
        hostId: input.hostId,
        epoch: options.acquireEpoch ?? 1,
        acquiredAt: input.now,
        heartbeatAt: input.now,
        expiresAt: input.expiresAt,
        releasedAt: null,
      };
      state.mutations.push("acquire");
      return {
        ok: true as const,
        action: options.acquireAction ?? "acquired",
        lease: state.current,
      };
    }),
    renewLease: vi.fn(async (input) => {
      if (options.renewFailure) {
        return {
          ok: false as const,
          reason: options.renewFailure,
          current: state.current,
        };
      }
      if (!state.current) {
        return { ok: false as const, reason: "not_found" as const, current: null };
      }
      state.current = {
        ...state.current,
        heartbeatAt: input.now,
        expiresAt: input.expiresAt,
      };
      state.mutations.push("renew");
      return { ok: true as const, lease: state.current };
    }),
    releaseLease: vi.fn(async (input) => {
      if (state.current) state.current = { ...state.current, releasedAt: input.now };
      state.mutations.push("release");
      return { ok: true as const, lease: state.current };
    }),
    assertFence: vi.fn(async () => {
      if (!state.current || state.current.releasedAt) throw new Error("stale_lease_fence");
      return state.current;
    }),
  };
  return { leaseStore, state };
}

function createHarness(options: HarnessOptions = {}): RoomControllerHarness {
  const rooms = options.rooms ?? [roomInState("room-1")];
  const roomStore: RoomLifecycleRecoveryStore = {
    listRunnableRooms: vi.fn(async () => rooms),
    getRecoveryPosture: vi.fn(async (roomId: string) => {
      const room = rooms.find((candidate) => candidate.room.id === roomId);
      if (!room) throw new Error(`Unknown Room recovery posture ${roomId}`);
      return options.recoveryPostures?.[roomId] ?? {
        lifecycleState: room.room.state,
        aggregateVersion: room.room.aggregateVersion,
        humanPaused: false,
        approvalState: "none",
      };
    }),
  };
  const { leaseStore, state: leaseState } = createLeaseStore(options);
  const worker = options.worker ?? {
    runRoom: vi.fn(async ({ signal }) => holdUntilAbort(signal)),
  };
  const recordRunAuditEvent = vi.fn<RecordRoomLifecycleAuditEvent>(
    options.recordRunAuditEventImpl ?? (async () => undefined),
  );
  const controllerOptions = {
    projectId: "project-1",
    workerId: "worker-1",
    hostId: "host-1",
    roomStore,
    leaseStore,
    checkpointStore: options.checkpointStore,
    worker,
    recordRunAuditEvent,
    now: () => FIXED_NOW,
    createLeaseId: (roomId: string) => `${roomId}:worker-1:lease`,
    leaseDurationMs: 60_000,
    pollIntervalMs: 60_000,
    shutdownGraceMs: options.shutdownGraceMs ?? 1_000,
  } satisfies RoomLifecycleControllerOptions;
  const controller = new RoomController(controllerOptions);
  controllers.push(controller);
  return {
    controller,
    roomStore,
    leaseStore,
    leaseState,
    worker,
    recordRunAuditEvent,
  };
}

async function flushWorkerMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function findAuditEvent(
  recordRunAuditEvent: RoomControllerHarness["recordRunAuditEvent"],
  mutationType: RoomLifecycleAuditMutationType,
  roomId = "room-1",
): RoomLifecycleAuditEvent | undefined {
  return recordRunAuditEvent.mock.calls
    .map(([event]) => event)
    .find((event) => event.mutationType === mutationType && event.target === roomId);
}

function expectSafeRoomAuditMetadata(event: RoomLifecycleAuditEvent): void {
  const serialized = JSON.stringify(event);
  expect(event.runId.trim()).not.toBe("");
  expect(serialized).not.toContain(SECRET_OBJECTIVE);
  expect(serialized).not.toContain(SECRET_WORKER_ERROR);
  expect(serialized).not.toMatch(/(?:prompt|content|credential|token|stack)/i);
}

/*
FNXC:SessionRoomSelfHealing 2026-07-17-21:23:
Room worker lease and process lifecycle changes need durable run-audit events
with identifiers and bounded outcomes only. Room objectives, message content,
credentials, and raw worker errors must never enter audit metadata.
*/
describe("Room lifecycle run audit and startup self-healing", () => {
  it("does not start a worker before its durable lifecycle audit is persisted", async () => {
    const auditGate = deferred<void>();
    const harness = createHarness({
      recordRunAuditEventImpl: async () => auditGate.promise,
    });
    let startSettled = false;
    const startPromise = harness.controller.start().then(() => {
      startSettled = true;
    });

    await flushWorkerMicrotasks();

    expect(
      harness.worker.runRoom,
      "Task 4.8 must not start a worker before its outbox-backed lifecycle audit commits",
    ).not.toHaveBeenCalled();
    expect(startSettled).toBe(false);

    auditGate.resolve();
    await startPromise;
    await flushWorkerMicrotasks();

    expect(harness.worker.runRoom).toHaveBeenCalledTimes(1);
    expect(startSettled).toBe(true);
  });

  it("does not register a handle when shutdown wins an in-flight startup audit", async () => {
    const acquiredAudit = deferred<void>();
    const acquiredAuditEntered = deferred<void>();
    const harness = createHarness({
      recordRunAuditEventImpl: async (event) => {
        if (event.mutationType === "room:worker-lease-acquired") {
          acquiredAuditEntered.resolve();
          await acquiredAudit.promise;
        }
      },
    });
    const startPromise = harness.controller.start();
    await acquiredAuditEntered.promise;
    expect(findAuditEvent(
      harness.recordRunAuditEvent,
      "room:worker-lease-acquired",
    )).toBeDefined();

    const stopPromise = harness.controller.stop();
    acquiredAudit.resolve();
    await Promise.all([startPromise, stopPromise]);
    await flushWorkerMicrotasks();

    expect(harness.worker.runRoom).not.toHaveBeenCalled();
    expect(findAuditEvent(harness.recordRunAuditEvent, "room:worker-started")).toBeUndefined();
  });

  it("terminates a registered startup handle when shutdown wins worker-started persistence", async () => {
    const startedAudit = deferred<void>();
    const startedAuditEntered = deferred<void>();
    const persistedOrder: RoomLifecycleAuditMutationType[] = [];
    const harness = createHarness({
      recordRunAuditEventImpl: async (event) => {
        if (event.mutationType === "room:worker-started") {
          startedAuditEntered.resolve();
          await startedAudit.promise;
        }
        persistedOrder.push(event.mutationType);
      },
    });
    const startPromise = harness.controller.start();
    await startedAuditEntered.promise;

    const stopPromise = harness.controller.stop();
    startedAudit.resolve();
    await Promise.all([startPromise, stopPromise]);
    await flushWorkerMicrotasks();

    expect(harness.worker.runRoom).not.toHaveBeenCalled();
    expect(harness.recordRunAuditEvent.mock.calls
      .map(([event]) => event)
      .filter((event) => event.mutationType === "room:worker-started"))
      .toHaveLength(1);
    expect(harness.recordRunAuditEvent.mock.calls
      .map(([event]) => event)
      .filter((event) => event.mutationType === "room:worker-stopped"))
      .toEqual([expect.objectContaining({
        metadata: expect.objectContaining({
          reason: "controller_stop",
          terminationOutcome: "settled",
        }),
      })]);
    expect(findAuditEvent(harness.recordRunAuditEvent, "room:worker-stop-timeout")).toBeUndefined();
    expect(persistedOrder.filter((mutationType) => (
      mutationType === "room:worker-started" || mutationType === "room:worker-stopped"
    ))).toEqual(["room:worker-started", "room:worker-stopped"]);
  });

  it("rechecks combined authority in the worker-launch microtask after lease commit", async () => {
    const harness = createHarness();
    vi.mocked(harness.roomStore.getRecoveryPosture!)
      .mockResolvedValueOnce(recoveryPosture("running", { aggregateVersion: 2 }))
      .mockResolvedValueOnce(recoveryPosture("running", { aggregateVersion: 2 }))
      .mockResolvedValueOnce(recoveryPosture("paused", {
        aggregateVersion: 3,
        humanPaused: true,
      }));

    await harness.controller.start();
    await flushWorkerMicrotasks();

    expect(
      harness.worker.runRoom,
      "Task 4.8 must close the race between the post-lease posture read and worker execution",
    ).not.toHaveBeenCalled();
    expect(harness.leaseStore.releaseLease).toHaveBeenCalledTimes(1);
  });

  it("retries a transient audit failure instead of dropping the startup lease event", async () => {
    const delivered: RoomLifecycleAuditEvent[] = [];
    let leaseAcquiredAttempts = 0;
    const harness = createHarness({
      recordRunAuditEventImpl: async (event) => {
        if (event.mutationType === "room:worker-lease-acquired" && leaseAcquiredAttempts++ === 0) {
          throw new Error("transient_audit_failure");
        }
        delivered.push(event);
      },
    });

    await harness.controller.start();
    await flushWorkerMicrotasks();
    await harness.controller.stop();

    expect(harness.worker.runRoom).toHaveBeenCalledTimes(1);
    expect(
      harness.recordRunAuditEvent.mock.calls
        .map(([event]) => event)
        .filter((event) => event.mutationType === "room:worker-lease-acquired"),
      "Task 4.8 requires bounded retry so a transient audit error cannot silently drop the lease-acquired fact",
    ).toHaveLength(2);
    expect(
      delivered.some((event) => event.mutationType === "room:worker-lease-acquired"),
    ).toBe(true);
  });

  it("releases the lease and refuses worker execution when durable audit persistence exhausts", async () => {
    const harness = createHarness({
      recordRunAuditEventImpl: async () => {
        throw new Error("audit_store_unavailable");
      },
    });
    vi.mocked(harness.leaseStore.releaseLease).mockRejectedValueOnce(
      new Error("transient_release_failure"),
    );

    await harness.controller.start();
    await flushWorkerMicrotasks();

    expect(harness.recordRunAuditEvent).toHaveBeenCalledTimes(3);
    expect(harness.worker.runRoom).not.toHaveBeenCalled();
    expect(harness.leaseStore.releaseLease).toHaveBeenCalledTimes(2);
  });

  it("emits worker-stopped only after the aborted worker settles on shutdown", async () => {
    const workerExit = deferred<void>();
    const worker: RoomWorker = {
      runRoom: vi.fn(async ({ signal }) => {
        if (signal.aborted) {
          await workerExit.promise;
          return;
        }
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            workerExit.promise.then(() => resolve());
          }, { once: true });
        });
      }),
    };
    const harness = createHarness({ worker });

    await harness.controller.start();
    await flushWorkerMicrotasks();

    const stopPromise = harness.controller.stop();
    await flushWorkerMicrotasks();

    expect(
      findAuditEvent(harness.recordRunAuditEvent, "room:worker-stopped"),
      "Task 4.8 requires worker-stopped to wait for settle/timeout semantics instead of firing on raw abort",
    ).toBeUndefined();

    workerExit.resolve();
    await stopPromise;

    const stoppedEvents = harness.recordRunAuditEvent.mock.calls
      .map(([event]) => event)
      .filter((event) => event.mutationType === "room:worker-stopped");
    expect(stoppedEvents).toHaveLength(1);
  });

  it("keeps termination-unknown final after controller shutdown instead of writing through a closed store", async () => {
    const workerExit = deferred<void>();
    const harness = createHarness({
      shutdownGraceMs: 30,
      worker: {
        runRoom: vi.fn(async () => workerExit.promise),
      },
    });

    await harness.controller.start();
    await harness.controller.stop();

    expect(harness.recordRunAuditEvent.mock.calls
      .map(([event]) => event)
      .filter((event) => event.mutationType === "room:worker-stopped"))
      .toHaveLength(0);
    expect(harness.recordRunAuditEvent.mock.calls
      .map(([event]) => event)
      .filter((event) => event.mutationType === "room:worker-stop-timeout"))
      .toEqual([expect.objectContaining({
      metadata: expect.objectContaining({
        reason: "controller_stop",
        terminationOutcome: "termination_unknown",
      }),
      })]);

    workerExit.resolve();
    await flushWorkerMicrotasks();
    await flushWorkerMicrotasks();

    expect(harness.recordRunAuditEvent.mock.calls
      .map(([event]) => event)
      .filter((event) => event.mutationType === "room:worker-stopped"))
      .toHaveLength(0);
  });

  it("does not create a late audit write after shutdown when timeout persistence failed", async () => {
    const workerExit = deferred<void>();
    const harness = createHarness({
      shutdownGraceMs: 30,
      worker: {
        runRoom: vi.fn(async () => workerExit.promise),
      },
      recordRunAuditEventImpl: async (event) => {
        if (event.mutationType === "room:worker-stop-timeout") {
          throw new Error("audit_store_unavailable");
        }
      },
    });

    await harness.controller.start();
    await harness.controller.stop();
    expect(harness.recordRunAuditEvent.mock.calls
      .map(([event]) => event)
      .filter((event) => event.mutationType === "room:worker-stop-timeout"))
      .toHaveLength(3);
    expect(findAuditEvent(harness.recordRunAuditEvent, "room:worker-stopped")).toBeUndefined();
    const auditCallCountAfterStop = harness.recordRunAuditEvent.mock.calls.length;

    workerExit.resolve();
    await vi.mocked(harness.worker.runRoom).mock.results[0]?.value;
    await flushWorkerMicrotasks();

    expect(findAuditEvent(harness.recordRunAuditEvent, "room:worker-stopped")).toBeUndefined();
    expect(harness.recordRunAuditEvent).toHaveBeenCalledTimes(auditCallCountAfterStop);
  });

  it("blocks post-stop authority-revoked audit and release retries at the write boundary", async () => {
    const invokeAuthority = deferred<void>();
    let authorityRevoked = false;
    const worker: RoomWorker = {
      runRoom: vi.fn(async ({ assertAuthority }) => {
        await invokeAuthority.promise;
        await assertAuthority();
      }),
    };
    const harness = createHarness({ shutdownGraceMs: 30, worker });
    harness.roomStore.assertWorkerAuthority = vi.fn(async (input) => {
      if (!authorityRevoked) {
        return {
          lease: input.lease,
          posture: recoveryPosture("running", { aggregateVersion: 2 }),
        };
      }
      throw Object.assign(new Error("authority revoked"), {
        code: "room_worker_authority_revoked",
        reason: "human_paused",
        posture: recoveryPosture("paused", {
          aggregateVersion: 3,
          humanPaused: true,
        }),
      });
    });
    vi.mocked(harness.leaseStore.releaseLease).mockRejectedValue(
      new Error("release_store_unavailable"),
    );

    await harness.controller.start();
    await harness.controller.stop();
    const auditCallCountAfterStop = harness.recordRunAuditEvent.mock.calls.length;
    const releaseCallCountAfterStop = vi.mocked(harness.leaseStore.releaseLease).mock.calls.length;

    authorityRevoked = true;
    invokeAuthority.resolve();
    await vi.mocked(worker.runRoom).mock.results[0]?.value.catch(() => undefined);
    await flushWorkerMicrotasks();

    expect(harness.recordRunAuditEvent).toHaveBeenCalledTimes(auditCallCountAfterStop);
    expect(harness.leaseStore.releaseLease).toHaveBeenCalledTimes(releaseCallCountAfterStop);
    expect(findAuditEvent(
      harness.recordRunAuditEvent,
      "room:worker-recovery-withheld",
    )).toBeUndefined();
  });

  /*
  FNXC:SessionRoomLifecycleGeneration 2026-07-18-05:19:
  Every asynchronous discovery, recovery, authority, and lease-store result is
  owned by the controller generation that started it. Once stop wins, that
  result must not renew a replacement handle, emit lifecycle audit, release a
  newer lease, launch a worker, or retry a failed write in a later generation.
  A concurrent start must wait for stop to finish before opening that new
  generation. The same fail-closed rule applies as soon as stop begins: a
  successful authority-store result cannot pass the stopping/abort/handle
  guard merely because lifecycle writes have not closed yet.
  */
  it("does not let delayed room discovery from a stopped generation renew the replacement handle", async () => {
    const listEntered = deferred<void>();
    const releaseList = deferred<void>();
    const stoppedGenerationRoom = roomInState("room-1");
    const replacementGenerationRoom = roomInState("room-1");
    const harness = createHarness({ shutdownGraceMs: 30 });
    vi.mocked(harness.roomStore.listRunnableRooms)
      .mockImplementationOnce(async () => {
        listEntered.resolve();
        await releaseList.promise;
        return [stoppedGenerationRoom];
      })
      .mockResolvedValueOnce([replacementGenerationRoom])
      .mockResolvedValue([]);

    const stoppedStart = harness.controller.start();
    await listEntered.promise;
    await harness.controller.stop();
    await harness.controller.start();
    await flushWorkerMicrotasks();

    expect(harness.worker.runRoom).toHaveBeenCalledTimes(1);
    expect(vi.mocked(harness.worker.runRoom).mock.calls[0]?.[0].room)
      .toBe(replacementGenerationRoom);
    expect(harness.leaseState.mutations).toEqual(["acquire"]);

    releaseList.resolve();
    await stoppedStart;
    await flushWorkerMicrotasks();

    expect(
      harness.leaseStore.renewLease,
      "a stale list result must not renew the replacement generation's handle",
    ).not.toHaveBeenCalled();
    expect(harness.leaseState.mutations).toEqual(["acquire"]);
    expect(harness.worker.runRoom).toHaveBeenCalledTimes(1);
  });

  it.each(["replayProjection", "getRecoveryPosture"] as const)(
    "drops a delayed post-lease %s result when stop and restart advance the generation",
    async (delayedSeam) => {
      const seamEntered = deferred<void>();
      const releaseSeam = deferred<void>();
      const room = roomInState("room-1");
      const harness = createHarness({
        rooms: [room],
        shutdownGraceMs: 30,
        checkpointStore: delayedSeam === "replayProjection"
          ? {
              replayProjection: vi.fn(async () => {
                seamEntered.resolve();
                await releaseSeam.promise;
                return { aggregate: room };
              }),
            }
          : undefined,
      });
      if (delayedSeam === "getRecoveryPosture") {
        let postureReads = 0;
        vi.mocked(harness.roomStore.getRecoveryPosture!).mockImplementation(async () => {
          postureReads += 1;
          if (postureReads === 2) {
            seamEntered.resolve();
            await releaseSeam.promise;
          }
          return recoveryPosture("running", {
            aggregateVersion: room.room.aggregateVersion,
          });
        });
      }

      const stoppedStart = harness.controller.start();
      await seamEntered.promise;
      expect(harness.leaseState.mutations).toEqual(["acquire"]);
      expect(harness.leaseState.current?.releasedAt).toBeNull();

      await harness.controller.stop();
      vi.mocked(harness.roomStore.listRunnableRooms).mockResolvedValue([]);
      await harness.controller.start();
      const auditCallsAfterRestart = harness.recordRunAuditEvent.mock.calls.length;
      const releaseCallsAfterRestart = vi.mocked(harness.leaseStore.releaseLease).mock.calls.length;

      releaseSeam.resolve();
      await stoppedStart;
      await flushWorkerMicrotasks();

      expect(harness.recordRunAuditEvent).toHaveBeenCalledTimes(auditCallsAfterRestart);
      expect(harness.leaseStore.releaseLease).toHaveBeenCalledTimes(releaseCallsAfterRestart);
      expect(harness.worker.runRoom).not.toHaveBeenCalled();
      expect(harness.leaseState.mutations).toEqual(["acquire"]);
      expect(harness.leaseState.current).toMatchObject({
        roomId: "room-1",
        epoch: 1,
        releasedAt: null,
      });
    },
  );

  it("fails closed when a successful assertWorkerAuthority result returns in a later generation", async () => {
    const authorityEntered = deferred<void>();
    const releaseAuthority = deferred<void>();
    const externalEffect = vi.fn();
    const worker: RoomWorker = {
      runRoom: vi.fn(async ({ assertAuthority }) => {
        await assertAuthority();
        externalEffect();
      }),
    };
    const harness = createHarness({ shutdownGraceMs: 30, worker });
    let authorityChecks = 0;
    harness.roomStore.assertWorkerAuthority = vi.fn(async (input) => {
      authorityChecks += 1;
      if (authorityChecks === 3) {
        authorityEntered.resolve();
        await releaseAuthority.promise;
      }
      return {
        lease: input.lease,
        posture: recoveryPosture("running", { aggregateVersion: 2 }),
      };
    });

    await harness.controller.start();
    await authorityEntered.promise;
    await harness.controller.stop();
    vi.mocked(harness.roomStore.listRunnableRooms).mockResolvedValue([]);
    await harness.controller.start();
    const auditCallsAfterRestart = harness.recordRunAuditEvent.mock.calls.length;
    const releaseCallsAfterRestart = vi.mocked(harness.leaseStore.releaseLease).mock.calls.length;

    releaseAuthority.resolve();
    await vi.mocked(worker.runRoom).mock.results[0]?.value.catch(() => undefined);
    await flushWorkerMicrotasks();

    expect(authorityChecks).toBe(3);
    expect(externalEffect).not.toHaveBeenCalled();
    expect(harness.recordRunAuditEvent).toHaveBeenCalledTimes(auditCallsAfterRestart);
    expect(harness.leaseStore.releaseLease).toHaveBeenCalledTimes(releaseCallsAfterRestart);
  });

  it("does not launch runRoom when stop begins during the second startup authority assertion", async () => {
    const secondAuthorityEntered = deferred<void>();
    const releaseSecondAuthority = deferred<void>();
    const leaseReleaseCommitted = deferred<void>();
    const harness = createHarness();
    let authorityChecks = 0;
    let secondAuthorityStoreSucceeded = false;
    harness.roomStore.assertWorkerAuthority = vi.fn(async (input) => {
      authorityChecks += 1;
      if (authorityChecks === 2) {
        secondAuthorityEntered.resolve();
        await releaseSecondAuthority.promise;
        secondAuthorityStoreSucceeded = true;
      }
      return {
        lease: input.lease,
        posture: recoveryPosture("running", { aggregateVersion: 2 }),
      };
    });
    const releaseLease = vi.mocked(harness.leaseStore.releaseLease);
    const originalRelease = releaseLease.getMockImplementation()!;
    releaseLease.mockImplementationOnce(async (input) => {
      const result = await originalRelease(input);
      leaseReleaseCommitted.resolve();
      return result;
    });

    const startPromise = harness.controller.start();
    await secondAuthorityEntered.promise;
    await startPromise;
    let stopSettled = false;
    const stopPromise = harness.controller.stop().then(() => {
      stopSettled = true;
    });
    await leaseReleaseCommitted.promise;
    await flushWorkerMicrotasks();

    expect(stopSettled).toBe(false);
    expect(harness.leaseState.current?.releasedAt).toBe(FIXED_NOW);
    expect(harness.worker.runRoom).not.toHaveBeenCalled();

    releaseSecondAuthority.resolve();
    await stopPromise;
    await flushWorkerMicrotasks();

    expect(secondAuthorityStoreSucceeded).toBe(true);
    expect(authorityChecks).toBe(2);
    expect(harness.worker.runRoom).not.toHaveBeenCalled();
    expect(findAuditEvent(
      harness.recordRunAuditEvent,
      "room:worker-recovery-withheld",
    )).toBeUndefined();
    expect(findAuditEvent(harness.recordRunAuditEvent, "room:worker-stopped")).toMatchObject({
      metadata: expect.objectContaining({
        reason: "controller_stop",
        source: "shutdown",
      }),
    });
  });

  it("rejects an in-worker authority promise when stop begins before its successful result returns", async () => {
    const workerAuthorityEntered = deferred<void>();
    const releaseWorkerAuthority = deferred<void>();
    const leaseReleaseCommitted = deferred<void>();
    const externalEffect = vi.fn();
    let workerAuthorityPromise: Promise<unknown> | null = null;
    const worker: RoomWorker = {
      runRoom: vi.fn(async ({ assertAuthority }) => {
        workerAuthorityPromise = assertAuthority();
        await workerAuthorityPromise;
        externalEffect();
      }),
    };
    const harness = createHarness({ worker });
    let authorityChecks = 0;
    let workerAuthorityStoreSucceeded = false;
    harness.roomStore.assertWorkerAuthority = vi.fn(async (input) => {
      authorityChecks += 1;
      if (authorityChecks === 3) {
        workerAuthorityEntered.resolve();
        await releaseWorkerAuthority.promise;
        workerAuthorityStoreSucceeded = true;
      }
      return {
        lease: input.lease,
        posture: recoveryPosture("running", { aggregateVersion: 2 }),
      };
    });
    const releaseLease = vi.mocked(harness.leaseStore.releaseLease);
    const originalRelease = releaseLease.getMockImplementation()!;
    releaseLease.mockImplementationOnce(async (input) => {
      const result = await originalRelease(input);
      leaseReleaseCommitted.resolve();
      return result;
    });

    const startPromise = harness.controller.start();
    await workerAuthorityEntered.promise;
    await startPromise;
    if (!workerAuthorityPromise) throw new Error("worker authority promise was not captured");
    const authorityOutcome = workerAuthorityPromise.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    let stopSettled = false;
    const stopPromise = harness.controller.stop().then(() => {
      stopSettled = true;
    });
    await leaseReleaseCommitted.promise;
    await flushWorkerMicrotasks();

    expect(stopSettled).toBe(false);
    expect(harness.leaseState.current?.releasedAt).toBe(FIXED_NOW);
    expect(externalEffect).not.toHaveBeenCalled();

    releaseWorkerAuthority.resolve();
    const outcome = await authorityOutcome;
    await stopPromise;
    await flushWorkerMicrotasks();

    expect(workerAuthorityStoreSucceeded).toBe(true);
    expect(outcome).toMatchObject({
      ok: false,
      error: {
        code: "room_worker_authority_revoked",
        reason: "controller_stopped",
      },
    });
    expect(authorityChecks).toBe(3);
    expect(harness.worker.runRoom).toHaveBeenCalledTimes(1);
    expect(externalEffect).not.toHaveBeenCalled();
    expect(findAuditEvent(
      harness.recordRunAuditEvent,
      "room:worker-recovery-withheld",
    )).toBeUndefined();
    expect(findAuditEvent(harness.recordRunAuditEvent, "room:worker-stopped")).toMatchObject({
      metadata: expect.objectContaining({
        reason: "controller_stop",
        source: "shutdown",
      }),
    });
  });

  it("does not retry a failed lease release after stop and restart advance the generation", async () => {
    const releaseEntered = deferred<void>();
    const rejectRelease = deferred<void>();
    const harness = createHarness({ shutdownGraceMs: 30 });
    await harness.controller.start();
    await flushWorkerMicrotasks();
    vi.mocked(harness.leaseStore.releaseLease).mockImplementationOnce(async () => {
      releaseEntered.resolve();
      await rejectRelease.promise;
      throw new Error("first_release_attempt_failed");
    });

    const stopPromise = harness.controller.stop();
    await releaseEntered.promise;
    await stopPromise;
    vi.mocked(harness.roomStore.listRunnableRooms).mockResolvedValue([]);
    await harness.controller.start();

    rejectRelease.resolve();
    await vi.mocked(harness.leaseStore.releaseLease).mock.results[0]?.value.catch(() => undefined);
    await flushWorkerMicrotasks();
    await flushWorkerMicrotasks();

    expect(
      harness.leaseStore.releaseLease,
      "the old generation must not issue release attempts two or three through the reopened store",
    ).toHaveBeenCalledTimes(1);
    expect(harness.leaseState.mutations).toEqual(["acquire"]);
    expect(harness.leaseState.current?.releasedAt).toBeNull();
  });

  it("waits for an overlapping stop before starting a safe replacement generation", async () => {
    const releaseEntered = deferred<void>();
    const finishRelease = deferred<void>();
    const workerSignals: AbortSignal[] = [];
    const firstRoom = roomInState("room-1");
    const replacementRoom = roomInState("room-1");
    const harness = createHarness({
      rooms: [firstRoom],
      worker: {
        runRoom: vi.fn(async ({ signal }) => {
          workerSignals.push(signal);
          await holdUntilAbort(signal);
        }),
      },
    });
    vi.mocked(harness.roomStore.listRunnableRooms)
      .mockResolvedValueOnce([firstRoom])
      .mockResolvedValueOnce([replacementRoom])
      .mockResolvedValue([]);

    await harness.controller.start();
    await flushWorkerMicrotasks();
    const releaseLease = vi.mocked(harness.leaseStore.releaseLease);
    const originalRelease = releaseLease.getMockImplementation()!;
    releaseLease.mockImplementationOnce(async (input) => {
      releaseEntered.resolve();
      await finishRelease.promise;
      return originalRelease(input);
    });

    const stopPromise = harness.controller.stop();
    await releaseEntered.promise;
    let restartSettled = false;
    const restartPromise = harness.controller.start().then(() => {
      restartSettled = true;
    });
    await flushWorkerMicrotasks();

    expect(restartSettled).toBe(false);
    expect(harness.roomStore.listRunnableRooms).toHaveBeenCalledTimes(1);
    expect(harness.leaseStore.acquireLease).toHaveBeenCalledTimes(1);
    expect(workerSignals).toHaveLength(1);
    expect(workerSignals[0]?.aborted).toBe(true);

    finishRelease.resolve();
    await Promise.all([stopPromise, restartPromise]);
    await flushWorkerMicrotasks();

    expect(restartSettled).toBe(true);
    expect(harness.roomStore.listRunnableRooms).toHaveBeenCalledTimes(2);
    expect(harness.leaseStore.acquireLease).toHaveBeenCalledTimes(2);
    expect(harness.leaseState.mutations).toEqual(["acquire", "release", "acquire"]);
    expect(workerSignals).toHaveLength(2);
    expect(workerSignals[1]?.aborted).toBe(false);
    expect(vi.mocked(harness.worker.runRoom).mock.calls[1]?.[0].room).toBe(replacementRoom);
  });

  it("does not release or audit a delayed lease acquisition after stop returns", async () => {
    const acquireEntered = deferred<void>();
    const releaseAcquire = deferred<void>();
    const harness = createHarness({ shutdownGraceMs: 30 });
    const acquireLease = vi.mocked(harness.leaseStore.acquireLease);
    const originalAcquire = acquireLease.getMockImplementation()!;
    acquireLease.mockImplementationOnce(async (input) => {
      const acquired = await originalAcquire(input);
      acquireEntered.resolve();
      await releaseAcquire.promise;
      return acquired;
    });

    const startPromise = harness.controller.start();
    await acquireEntered.promise;
    expect(harness.leaseState.mutations).toEqual(["acquire"]);
    expect(harness.leaseState.current?.releasedAt).toBeNull();
    await harness.controller.stop();
    vi.mocked(harness.roomStore.listRunnableRooms).mockResolvedValue([]);
    await harness.controller.start();
    const auditCallCountAfterStop = harness.recordRunAuditEvent.mock.calls.length;
    const releaseCallCountAfterStop = vi.mocked(harness.leaseStore.releaseLease).mock.calls.length;

    releaseAcquire.resolve();
    await startPromise;
    await flushWorkerMicrotasks();

    expect(acquireLease).toHaveBeenCalledTimes(1);
    expect(harness.recordRunAuditEvent).toHaveBeenCalledTimes(auditCallCountAfterStop);
    expect(harness.leaseStore.releaseLease).toHaveBeenCalledTimes(releaseCallCountAfterStop);
    expect(harness.worker.runRoom).not.toHaveBeenCalled();
    expect(harness.leaseState.mutations).toEqual(["acquire"]);
    expect(harness.leaseState.current).toMatchObject({
      roomId: "room-1",
      epoch: 1,
      releasedAt: null,
    });
  });

  it("does not audit or mutate a lease after a delayed renewal crosses stop", async () => {
    const renewEntered = deferred<void>();
    const releaseRenew = deferred<void>();
    const harness = createHarness({ shutdownGraceMs: 30 });
    await harness.controller.start();
    await flushWorkerMicrotasks();
    const leaseBeforeRenew = harness.leaseState.current;
    const renewLease = vi.mocked(harness.leaseStore.renewLease);
    const originalRenew = renewLease.getMockImplementation()!;
    renewLease.mockImplementationOnce(async (input) => {
      const renewed = await originalRenew(input);
      renewEntered.resolve();
      await releaseRenew.promise;
      return renewed;
    });

    const reconcilePromise = harness.controller.reconcile("poll");
    await renewEntered.promise;
    expect(harness.leaseState.current).not.toBe(leaseBeforeRenew);
    expect(harness.leaseState.mutations).toEqual(["acquire", "renew"]);
    await harness.controller.stop();
    vi.mocked(harness.roomStore.listRunnableRooms).mockResolvedValue([]);
    await harness.controller.start();
    const auditCallCountAfterStop = harness.recordRunAuditEvent.mock.calls.length;
    const releaseCallCountAfterStop = vi.mocked(harness.leaseStore.releaseLease).mock.calls.length;
    const releasedLease = harness.leaseState.current;
    const leaseMutationsAfterRestart = [...harness.leaseState.mutations];

    releaseRenew.resolve();
    await reconcilePromise;
    await flushWorkerMicrotasks();

    expect(renewLease).toHaveBeenCalledTimes(1);
    expect(harness.recordRunAuditEvent).toHaveBeenCalledTimes(auditCallCountAfterStop);
    expect(harness.leaseStore.releaseLease).toHaveBeenCalledTimes(releaseCallCountAfterStop);
    expect(harness.leaseState.current).toBe(releasedLease);
    expect(harness.leaseState.current?.releasedAt).toBe(FIXED_NOW);
    expect(harness.leaseState.mutations).toEqual(leaseMutationsAfterRestart);
  });

  it("aborts and fences lease loss before a hung audit delivery can settle", async () => {
    const leaseLostAudit = deferred<void>();
    const workerSignals: AbortSignal[] = [];
    const harness = createHarness({
      renewFailure: "stale_fence",
      worker: {
        runRoom: vi.fn(async ({ signal }) => {
          workerSignals.push(signal);
          await holdUntilAbort(signal);
        }),
      },
      recordRunAuditEventImpl: async (event) => {
        if (event.mutationType === "room:worker-lease-lost") {
          return leaseLostAudit.promise;
        }
      },
    });

    await harness.controller.start();
    await harness.controller.reconcile("poll");

    expect(workerSignals[0]?.aborted).toBe(true);
    expect(harness.leaseStore.releaseLease).not.toHaveBeenCalled();
    expect(harness.recordRunAuditEvent.mock.calls
      .map(([event]) => event)
      .filter((event) => event.mutationType === "room:worker-stopped"))
      .toHaveLength(1);

    leaseLostAudit.resolve();
  });

  it("emits worker-stopped once for a normal worker exit even after controller shutdown", async () => {
    const harness = createHarness({
      worker: { runRoom: vi.fn(async () => undefined) },
    });

    await harness.controller.start();
    await flushWorkerMicrotasks();
    await flushWorkerMicrotasks();
    await harness.controller.stop();

    const stoppedEvents = harness.recordRunAuditEvent.mock.calls
      .map(([event]) => event)
      .filter((event) => event.mutationType === "room:worker-stopped");
    expect(stoppedEvents).toHaveLength(1);
    expect(stoppedEvents[0]).toMatchObject({
      metadata: {
        reason: "worker_completed",
        terminationOutcome: "settled",
      },
    });
  });

  it("emits worker-stopped once with a safe outcome after a worker failure", async () => {
    const harness = createHarness({
      worker: {
        runRoom: vi.fn(async () => {
          throw new Error(SECRET_WORKER_ERROR);
        }),
      },
    });

    await harness.controller.start();
    await flushWorkerMicrotasks();
    await flushWorkerMicrotasks();
    await harness.controller.stop();

    const stoppedEvents = harness.recordRunAuditEvent.mock.calls
      .map(([event]) => event)
      .filter((event) => event.mutationType === "room:worker-stopped");
    expect(stoppedEvents).toHaveLength(1);
    expect(stoppedEvents[0]).toMatchObject({
      metadata: {
        reason: "worker_failed",
        terminationOutcome: "settled",
      },
    });
    expectSafeRoomAuditMetadata(stoppedEvents[0]!);
  });

  it("rechecks durable posture after a successful renew before keeping the worker alive", async () => {
    const workerSignals: AbortSignal[] = [];
    const worker: RoomWorker = {
      runRoom: vi.fn(async ({ signal }) => {
        workerSignals.push(signal);
        await holdUntilAbort(signal);
      }),
    };
    const harness = createHarness({ worker });
    vi.mocked(harness.roomStore.getRecoveryPosture!)
      .mockResolvedValueOnce(recoveryPosture("running", { aggregateVersion: 2 }))
      .mockResolvedValueOnce(recoveryPosture("running", { aggregateVersion: 2 }))
      .mockResolvedValueOnce(recoveryPosture("running", { aggregateVersion: 2 }))
      .mockResolvedValueOnce(recoveryPosture("running", { aggregateVersion: 2 }))
      .mockResolvedValueOnce(recoveryPosture("running", { aggregateVersion: 2 }))
      .mockResolvedValueOnce(recoveryPosture("paused", {
        aggregateVersion: 3,
        humanPaused: true,
      }));

    await harness.controller.start();
    await flushWorkerMicrotasks();
    await harness.controller.reconcile("poll");
    await flushWorkerMicrotasks();

    expect(
      workerSignals[0]?.aborted,
      "Task 4.8 requires renew to fail closed when posture changes after the lease heartbeat commits",
    ).toBe(true);
    expect(harness.leaseStore.releaseLease).toHaveBeenCalledTimes(1);
    expect(findAuditEvent(
      harness.recordRunAuditEvent,
      "room:worker-recovery-withheld",
    )).toMatchObject({
      metadata: {
        aggregateVersion: 3,
        reason: "human_paused",
        source: "poll",
      },
    });
  });

  it("blocks a worker external-effect seam when authority changes after renewal", async () => {
    const attemptEffect = deferred<void>();
    const externalEffect = vi.fn();
    const worker: RoomWorker = {
      runRoom: vi.fn(async ({ assertAuthority }) => {
        await attemptEffect.promise;
        await assertAuthority();
        externalEffect();
      }),
    };
    const harness = createHarness({ worker });
    vi.mocked(harness.roomStore.getRecoveryPosture!)
      .mockResolvedValue(recoveryPosture("running", { aggregateVersion: 2 }));

    await harness.controller.start();
    await flushWorkerMicrotasks();
    await harness.controller.reconcile("poll");

    vi.mocked(harness.roomStore.getRecoveryPosture!)
      .mockResolvedValue(recoveryPosture("paused", {
        aggregateVersion: 3,
        humanPaused: true,
      }));
    attemptEffect.resolve();
    await vi.mocked(worker.runRoom).mock.results[0]?.value.catch(() => undefined);
    await harness.controller.stop();

    expect(
      externalEffect,
      "Task 4.8 requires every worker operation/effect seam to fail closed on the combined posture/lease guard",
    ).not.toHaveBeenCalled();
    expect(harness.leaseStore.releaseLease).toHaveBeenCalledTimes(1);
    expect(findAuditEvent(
      harness.recordRunAuditEvent,
      "room:worker-recovery-withheld",
    )).toMatchObject({
      metadata: {
        aggregateVersion: 3,
        reason: "human_paused",
      },
    });
  });

  it("tracks a pending failure audit and drains it before stop returns", async () => {
    const failureAudit = deferred<void>();
    const harness = createHarness({
      worker: {
        runRoom: vi.fn(async () => {
          throw new Error(SECRET_WORKER_ERROR);
        }),
      },
      recordRunAuditEventImpl: async (event) => {
        if (event.mutationType === "room:worker-recovery-failed") {
          return failureAudit.promise;
        }
      },
    });
    let stopSettled = false;

    await harness.controller.start();
    await flushWorkerMicrotasks();
    await flushWorkerMicrotasks();

    const stopPromise = harness.controller.stop().then(() => {
      stopSettled = true;
    });
    await flushWorkerMicrotasks();

    expect(
      stopSettled,
      "Task 4.8 requires failure audits to stay tracked until shutdown drains them",
    ).toBe(false);

    failureAudit.resolve();
    await stopPromise;
  });

  it("logs only a safe worker failure code instead of the raw worker error", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const harness = createHarness({
        worker: {
          runRoom: vi.fn(async () => {
            throw new Error(SECRET_WORKER_ERROR);
          }),
        },
      });

      await harness.controller.start();
      await flushWorkerMicrotasks();
      await flushWorkerMicrotasks();

      const logged = warnSpy.mock.calls.map((args) => String(args[0] ?? "")).join("\n");
      expect(logged).not.toContain(SECRET_WORKER_ERROR);
      expect(logged).toContain("room_worker_failed");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("emits safe audit metadata when the controller acquires a Room worker lease", async () => {
    const harness = createHarness();

    await harness.controller.start();
    await flushWorkerMicrotasks();

    expect(harness.worker.runRoom).toHaveBeenCalledTimes(1);
    const event = findAuditEvent(
      harness.recordRunAuditEvent,
      "room:worker-lease-acquired",
    );
    expect(
      event,
      "Task 4.8 requires a production Room lifecycle audit sink on RoomController",
    ).toMatchObject({
      timestamp: FIXED_NOW,
      agentId: "worker-1",
      domain: "database",
      mutationType: "room:worker-lease-acquired",
      target: "room-1",
      metadata: {
        projectId: "project-1",
        roomId: "room-1",
        workerId: "worker-1",
        hostId: "host-1",
        leaseId: "room-1:worker-1:lease",
        leaseEpoch: 1,
        source: "startup",
      },
    });
    expectSafeRoomAuditMetadata(event!);
  });

  it("emits safe audit metadata when a restarted controller takes over an expired lease", async () => {
    const harness = createHarness({
      acquireAction: "taken_over",
      acquireEpoch: 2,
    });

    await harness.controller.start();
    await flushWorkerMicrotasks();

    expect(harness.worker.runRoom).toHaveBeenCalledTimes(1);
    const event = findAuditEvent(
      harness.recordRunAuditEvent,
      "room:worker-lease-taken-over",
    );
    expect(
      event,
      "Task 4.8 requires restart takeover to be visible through the production audit seam",
    ).toMatchObject({
      timestamp: FIXED_NOW,
      agentId: "worker-1",
      domain: "database",
      mutationType: "room:worker-lease-taken-over",
      target: "room-1",
      metadata: {
        projectId: "project-1",
        roomId: "room-1",
        workerId: "worker-1",
        hostId: "host-1",
        leaseId: "room-1:worker-1:lease",
        leaseEpoch: 2,
        source: "startup",
      },
    });
    expectSafeRoomAuditMetadata(event!);
  });

  it("emits safe audit metadata and aborts the stale worker when its lease is lost", async () => {
    const workerSignals: AbortSignal[] = [];
    const worker: RoomWorker = {
      runRoom: vi.fn(async ({ signal }) => {
        workerSignals.push(signal);
        await holdUntilAbort(signal);
      }),
    };
    const harness = createHarness({
      renewFailure: "stale_fence",
      worker,
    });

    await harness.controller.start();
    await flushWorkerMicrotasks();
    await harness.controller.reconcile("poll");
    await flushWorkerMicrotasks();

    expect(workerSignals[0]?.aborted).toBe(true);
    const event = findAuditEvent(
      harness.recordRunAuditEvent,
      "room:worker-lease-lost",
    );
    expect(
      event,
      "Task 4.8 requires a fenced lease loss event after renewal rejection",
    ).toMatchObject({
      timestamp: FIXED_NOW,
      agentId: "worker-1",
      domain: "database",
      mutationType: "room:worker-lease-lost",
      target: "room-1",
      metadata: {
        projectId: "project-1",
        roomId: "room-1",
        workerId: "worker-1",
        hostId: "host-1",
        leaseId: "room-1:worker-1:lease",
        leaseEpoch: 1,
        reason: "stale_fence",
        source: "poll",
      },
    });
    expectSafeRoomAuditMetadata(event!);
  });

  it("emits safe audit metadata when a Room worker starts", async () => {
    const harness = createHarness();

    await harness.controller.start();
    await flushWorkerMicrotasks();

    expect(harness.worker.runRoom).toHaveBeenCalledTimes(1);
    const event = findAuditEvent(
      harness.recordRunAuditEvent,
      "room:worker-started",
    );
    expect(
      event,
      "Task 4.8 requires worker start observability through production run-audit",
    ).toMatchObject({
      timestamp: FIXED_NOW,
      agentId: "worker-1",
      domain: "database",
      mutationType: "room:worker-started",
      target: "room-1",
      metadata: {
        projectId: "project-1",
        roomId: "room-1",
        workerId: "worker-1",
        hostId: "host-1",
        leaseId: "room-1:worker-1:lease",
        leaseEpoch: 1,
        source: "startup",
      },
    });
    expectSafeRoomAuditMetadata(event!);
  });

  it("emits safe audit metadata when controller shutdown stops a Room worker", async () => {
    const workerSignals: AbortSignal[] = [];
    const worker: RoomWorker = {
      runRoom: vi.fn(async ({ signal }) => {
        workerSignals.push(signal);
        await holdUntilAbort(signal);
      }),
    };
    const harness = createHarness({ worker });

    await harness.controller.start();
    await flushWorkerMicrotasks();
    await harness.controller.stop();

    expect(workerSignals).toHaveLength(1);
    expect(workerSignals[0]?.aborted).toBe(true);
    expect(harness.leaseStore.releaseLease).toHaveBeenCalledTimes(1);
    const event = findAuditEvent(
      harness.recordRunAuditEvent,
      "room:worker-stopped",
    );
    expect(
      event,
      "Task 4.8 requires worker stop observability through production run-audit",
    ).toMatchObject({
      timestamp: FIXED_NOW,
      agentId: "worker-1",
      domain: "database",
      mutationType: "room:worker-stopped",
      target: "room-1",
      metadata: {
        projectId: "project-1",
        roomId: "room-1",
        workerId: "worker-1",
        hostId: "host-1",
        leaseId: "room-1:worker-1:lease",
        leaseEpoch: 1,
        reason: "controller_stop",
        source: "shutdown",
      },
    });
    expectSafeRoomAuditMetadata(event!);
  });

  it("isolates a recoverable worker failure to one running Room and audits a safe failure code", async () => {
    const survivingSignals: AbortSignal[] = [];
    const worker: RoomWorker = {
      runRoom: vi.fn(async ({ room, signal }) => {
        if (room.room.id === "room-failing") {
          throw new Error(SECRET_WORKER_ERROR);
        }
        survivingSignals.push(signal);
        await holdUntilAbort(signal);
      }),
    };
    const harness = createHarness({
      rooms: [roomInState("room-failing"), roomInState("room-surviving")],
      worker,
    });

    await harness.controller.start();
    await flushWorkerMicrotasks();
    await flushWorkerMicrotasks();

    expect(vi.mocked(worker.runRoom).mock.calls.map(([input]) => input.room.room.id)).toEqual([
      "room-failing",
      "room-surviving",
    ]);
    expect(survivingSignals).toHaveLength(1);
    expect(survivingSignals[0]?.aborted).toBe(false);
    const event = findAuditEvent(
      harness.recordRunAuditEvent,
      "room:worker-recovery-failed",
      "room-failing",
    );
    expect(
      event,
      "Task 4.8 requires a per-Room recovery failure event instead of a global controller failure",
    ).toMatchObject({
      timestamp: FIXED_NOW,
      agentId: "worker-1",
      domain: "database",
      mutationType: "room:worker-recovery-failed",
      target: "room-failing",
      metadata: {
        projectId: "project-1",
        roomId: "room-failing",
        workerId: "worker-1",
        hostId: "host-1",
        leaseId: "room-failing:worker-1:lease",
        leaseEpoch: 1,
        errorCode: "room_worker_failed",
        recoverable: true,
        source: "startup",
      },
    });
    expectSafeRoomAuditMetadata(event!);
  });

  it("scans persisted running Rooms and consults durable recovery posture on startup", async () => {
    const harness = createHarness({
      rooms: [roomInState("room-1"), roomInState("room-2")],
    });

    await harness.controller.start();
    await flushWorkerMicrotasks();

    expect(harness.roomStore.listRunnableRooms).toHaveBeenCalledTimes(1);
    expect(
      harness.roomStore.getRecoveryPosture,
      "Task 4.8 requires startup self-healing to fence before lease, after lease, before handle registration, and again in the worker-launch authority guard",
    ).toHaveBeenCalledTimes(8);
    expect(vi.mocked(harness.roomStore.getRecoveryPosture).mock.calls).toEqual([
      ["room-1"],
      ["room-2"],
      ["room-1"],
      ["room-2"],
      ["room-1"],
      ["room-2"],
      ["room-1"],
      ["room-2"],
    ]);
    expect(vi.mocked(harness.worker.runRoom).mock.calls.map(([input]) => input.room.room.id)).toEqual([
      "room-1",
      "room-2",
    ]);
  });

  it("preserves an explicit human pause instead of auto-recovering the Room on restart", async () => {
    const harness = createHarness({
      // Startup discovery may race a newer pause commit. The controller must
      // re-check the durable posture before it acquires a worker lease.
      rooms: [roomInState("room-human-paused")],
      recoveryPostures: {
        "room-human-paused": recoveryPosture("paused", {
          humanPaused: true,
        }),
      },
    });

    await harness.controller.start();
    await flushWorkerMicrotasks();

    expect(
      harness.worker.runRoom,
      "Task 4.8 startup self-healing must not auto-resume a human-paused Room",
    ).not.toHaveBeenCalled();
    expect(harness.leaseStore.acquireLease).not.toHaveBeenCalled();
    expect(harness.roomStore.getRecoveryPosture).toHaveBeenCalledWith("room-human-paused");
    const event = findAuditEvent(
      harness.recordRunAuditEvent,
      "room:worker-recovery-withheld",
      "room-human-paused",
    );
    expect(event).toMatchObject({
      timestamp: FIXED_NOW,
      agentId: "worker-1",
      domain: "database",
      mutationType: "room:worker-recovery-withheld",
      target: "room-human-paused",
      metadata: {
        projectId: "project-1",
        roomId: "room-human-paused",
        workerId: "worker-1",
        hostId: "host-1",
        lifecycleState: "paused",
        aggregateVersion: 3,
        reason: "human_paused",
        source: "startup",
      },
    });
    expectSafeRoomAuditMetadata(event!);
  });

  it("rechecks durable approval posture after lease commit before starting a worker", async () => {
    const harness = createHarness();
    vi.mocked(harness.roomStore.getRecoveryPosture!)
      .mockResolvedValueOnce(recoveryPosture("running", { aggregateVersion: 2 }))
      .mockResolvedValueOnce(recoveryPosture("running", {
        aggregateVersion: 2,
        approvalState: "waiting",
      }));

    await harness.controller.start();
    await flushWorkerMicrotasks();

    expect(harness.roomStore.getRecoveryPosture).toHaveBeenCalledTimes(2);
    expect(harness.leaseStore.acquireLease).toHaveBeenCalledTimes(1);
    expect(harness.leaseStore.releaseLease).toHaveBeenCalledTimes(1);
    expect(
      harness.worker.runRoom,
      "an approval committed after discovery but before lease commit must fail closed",
    ).not.toHaveBeenCalled();
    expect(findAuditEvent(
      harness.recordRunAuditEvent,
      "room:worker-recovery-withheld",
    )).toMatchObject({
      metadata: {
        aggregateVersion: 2,
        reason: "approval_waiting",
        source: "startup",
      },
    });
  });

  it("does not steal-run Rooms whose durable recovery posture is approval-waiting or blocked", async () => {
    const harness = createHarness({
      rooms: [
        roomInState("room-approval-waiting"),
        roomInState("room-approval-blocked"),
      ],
      recoveryPostures: {
        "room-approval-waiting": recoveryPosture("blocked", {
          approvalState: "waiting",
        }),
        "room-approval-blocked": recoveryPosture("blocked", {
          approvalState: "blocked",
        }),
      },
    });

    await harness.controller.start();
    await flushWorkerMicrotasks();

    expect(
      harness.worker.runRoom,
      "Task 4.8 startup self-healing must preserve approval waiting/blocked posture",
    ).not.toHaveBeenCalled();
    expect(harness.leaseStore.acquireLease).not.toHaveBeenCalled();
    expect(harness.roomStore.getRecoveryPosture).toHaveBeenCalledTimes(2);
    for (const [roomId, reason] of [
      ["room-approval-waiting", "approval_waiting"],
      ["room-approval-blocked", "approval_blocked"],
    ] as const) {
      const event = findAuditEvent(
        harness.recordRunAuditEvent,
        "room:worker-recovery-withheld",
        roomId,
      );
      expect(event).toMatchObject({
        mutationType: "room:worker-recovery-withheld",
        target: roomId,
        metadata: {
          projectId: "project-1",
          roomId,
          lifecycleState: "blocked",
          reason,
          source: "startup",
        },
      });
      expectSafeRoomAuditMetadata(event!);
    }
  });

  it("does not acquire worker leases or start workers for terminal Room states", async () => {
    const terminalStates = [
      ["room-completed", "completed"],
      ["room-completed-with-risks", "completed_with_risks"],
      ["room-partial", "partial"],
      ["room-cancelled", "cancelled"],
      ["room-failed", "failed"],
      ["room-archived", "archived"],
    ] as const satisfies readonly (readonly [string, RoomLifecycleState])[];
    const harness = createHarness({
      // These are stale running snapshots from startup discovery. Each latest
      // durable posture became terminal before claim, which must fail closed.
      rooms: terminalStates.map(([roomId]) => roomInState(roomId)),
      recoveryPostures: Object.fromEntries(
        terminalStates.map(([roomId, state]) => [roomId, recoveryPosture(state)]),
      ),
    });

    await harness.controller.start();
    await flushWorkerMicrotasks();

    expect(harness.worker.runRoom).not.toHaveBeenCalled();
    expect(
      harness.leaseStore.acquireLease,
      "Task 4.8 startup self-healing must reject terminal Rooms before worker lease acquisition",
    ).not.toHaveBeenCalled();
    for (const [roomId, lifecycleState] of terminalStates) {
      const event = findAuditEvent(
        harness.recordRunAuditEvent,
        "room:worker-recovery-withheld",
        roomId,
      );
      expect(event).toMatchObject({
        mutationType: "room:worker-recovery-withheld",
        target: roomId,
        metadata: {
          roomId,
          lifecycleState,
          reason: "terminal_state",
          source: "startup",
        },
      });
      expectSafeRoomAuditMetadata(event!);
    }
  });

  it("stops an existing worker when a newer durable human pause is observed", async () => {
    const workerSignals: AbortSignal[] = [];
    const worker: RoomWorker = {
      runRoom: vi.fn(async ({ signal }) => {
        workerSignals.push(signal);
        await holdUntilAbort(signal);
      }),
    };
    const harness = createHarness({ worker });
    vi.mocked(harness.roomStore.getRecoveryPosture!)
      .mockResolvedValueOnce(recoveryPosture("running", { aggregateVersion: 2 }))
      .mockResolvedValueOnce(recoveryPosture("running", { aggregateVersion: 2 }))
      .mockResolvedValueOnce(recoveryPosture("running", { aggregateVersion: 2 }))
      .mockResolvedValueOnce(recoveryPosture("running", { aggregateVersion: 2 }))
      .mockResolvedValue(recoveryPosture("paused", {
        aggregateVersion: 3,
        humanPaused: true,
      }));

    await harness.controller.start();
    await flushWorkerMicrotasks();

    await harness.controller.reconcile("poll");
    await flushWorkerMicrotasks();

    expect(worker.runRoom).toHaveBeenCalledTimes(1);
    expect(workerSignals[0]?.aborted).toBe(true);
    expect(harness.leaseStore.releaseLease).toHaveBeenCalledTimes(1);
    expect(
      harness.roomStore.getRecoveryPosture,
      "Task 4.8 requires claim, post-lease start, and renew paths to re-check the durable human-control guard",
    ).toHaveBeenCalledTimes(5);
    const event = findAuditEvent(
      harness.recordRunAuditEvent,
      "room:worker-recovery-withheld",
    );
    expect(event).toMatchObject({
      mutationType: "room:worker-recovery-withheld",
      target: "room-1",
      metadata: {
        lifecycleState: "paused",
        aggregateVersion: 3,
        reason: "human_paused",
        source: "poll",
      },
    });
    expectSafeRoomAuditMetadata(event!);
  });
});
