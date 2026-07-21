import {
  createRoomAggregate,
  transitionRoomLifecycle,
  type RoomAggregateV1,
  type StoredRoomLeaseV1,
} from "@fusion/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RoomController,
  type ProcessRoomSemanticControllerInboxInput,
  type RoomControllerLeaseStore,
  type RoomControllerOptions,
  type RoomSemanticControllerInboxProcessSummary,
  type RoomWorkerRunInput,
} from "../index.js";

const PROJECT_ID = "project-semantic-inbox";
const ROOM_ID = "room-semantic-inbox";
const WORKER_ID = "room-worker-1";
const HOST_ID = "host-controller";
const NOW = "2026-07-19T04:20:00.000Z";

const controllers: RoomController[] = [];

afterEach(async () => {
  for (const controller of controllers.splice(0)) {
    await controller.stop();
  }
});

function runningRoom(): RoomAggregateV1 {
  const draft = createRoomAggregate({
    id: ROOM_ID,
    projectId: PROJECT_ID,
    objective: "Consume durable controller-directed semantic work",
    protocolId: "implementation",
    protocolVersion: 1,
    now: "2026-07-19T04:19:57.000Z",
  });
  const ready = transitionRoomLifecycle(draft, {
    to: "ready",
    expectedAggregateVersion: 0,
    now: "2026-07-19T04:19:58.000Z",
  });
  return transitionRoomLifecycle(ready, {
    to: "running",
    expectedAggregateVersion: 1,
    now: "2026-07-19T04:19:59.000Z",
  });
}

function workerLease(overrides: Partial<StoredRoomLeaseV1> = {}): StoredRoomLeaseV1 {
  return {
    contractVersion: 1,
    id: "room-worker-lease-1",
    roomId: ROOM_ID,
    kind: "room_worker",
    resourceId: ROOM_ID,
    holderId: WORKER_ID,
    hostId: HOST_ID,
    epoch: 1,
    acquiredAt: NOW,
    heartbeatAt: NOW,
    expiresAt: "2026-07-19T04:21:00.000Z",
    releasedAt: null,
    ...overrides,
  };
}

interface LeaseStoreHarness {
  readonly store: RoomControllerLeaseStore;
  readonly acquireInputs: Array<Parameters<RoomControllerLeaseStore["acquireLease"]>[0]>;
  readonly renewInputs: Array<Parameters<RoomControllerLeaseStore["renewLease"]>[0]>;
  readonly releaseInputs: Array<Parameters<RoomControllerLeaseStore["releaseLease"]>[0]>;
  readonly assertInputs: Array<Parameters<RoomControllerLeaseStore["assertFence"]>[0]>;
  current(): StoredRoomLeaseV1;
}

function createLeaseStore(callOrder: string[] = []): LeaseStoreHarness {
  let current = workerLease();
  const acquireInputs: LeaseStoreHarness["acquireInputs"] = [];
  const renewInputs: LeaseStoreHarness["renewInputs"] = [];
  const releaseInputs: LeaseStoreHarness["releaseInputs"] = [];
  const assertInputs: LeaseStoreHarness["assertInputs"] = [];

  return {
    store: {
      acquireLease: async (input) => {
        callOrder.push("lease-acquired");
        acquireInputs.push(input);
        return { ok: true, action: "acquired", lease: current };
      },
      renewLease: async (input) => {
        callOrder.push("lease-renewed");
        renewInputs.push(input);
        current = {
          ...current,
          heartbeatAt: input.now,
          expiresAt: input.expiresAt,
        };
        return { ok: true, lease: current };
      },
      releaseLease: async (input) => {
        callOrder.push("lease-released");
        releaseInputs.push(input);
        current = { ...current, releasedAt: input.now };
        return { ok: true, lease: current };
      },
      assertFence: async (input) => {
        callOrder.push("lease-observed");
        assertInputs.push(input);
        return current;
      },
    },
    acquireInputs,
    renewInputs,
    releaseInputs,
    assertInputs,
    current: () => current,
  };
}

function semanticSummary(
  lease: StoredRoomLeaseV1,
  stopped = false,
): RoomSemanticControllerInboxProcessSummary {
  return {
    roomId: ROOM_ID,
    lease,
    claimedActionCount: 0,
    processedActionCount: 0,
    retriedActionCount: 0,
    processedActionKinds: {
      semantic_message: 0,
      semantic_loop_break: 0,
    },
    retriedActionKinds: {
      semantic_message: 0,
      semantic_loop_break: 0,
    },
    reachedMaxActions: false,
    stopped,
    stopReason: stopped ? "controller_stopped" : null,
  };
}

function createWaitingWorker(callOrder: string[] = []) {
  const signals: AbortSignal[] = [];
  const leases: StoredRoomLeaseV1[] = [];
  const runRoom = vi.fn(async ({ lease, signal }: RoomWorkerRunInput) => {
    callOrder.push("worker-started");
    leases.push(lease);
    signals.push(signal);
    await new Promise<void>((resolve) => signal.addEventListener("abort", resolve, { once: true }));
  });

  return {
    worker: { runRoom },
    runRoom,
    signals,
    leases,
  };
}

type ControllerFixtureOptions = Pick<
  RoomControllerOptions,
  "roomStore" | "leaseStore" | "worker" | "semanticControllerInboxProcessor" | "capacityAdmission"
>;

function createController(options: ControllerFixtureOptions): RoomController {
  const controller = new RoomController({
    projectId: PROJECT_ID,
    workerId: WORKER_ID,
    hostId: HOST_ID,
    recordRunAuditEvent: async () => undefined,
    now: () => NOW,
    createLeaseId: () => "room-worker-lease-1",
    leaseDurationMs: 60_000,
    pollIntervalMs: 60_000,
    ...options,
  });
  controllers.push(controller);
  return controller;
}

/*
FNXC:SessionRoomSemanticControllerInbox 2026-07-19-04:20:
Controller-directed semantic work must run under the current Room-worker fence
before worker launch and on every renewal. A stopped inbox pass must release or
abort lifecycle state so no worker continues with an obsolete fence.
*/
describe("RoomController semantic controller inbox seam", () => {
  it("runs the processor under the acquired current lease before launching the worker", async () => {
    const callOrder: string[] = [];
    const leaseStore = createLeaseStore(callOrder);
    const processorInputs: ProcessRoomSemanticControllerInboxInput[] = [];
    const processor = {
      process: vi.fn(async (input: ProcessRoomSemanticControllerInboxInput) => {
        callOrder.push("semantic-processor");
        processorInputs.push(input);
        expect(input.roomId).toBe(ROOM_ID);
        expect(input.lease).toEqual(leaseStore.current());
        expect(input.canContinue?.()).toBe(true);

        const renewed = await input.renewLease(input.lease);
        expect(renewed).toEqual(leaseStore.current());
        expect(input.observeLease).toBeTypeOf("function");
        const observed = await input.observeLease!(renewed!);
        expect(observed).toEqual(leaseStore.current());

        return semanticSummary(observed!, false);
      }),
    };
    const worker = createWaitingWorker(callOrder);
    const controller = createController({
      roomStore: { listRunnableRooms: async () => [runningRoom()] },
      leaseStore: leaseStore.store,
      worker: worker.worker,
      semanticControllerInboxProcessor: processor,
    });

    await controller.start();

    expect(processor.process).toHaveBeenCalledTimes(1);
    expect(worker.runRoom).toHaveBeenCalledTimes(1);
    expect(leaseStore.acquireInputs).toHaveLength(1);
    expect(leaseStore.renewInputs).toHaveLength(1);
    expect(processorInputs[0]).toMatchObject({
      roomId: ROOM_ID,
      lease: {
        id: "room-worker-lease-1",
        holderId: WORKER_ID,
        hostId: HOST_ID,
        epoch: 1,
        releasedAt: null,
      },
    });
    expect(callOrder.indexOf("lease-acquired")).toBeLessThan(callOrder.indexOf("semantic-processor"));
    expect(callOrder.indexOf("semantic-processor")).toBeLessThan(callOrder.indexOf("worker-started"));
    expect(worker.leases[0]).toEqual(leaseStore.current());
  });

  it("re-invokes the processor after the current worker lease is renewed", async () => {
    const callOrder: string[] = [];
    const leaseStore = createLeaseStore(callOrder);
    const processorLeases: StoredRoomLeaseV1[] = [];
    const processor = {
      process: vi.fn(async (input: ProcessRoomSemanticControllerInboxInput) => {
        processorLeases.push(input.lease);
        callOrder.push(`semantic-processor-${processorLeases.length}`);
        return semanticSummary(input.lease);
      }),
    };
    const worker = createWaitingWorker(callOrder);
    const controller = createController({
      roomStore: { listRunnableRooms: async () => [runningRoom()] },
      leaseStore: leaseStore.store,
      worker: worker.worker,
      semanticControllerInboxProcessor: processor,
    });

    await controller.start();
    await controller.reconcile("test-renewal");

    expect(processor.process).toHaveBeenCalledTimes(2);
    expect(worker.runRoom).toHaveBeenCalledTimes(1);
    expect(leaseStore.renewInputs).toHaveLength(1);
    expect(processorLeases[1]).toEqual(leaseStore.current());
    expect(callOrder.indexOf("lease-renewed")).toBeLessThan(
      callOrder.indexOf("semantic-processor-2"),
    );
  });

  it("releases the lease without launching a worker when the initial inbox pass stops", async () => {
    const leaseStore = createLeaseStore();
    const processor = {
      process: vi.fn(async (input: ProcessRoomSemanticControllerInboxInput) => semanticSummary(input.lease, true)),
    };
    const worker = createWaitingWorker();
    const controller = createController({
      roomStore: { listRunnableRooms: async () => [runningRoom()] },
      leaseStore: leaseStore.store,
      worker: worker.worker,
      semanticControllerInboxProcessor: processor,
    });

    await controller.start();
    await Promise.resolve();

    expect(processor.process).toHaveBeenCalledTimes(1);
    expect(worker.runRoom).not.toHaveBeenCalled();
    expect(leaseStore.releaseInputs).toHaveLength(1);
    expect(leaseStore.releaseInputs[0]).toMatchObject({
      leaseId: "room-worker-lease-1",
      roomId: ROOM_ID,
      expectedEpoch: 1,
    });
    expect(leaseStore.current().releasedAt).toBe(NOW);
  });

  it("stops an active worker when a renewal inbox pass reports stopped", async () => {
    const callOrder: string[] = [];
    const leaseStore = createLeaseStore(callOrder);
    let processorPasses = 0;
    const processor = {
      process: vi.fn(async (input: ProcessRoomSemanticControllerInboxInput) => {
        processorPasses += 1;
        callOrder.push(`semantic-processor-${processorPasses}`);
        return semanticSummary(input.lease, processorPasses === 2);
      }),
    };
    const worker = createWaitingWorker(callOrder);
    const controller = createController({
      roomStore: { listRunnableRooms: async () => [runningRoom()] },
      leaseStore: leaseStore.store,
      worker: worker.worker,
      semanticControllerInboxProcessor: processor,
    });

    await controller.start();
    expect(worker.signals).toHaveLength(1);

    await controller.reconcile("semantic-stop");
    await Promise.resolve();

    expect(processor.process).toHaveBeenCalledTimes(2);
    expect(worker.runRoom).toHaveBeenCalledTimes(1);
    expect(worker.signals[0]?.aborted).toBe(true);
    expect(leaseStore.releaseInputs).toHaveLength(1);
    expect(leaseStore.current().releasedAt).toBe(NOW);
    expect(callOrder.indexOf("lease-renewed")).toBeLessThan(
      callOrder.indexOf("semantic-processor-2"),
    );
  });

  it("aborts before a semantic action when its worker lease renewal cannot renew the active global capacity claim", async () => {
    const leaseStore = createLeaseStore();
    const global = {
      acquire: vi.fn(async () => ({
        action: "acquired" as const,
        reason: "capacity_admitted" as const,
        replayed: false,
        claimId: "semantic-capacity-claim",
        fence: 1,
      })),
      renew: vi.fn()
        .mockResolvedValueOnce({
          action: "renewed" as const,
          reason: "capacity_admitted" as const,
          replayed: false,
          claimId: "semantic-capacity-claim",
          fence: 1,
        })
        .mockResolvedValueOnce({
          action: "held" as const,
          reason: "global_capacity_exhausted" as const,
          replayed: false,
          claimId: null,
          fence: null,
        }),
      release: vi.fn(async () => ({
        action: "released" as const,
        reason: "capacity_admitted" as const,
        replayed: false,
        claimId: "semantic-capacity-claim",
        fence: 1,
      })),
    };
    let processorPasses = 0;
    let semanticActionRan = false;
    const processor = {
      process: vi.fn(async (input: ProcessRoomSemanticControllerInboxInput) => {
        processorPasses += 1;
        if (processorPasses === 1) return semanticSummary(input.lease);
        const renewed = await input.renewLease(input.lease);
        if (renewed) semanticActionRan = true;
        return semanticSummary(renewed ?? input.lease, renewed === null);
      }),
    };
    const worker = createWaitingWorker();
    const controller = createController({
      roomStore: { listRunnableRooms: async () => [runningRoom()] },
      leaseStore: leaseStore.store,
      worker: worker.worker,
      semanticControllerInboxProcessor: processor,
      capacityAdmission: {
        globalAccounting: global,
        workClass: "normal",
        slots: 1,
        leaseTtlMs: 60_000,
        renewalIntervalMs: 5_000,
        createClaimId: () => "semantic-capacity-claim",
      },
    });

    await controller.start();
    await controller.reconcile("semantic-capacity-renewal");

    expect(global.renew).toHaveBeenCalledTimes(2);
    expect(semanticActionRan).toBe(false);
    expect(worker.signals[0]?.aborted).toBe(true);
    expect(global.release).toHaveBeenCalledTimes(1);
  });
});
