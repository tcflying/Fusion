import { describe, expect, it, vi } from "vitest";

import {
  GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION,
  GLOBAL_CAPACITY_LEGACY_ATTEMPT_POSTGRES_CONTRACT_VERSION,
  type GlobalCapacityLedgerMutationResultV1,
  type GlobalCapacityLedgerPostgresPortsV1,
  type GlobalCapacityLedgerSnapshotV1,
  type GlobalCapacityLegacyAttemptPrepareInputV1,
  type GlobalCapacityLegacyAttemptStoreV1,
  type GlobalCapacityLegacyAttemptV1,
  type GlobalCapacityLegacyAttemptWorkStartResultV1,
} from "@fusion/core";

import {
  createGlobalCapacityLegacyAttemptRunner,
  type GlobalCapacityLegacyAttemptRunnerV1,
} from "../global-capacity-legacy-attempt-runner.js";

const PREPARED: GlobalCapacityLegacyAttemptV1 = {
  contractVersion: GLOBAL_CAPACITY_LEGACY_ATTEMPT_POSTGRES_CONTRACT_VERSION,
  id: "attempt-1",
  projectId: "project-a",
  resourceKind: "legacy_task",
  resourceId: "FN-100",
  state: "prepared",
  workClass: "normal",
  slots: 1,
  holderId: "executor-owner-1",
  leaseId: "lease-1",
  capacityFence: 7,
  claimId: "claim-1",
  acquireOperationId: "acquire-1",
  acquireGeneration: 1,
  lastWithheldOperationId: null,
  renewOperationId: "renew-1",
  renewGeneration: 1,
  lastRenewalOperationId: null,
  releaseOperationId: "release-1",
  preparedAt: "2026-07-20T05:20:00.000Z",
  expiresAt: "2026-07-20T05:25:00.000Z",
  admittedAt: null,
  workStartedAt: null,
  workFinishedAt: null,
  releasedAt: null,
  supersededAt: null,
  updatedAt: "2026-07-20T05:20:00.000Z",
};

const ADMITTED: GlobalCapacityLegacyAttemptV1 = {
  ...PREPARED,
  state: "admitted",
  admittedAt: "2026-07-20T05:20:01.000Z",
  updatedAt: "2026-07-20T05:20:01.000Z",
};

const STARTED: GlobalCapacityLegacyAttemptV1 = {
  ...ADMITTED,
  state: "work_started",
  workStartedAt: "2026-07-20T05:20:02.000Z",
  updatedAt: "2026-07-20T05:20:02.000Z",
};

const WITHHELD: GlobalCapacityLegacyAttemptV1 = {
  ...PREPARED,
  state: "withheld",
  acquireOperationId: "acquire-2",
  acquireGeneration: 2,
  lastWithheldOperationId: PREPARED.acquireOperationId,
  updatedAt: "2026-07-20T05:20:01.000Z",
};

const RENEWED: GlobalCapacityLegacyAttemptV1 = {
  ...STARTED,
  renewOperationId: "renew-2",
  renewGeneration: 2,
  lastRenewalOperationId: STARTED.renewOperationId,
  expiresAt: "2026-07-20T05:25:03.000Z",
  updatedAt: "2026-07-20T05:20:03.000Z",
};

const RENEWAL_ADVANCED: GlobalCapacityLegacyAttemptV1 = {
  ...STARTED,
  renewOperationId: "renew-2",
  renewGeneration: 2,
  lastRenewalOperationId: STARTED.renewOperationId,
  updatedAt: "2026-07-20T05:20:03.000Z",
};

const RENEWED_TWICE: GlobalCapacityLegacyAttemptV1 = {
  ...RENEWED,
  renewOperationId: "renew-3",
  renewGeneration: 3,
  lastRenewalOperationId: RENEWED.renewOperationId,
};

const FINISHED: GlobalCapacityLegacyAttemptV1 = {
  ...STARTED,
  state: "work_finished",
  workFinishedAt: "2026-07-20T05:20:03.000Z",
  updatedAt: "2026-07-20T05:20:03.000Z",
};

const RENEWED_FINISHED: GlobalCapacityLegacyAttemptV1 = {
  ...RENEWED,
  state: "work_finished",
  workFinishedAt: "2026-07-20T05:20:04.000Z",
  updatedAt: "2026-07-20T05:20:04.000Z",
};

const RELEASED_ATTEMPT: GlobalCapacityLegacyAttemptV1 = {
  ...FINISHED,
  state: "released",
  releasedAt: "2026-07-20T05:20:04.000Z",
  updatedAt: "2026-07-20T05:20:04.000Z",
};

const RENEWED_RELEASED: GlobalCapacityLegacyAttemptV1 = {
  ...RENEWED_FINISHED,
  state: "released",
  releasedAt: "2026-07-20T05:20:05.000Z",
  updatedAt: "2026-07-20T05:20:05.000Z",
};

const ACQUIRED: GlobalCapacityLedgerMutationResultV1 = {
  action: "acquired",
  reason: "capacity_admitted",
  replayed: false,
  claimId: PREPARED.claimId,
  fence: PREPARED.capacityFence,
};

const HELD: GlobalCapacityLedgerMutationResultV1 = {
  action: "held",
  reason: "global_capacity_exhausted",
  replayed: false,
  claimId: null,
  fence: null,
};

const ACQUIRE_REJECTED: GlobalCapacityLedgerMutationResultV1 = {
  action: "rejected",
  reason: "stale_fence",
  replayed: false,
  claimId: null,
  fence: null,
};

const RENEWAL_SUCCEEDED: GlobalCapacityLedgerMutationResultV1 = {
  action: "renewed",
  reason: "capacity_renewed",
  replayed: false,
  claimId: PREPARED.claimId,
  fence: PREPARED.capacityFence,
};

const RENEWAL_REJECTED: GlobalCapacityLedgerMutationResultV1 = {
  action: "rejected",
  reason: "stale_fence",
  replayed: false,
  claimId: null,
  fence: null,
};

const RELEASE_SUCCEEDED: GlobalCapacityLedgerMutationResultV1 = {
  action: "released",
  reason: "capacity_released",
  replayed: false,
  claimId: PREPARED.claimId,
  fence: PREPARED.capacityFence,
};

const RELEASE_REJECTED: GlobalCapacityLedgerMutationResultV1 = {
  action: "rejected",
  reason: "stale_fence",
  replayed: false,
  claimId: null,
  fence: null,
};

const SNAPSHOT: GlobalCapacityLedgerSnapshotV1 = {
  contractVersion: GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION,
  snapshotId: "snapshot-1",
  stateRevision: 1,
  observedAt: PREPARED.preparedAt,
  expiresAt: PREPARED.expiresAt,
  totalSlots: 4,
  reservations: {
    verifierSlots: 0,
    recoverySlots: 0,
    legacyTaskTriageSlots: 0,
  },
  ownClaims: [],
  foreignOccupancy: {
    totalSlots: 0,
    legacyTaskSlots: 0,
    legacyTriageSlots: 0,
    roomWorkerSlots: 0,
    normalSlots: 0,
    verifierSlots: 0,
    recoverySlots: 0,
  },
};

const PREPARE_INPUT: GlobalCapacityLegacyAttemptPrepareInputV1 = {
  contractVersion: GLOBAL_CAPACITY_LEGACY_ATTEMPT_POSTGRES_CONTRACT_VERSION,
  resourceKind: PREPARED.resourceKind,
  resourceId: PREPARED.resourceId,
  workClass: PREPARED.workClass,
  slots: PREPARED.slots,
  holderId: PREPARED.holderId,
};

function createStore(overrides: Partial<GlobalCapacityLegacyAttemptStoreV1> = {}): GlobalCapacityLegacyAttemptStoreV1 {
  const granted: GlobalCapacityLegacyAttemptWorkStartResultV1 = {
    outcome: "execution_granted",
    attempt: STARTED,
    executionReceiptId: "work-start-1",
  };
  return {
    prepare: vi.fn(async () => ({
      outcome: "ready" as const,
      reason: "created" as const,
      replayed: false,
      attempt: PREPARED,
    })),
    read: vi.fn(async () => null),
    recordWithheld: vi.fn(async () => PREPARED),
    recordAdmission: vi.fn(async () => ADMITTED),
    recordRenewed: vi.fn(async () => STARTED),
    advanceRenewalAfterDurableFailure: vi.fn(async () => STARTED),
    recordWorkStarted: vi.fn(async () => granted),
    recordWorkFinished: vi.fn(async () => STARTED),
    recordReleased: vi.fn(async () => STARTED),
    ...overrides,
  };
}

function createLedger(overrides: Partial<GlobalCapacityLedgerPostgresPortsV1> = {}): GlobalCapacityLedgerPostgresPortsV1 {
  return {
    readSnapshot: vi.fn(async () => SNAPSHOT),
    acquire: vi.fn(async () => ACQUIRED),
    renew: vi.fn(async () => ({
      action: "renewed" as const,
      reason: "capacity_renewed" as const,
      replayed: false,
      claimId: PREPARED.claimId,
      fence: PREPARED.capacityFence,
    })),
    release: vi.fn(async () => ({
      action: "released" as const,
      reason: "capacity_released" as const,
      replayed: false,
      claimId: PREPARED.claimId,
      fence: PREPARED.capacityFence,
    })),
    ...overrides,
  };
}

function createRunner(
  store: GlobalCapacityLegacyAttemptStoreV1,
  ledger: GlobalCapacityLedgerPostgresPortsV1,
): GlobalCapacityLegacyAttemptRunnerV1 {
  return createGlobalCapacityLegacyAttemptRunner({
    projectId: PREPARED.projectId,
    store,
    ledger,
    policy: {
      reservations: {
        verifierSlots: 0,
        recoverySlots: 0,
        legacyTaskTriageSlots: 0,
      },
      snapshotTtlMs: 30_000,
      leaseTtlMs: 300_000,
    },
    now: () => "2026-07-20T05:20:03.000Z",
  });
}

describe("global capacity legacy attempt runner", () => {
  it("records durable admission and work start before exposing an execution grant", async () => {
    const events: string[] = [];
    const store = createStore({
      prepare: vi.fn(async () => {
        events.push("prepare");
        return { outcome: "ready" as const, reason: "created" as const, replayed: false, attempt: PREPARED };
      }),
      recordAdmission: vi.fn(async () => {
        events.push("record-admission");
        return ADMITTED;
      }),
      recordWorkStarted: vi.fn(async () => {
        events.push("record-work-started");
        return { outcome: "execution_granted" as const, attempt: STARTED, executionReceiptId: "work-start-1" };
      }),
    });
    const ledger = createLedger({
      acquire: vi.fn(async (input) => {
        events.push("acquire");
        expect(input).toEqual({
          contractVersion: GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION,
          projectId: PREPARED.projectId,
          resourceKind: PREPARED.resourceKind,
          resourceId: PREPARED.resourceId,
          claimId: PREPARED.claimId,
          operationId: PREPARED.acquireOperationId,
          workClass: PREPARED.workClass,
          slots: PREPARED.slots,
          holderId: PREPARED.holderId,
          leaseId: PREPARED.leaseId,
          fence: PREPARED.capacityFence,
          asOf: PREPARED.preparedAt,
          expiresAt: PREPARED.expiresAt,
        });
        return ACQUIRED;
      }),
    });

    const result = await createRunner(store, ledger).run(PREPARE_INPUT);

    expect(result.state).toBe("execution_granted");
    if (result.state !== "execution_granted") throw new Error("Expected durable execution grant");
    expect(result.attempt).toEqual(STARTED);
    expect(result.executionReceiptId).toBe("work-start-1");
    expect(events).toEqual(["prepare", "acquire", "record-admission", "record-work-started"]);
  });

  it("does not schedule an automatic renewal after granting execution", async () => {
    vi.useFakeTimers();
    try {
      const store = createStore();
      const ledger = createLedger();
      const now = vi.fn(() => "2026-07-20T05:20:03.000Z");
      const runner = createGlobalCapacityLegacyAttemptRunner({
        projectId: PREPARED.projectId,
        store,
        ledger,
        policy: {
          reservations: { verifierSlots: 0, recoverySlots: 0, legacyTaskTriageSlots: 0 },
          snapshotTtlMs: 30_000,
          leaseTtlMs: 300_000,
        },
        now,
      });

      await expect(runner.run(PREPARE_INPUT)).resolves.toMatchObject({ state: "execution_granted" });
      await vi.advanceTimersByTimeAsync(600_000);

      expect(ledger.renew).not.toHaveBeenCalled();
      expect(now).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("persists a durable held response and never enters work start", async () => {
    const events: string[] = [];
    const store = createStore({
      prepare: vi.fn(async () => {
        events.push("prepare");
        return { outcome: "ready" as const, reason: "created" as const, replayed: false, attempt: PREPARED };
      }),
      recordWithheld: vi.fn(async () => {
        events.push("record-withheld");
        return WITHHELD;
      }),
    });
    const ledger = createLedger({
      acquire: vi.fn(async () => {
        events.push("acquire");
        return HELD;
      }),
    });

    const result = await createRunner(store, ledger).run(PREPARE_INPUT);

    expect(result).toEqual({
      state: "withheld",
      reason: "ledger_held",
      attempt: WITHHELD,
      admission: HELD,
    });
    expect(store.recordWithheld).toHaveBeenCalledWith({
      contractVersion: PREPARED.contractVersion,
      attemptId: PREPARED.id,
      resourceKind: PREPARED.resourceKind,
      resourceId: PREPARED.resourceId,
      capacityFence: PREPARED.capacityFence,
      observedAcquireOperationId: PREPARED.acquireOperationId,
    });
    expect(events).toEqual(["prepare", "acquire", "record-withheld"]);
    expect(store.recordAdmission).not.toHaveBeenCalled();
    expect(store.recordWorkStarted).not.toHaveBeenCalled();
  });

  it("never enters work start for rejected admission or durable recovery", async () => {
    const recoveryStore = createStore({
      prepare: vi.fn(async () => ({
        outcome: "recovery_required" as const,
        reason: "external_work_may_have_started" as const,
        replayed: true,
        attempt: STARTED,
      })),
    });
    const recoveryLedger = createLedger();

    await expect(createRunner(recoveryStore, recoveryLedger).run(PREPARE_INPUT)).resolves.toEqual({
      state: "recovery_required",
      attempt: STARTED,
    });
    expect(recoveryLedger.acquire).not.toHaveBeenCalled();
    expect(recoveryStore.recordWorkStarted).not.toHaveBeenCalled();

    const rejectedStore = createStore();
    const rejectedLedger = createLedger({ acquire: vi.fn(async () => ACQUIRE_REJECTED) });

    await expect(createRunner(rejectedStore, rejectedLedger).run(PREPARE_INPUT)).resolves.toEqual({
      state: "rejected",
      reason: "stale_fence",
      attempt: PREPARED,
      admission: ACQUIRE_REJECTED,
    });
    expect(rejectedStore.recordWithheld).not.toHaveBeenCalled();
    expect(rejectedStore.recordAdmission).not.toHaveBeenCalled();
    expect(rejectedStore.recordWorkStarted).not.toHaveBeenCalled();
  });

  it("renews with the current durable operation and advances the handle only after Core records it", async () => {
    const store = createStore({
      recordRenewed: vi.fn(async () => RENEWED),
    });
    const ledger = createLedger({
      renew: vi.fn(async (input) => {
        expect(input).toEqual({
          contractVersion: GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION,
          projectId: STARTED.projectId,
          resourceKind: STARTED.resourceKind,
          resourceId: STARTED.resourceId,
          claimId: STARTED.claimId,
          operationId: STARTED.renewOperationId,
          holderId: STARTED.holderId,
          leaseId: STARTED.leaseId,
          fence: STARTED.capacityFence,
          asOf: "2026-07-20T05:20:03.000Z",
          expiresAt: "2026-07-20T05:25:03.000Z",
        });
        return RENEWAL_SUCCEEDED;
      }),
    });
    const started = await createRunner(store, ledger).run(PREPARE_INPUT);
    if (started.state !== "execution_granted") throw new Error("Expected durable execution grant");

    const renewed = await started.handle.renew();

    expect(renewed).toEqual({ state: "renewed", attempt: RENEWED, renewal: RENEWAL_SUCCEEDED });
    expect(store.recordRenewed).toHaveBeenCalledWith({
      contractVersion: STARTED.contractVersion,
      attemptId: STARTED.id,
      resourceKind: STARTED.resourceKind,
      resourceId: STARTED.resourceId,
      capacityFence: STARTED.capacityFence,
      observedRenewOperationId: STARTED.renewOperationId,
    });
    expect(started.handle.attempt).toEqual(RENEWED);
  });

  it("advances a renewal operation only after Core confirms the rejected ledger operation is durable", async () => {
    const store = createStore({
      advanceRenewalAfterDurableFailure: vi.fn(async () => RENEWAL_ADVANCED),
    });
    const ledger = createLedger({
      renew: vi.fn(async () => RENEWAL_REJECTED),
    });
    const started = await createRunner(store, ledger).run(PREPARE_INPUT);
    if (started.state !== "execution_granted") throw new Error("Expected durable execution grant");

    const renewed = await started.handle.renew();

    expect(renewed).toEqual({ state: "not_renewed", attempt: RENEWAL_ADVANCED, renewal: RENEWAL_REJECTED });
    expect(store.advanceRenewalAfterDurableFailure).toHaveBeenCalledWith({
      contractVersion: STARTED.contractVersion,
      attemptId: STARTED.id,
      resourceKind: STARTED.resourceKind,
      resourceId: STARTED.resourceId,
      capacityFence: STARTED.capacityFence,
      observedRenewOperationId: STARTED.renewOperationId,
    });
    expect(store.recordRenewed).not.toHaveBeenCalled();
    expect(started.handle.attempt).toEqual(RENEWAL_ADVANCED);
  });

  it("serializes concurrent renewals so each later call uses the latest durable operation", async () => {
    let resolveFirstRenewal!: (result: GlobalCapacityLedgerMutationResultV1) => void;
    const firstRenewal = new Promise<GlobalCapacityLedgerMutationResultV1>((resolve) => {
      resolveFirstRenewal = resolve;
    });
    const observedOperationIds: string[] = [];
    const store = createStore({
      recordRenewed: vi.fn()
        .mockResolvedValueOnce(RENEWED)
        .mockResolvedValueOnce(RENEWED_TWICE),
    });
    const ledger = createLedger({
      renew: vi.fn(async (input) => {
        observedOperationIds.push(input.operationId);
        return observedOperationIds.length === 1 ? firstRenewal : RENEWAL_SUCCEEDED;
      }),
    });
    const started = await createRunner(store, ledger).run(PREPARE_INPUT);
    if (started.state !== "execution_granted") throw new Error("Expected durable execution grant");

    const first = started.handle.renew();
    const second = started.handle.renew();
    await Promise.resolve();

    expect(ledger.renew).toHaveBeenCalledTimes(1);
    resolveFirstRenewal(RENEWAL_SUCCEEDED);

    await expect(first).resolves.toEqual({ state: "renewed", attempt: RENEWED, renewal: RENEWAL_SUCCEEDED });
    await expect(second).resolves.toEqual({ state: "renewed", attempt: RENEWED_TWICE, renewal: RENEWAL_SUCCEEDED });
    expect(observedOperationIds).toEqual([STARTED.renewOperationId, RENEWED.renewOperationId]);
  });

  it("waits for a pending renewal before one shared finish releases capacity", async () => {
    let resolveRenewal!: (result: GlobalCapacityLedgerMutationResultV1) => void;
    const pendingRenewal = new Promise<GlobalCapacityLedgerMutationResultV1>((resolve) => {
      resolveRenewal = resolve;
    });
    const events: string[] = [];
    const store = createStore({
      recordRenewed: vi.fn(async () => {
        events.push("record-renewed");
        return RENEWED;
      }),
      recordWorkFinished: vi.fn(async () => {
        events.push("record-work-finished");
        return RENEWED_FINISHED;
      }),
      recordReleased: vi.fn(async () => {
        events.push("record-released");
        return RENEWED_RELEASED;
      }),
    });
    const ledger = createLedger({
      renew: vi.fn(async () => {
        events.push("renew");
        return pendingRenewal;
      }),
      release: vi.fn(async () => {
        events.push("release");
        return RELEASE_SUCCEEDED;
      }),
    });
    const started = await createRunner(store, ledger).run(PREPARE_INPUT);
    if (started.state !== "execution_granted") throw new Error("Expected durable execution grant");

    const renewal = started.handle.renew();
    await Promise.resolve();
    const firstFinish = started.handle.finish();
    const secondFinish = started.handle.finish();

    expect(firstFinish).toBe(secondFinish);
    expect(store.recordWorkFinished).not.toHaveBeenCalled();
    expect(ledger.release).not.toHaveBeenCalled();

    resolveRenewal(RENEWAL_SUCCEEDED);

    await expect(renewal).resolves.toEqual({ state: "renewed", attempt: RENEWED, renewal: RENEWAL_SUCCEEDED });
    await expect(firstFinish).resolves.toEqual({
      state: "released",
      attempt: RENEWED_RELEASED,
      release: RELEASE_SUCCEEDED,
    });
    expect(events).toEqual(["renew", "record-renewed", "record-work-finished", "release", "record-released"]);
    expect(store.recordWorkFinished).toHaveBeenCalledTimes(1);
    expect(ledger.release).toHaveBeenCalledTimes(1);
    expect(store.recordReleased).toHaveBeenCalledTimes(1);
  });

  it("keeps the same renewal operation after unknown transport or unpersisted Core outcome", async () => {
    const observedOperationIds: string[] = [];
    const store = createStore({
      recordRenewed: vi.fn()
        .mockRejectedValueOnce(new Error("Core persistence unavailable"))
        .mockResolvedValueOnce(RENEWED),
    });
    const ledger = createLedger({
      renew: vi.fn(async (input) => {
        observedOperationIds.push(input.operationId);
        if (observedOperationIds.length === 1) throw new Error("transport unknown");
        return RENEWAL_SUCCEEDED;
      }),
    });
    const started = await createRunner(store, ledger).run(PREPARE_INPUT);
    if (started.state !== "execution_granted") throw new Error("Expected durable execution grant");

    await expect(started.handle.renew()).resolves.toEqual({
      state: "unresolved",
      phase: "renew",
      attempt: STARTED,
    });
    await expect(started.handle.renew()).resolves.toEqual({
      state: "unresolved",
      phase: "renew_persistence",
      attempt: STARTED,
      renewal: RENEWAL_SUCCEEDED,
    });
    await expect(started.handle.renew()).resolves.toEqual({
      state: "renewed",
      attempt: RENEWED,
      renewal: RENEWAL_SUCCEEDED,
    });

    expect(observedOperationIds).toEqual([
      STARTED.renewOperationId,
      STARTED.renewOperationId,
      STARTED.renewOperationId,
    ]);
  });

  it("settles work before releasing capacity and records release only after the matching receipt", async () => {
    const events: string[] = [];
    const store = createStore({
      recordWorkFinished: vi.fn(async () => {
        events.push("record-work-finished");
        return FINISHED;
      }),
      recordReleased: vi.fn(async () => {
        events.push("record-released");
        return RELEASED_ATTEMPT;
      }),
    });
    const ledger = createLedger({
      release: vi.fn(async (input) => {
        events.push("release");
        expect(input).toEqual({
          contractVersion: GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION,
          projectId: FINISHED.projectId,
          resourceKind: FINISHED.resourceKind,
          resourceId: FINISHED.resourceId,
          claimId: FINISHED.claimId,
          operationId: FINISHED.releaseOperationId,
          holderId: FINISHED.holderId,
          leaseId: FINISHED.leaseId,
          fence: FINISHED.capacityFence,
          asOf: "2026-07-20T05:20:03.000Z",
        });
        return RELEASE_SUCCEEDED;
      }),
    });
    const started = await createRunner(store, ledger).run(PREPARE_INPUT);
    if (started.state !== "execution_granted") throw new Error("Expected durable execution grant");

    const finished = await started.handle.finish();

    expect(finished).toEqual({ state: "released", attempt: RELEASED_ATTEMPT, release: RELEASE_SUCCEEDED });
    expect(store.recordWorkFinished).toHaveBeenCalledWith({
      contractVersion: STARTED.contractVersion,
      attemptId: STARTED.id,
      resourceKind: STARTED.resourceKind,
      resourceId: STARTED.resourceId,
      capacityFence: STARTED.capacityFence,
      executionReceiptId: "work-start-1",
    });
    expect(store.recordReleased).toHaveBeenCalledWith({
      contractVersion: FINISHED.contractVersion,
      attemptId: FINISHED.id,
      resourceKind: FINISHED.resourceKind,
      resourceId: FINISHED.resourceId,
      capacityFence: FINISHED.capacityFence,
      observedReleaseOperationId: FINISHED.releaseOperationId,
      executionReceiptId: "work-start-1",
    });
    expect(events).toEqual(["record-work-finished", "release", "record-released"]);
    expect(started.handle.attempt).toEqual(RELEASED_ATTEMPT);
  });

  it("returns unresolved cleanup instead of recording a false release", async () => {
    const store = createStore({
      recordWorkFinished: vi.fn(async () => FINISHED),
    });
    const ledger = createLedger({
      release: vi.fn(async () => RELEASE_REJECTED),
    });
    const started = await createRunner(store, ledger).run(PREPARE_INPUT);
    if (started.state !== "execution_granted") throw new Error("Expected durable execution grant");

    const finished = await started.handle.finish();

    expect(finished).toEqual({
      state: "unresolved",
      phase: "release",
      attempt: FINISHED,
      release: RELEASE_REJECTED,
    });
    expect(store.recordReleased).not.toHaveBeenCalled();
    expect(started.handle.attempt).toEqual(FINISHED);
  });

  it("keeps the exact release operation after an unknown release outcome", async () => {
    const observedOperationIds: string[] = [];
    const store = createStore({
      recordWorkFinished: vi.fn(async () => FINISHED),
      recordReleased: vi.fn(async () => RELEASED_ATTEMPT),
    });
    const ledger = createLedger({
      release: vi.fn(async (input) => {
        observedOperationIds.push(input.operationId);
        if (observedOperationIds.length === 1) throw new Error("release transport unknown");
        return RELEASE_SUCCEEDED;
      }),
    });
    const started = await createRunner(store, ledger).run(PREPARE_INPUT);
    if (started.state !== "execution_granted") throw new Error("Expected durable execution grant");

    await expect(started.handle.finish()).resolves.toEqual({
      state: "unresolved",
      phase: "release",
      attempt: FINISHED,
    });
    expect(store.recordReleased).not.toHaveBeenCalled();

    await expect(started.handle.finish()).resolves.toEqual({
      state: "released",
      attempt: RELEASED_ATTEMPT,
      release: RELEASE_SUCCEEDED,
    });
    expect(observedOperationIds).toEqual([FINISHED.releaseOperationId, FINISHED.releaseOperationId]);
  });

  it("does not renew after work has durably settled while release remains unresolved", async () => {
    const store = createStore({
      recordWorkFinished: vi.fn(async () => FINISHED),
    });
    const ledger = createLedger({
      release: vi.fn(async () => RELEASE_REJECTED),
    });
    const started = await createRunner(store, ledger).run(PREPARE_INPUT);
    if (started.state !== "execution_granted") throw new Error("Expected durable execution grant");

    await expect(started.handle.finish()).resolves.toEqual({
      state: "unresolved",
      phase: "release",
      attempt: FINISHED,
      release: RELEASE_REJECTED,
    });
    await expect(started.handle.renew()).resolves.toEqual({
      state: "unresolved",
      phase: "renew",
      attempt: FINISHED,
    });
    expect(ledger.renew).not.toHaveBeenCalled();
  });
});
