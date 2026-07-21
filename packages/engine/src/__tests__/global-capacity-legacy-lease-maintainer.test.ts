import { describe, expect, it, vi } from "vitest";

import {
  GLOBAL_CAPACITY_LEGACY_ATTEMPT_POSTGRES_CONTRACT_VERSION,
  type GlobalCapacityLedgerMutationResultV1,
  type GlobalCapacityLegacyAttemptV1,
} from "@fusion/core";

import type {
  GlobalCapacityLegacyAttemptExecutionHandleV1,
  GlobalCapacityLegacyAttemptRenewalResultV1,
} from "../global-capacity-legacy-attempt-runner.js";
import {
  createGlobalCapacityLegacyLeaseMaintainer,
  type GlobalCapacityLegacyLeaseMaintainerSchedulerV1,
} from "../global-capacity-legacy-lease-maintainer.js";

const STARTED: GlobalCapacityLegacyAttemptV1 = {
  contractVersion: GLOBAL_CAPACITY_LEGACY_ATTEMPT_POSTGRES_CONTRACT_VERSION,
  id: "attempt-1",
  projectId: "project-a",
  resourceKind: "legacy_task",
  resourceId: "FN-100",
  state: "work_started",
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
  expiresAt: "2026-07-20T05:22:00.000Z",
  admittedAt: "2026-07-20T05:20:00.000Z",
  workStartedAt: "2026-07-20T05:20:01.000Z",
  workFinishedAt: null,
  releasedAt: null,
  supersededAt: null,
  updatedAt: "2026-07-20T05:20:01.000Z",
};

const RENEWED: GlobalCapacityLegacyAttemptV1 = {
  ...STARTED,
  renewOperationId: "renew-2",
  renewGeneration: 2,
  lastRenewalOperationId: STARTED.renewOperationId,
  expiresAt: "2026-07-20T05:23:00.000Z",
  updatedAt: "2026-07-20T05:21:00.000Z",
};

const RENEWAL_REJECTED: GlobalCapacityLedgerMutationResultV1 = {
  action: "rejected",
  reason: "stale_fence",
  replayed: false,
  claimId: null,
  fence: null,
};

function renewed(
  attempt: GlobalCapacityLegacyAttemptV1 = RENEWED,
): GlobalCapacityLegacyAttemptRenewalResultV1 {
  return {
    state: "renewed",
    attempt,
    renewal: {
      action: "renewed",
      reason: "capacity_renewed",
      replayed: false,
      claimId: attempt.claimId,
      fence: attempt.capacityFence,
    },
  };
}

function notRenewed(): GlobalCapacityLegacyAttemptRenewalResultV1 {
  return { state: "not_renewed", attempt: STARTED, renewal: RENEWAL_REJECTED };
}

function unresolved(
  phase: "renew" | "renew_persistence",
): GlobalCapacityLegacyAttemptRenewalResultV1 {
  return { state: "unresolved", phase, attempt: STARTED };
}

interface ScheduledRenewal {
  readonly delayMs: number;
  readonly callback: () => void | Promise<void>;
  cancelled: boolean;
}

class ManualScheduler implements GlobalCapacityLegacyLeaseMaintainerSchedulerV1 {
  public readonly scheduled: ScheduledRenewal[] = [];

  public schedule(
    delayMs: number,
    callback: () => void | Promise<void>,
  ): { cancel(): void } {
    const scheduled: ScheduledRenewal = { delayMs, callback, cancelled: false };
    this.scheduled.push(scheduled);
    return {
      cancel(): void {
        scheduled.cancelled = true;
      },
    };
  }

  public async fire(index: number): Promise<void> {
    const scheduled = this.scheduled[index];
    if (!scheduled) throw new Error(`No scheduled renewal at index ${index}`);
    if (!scheduled.cancelled) await scheduled.callback();
  }
}

function createHandle(
  renew: () => Promise<GlobalCapacityLegacyAttemptRenewalResultV1>,
): { readonly handle: GlobalCapacityLegacyAttemptExecutionHandleV1; readonly finishCalls: () => number } {
  let finishCalls = 0;
  return {
    handle: {
      attempt: STARTED,
      executionReceiptId: "work-start-1",
      renew,
      async finish() {
        finishCalls += 1;
        return { state: "unresolved" as const, phase: "release" as const, attempt: STARTED };
      },
    },
    finishCalls: () => finishCalls,
  };
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

describe("GlobalCapacityLegacyLeaseMaintainer", () => {
  it("uses the verified central policy TTL when attempt timestamps span a different interval", async () => {
    const scheduler = new ManualScheduler();
    const renew = vi.fn(async () => renewed());
    const onRenewalFailure = vi.fn();
    const { handle } = createHandle(renew);
    const maintainer = createGlobalCapacityLegacyLeaseMaintainer({
      handle,
      leaseTtlMs: 90_000,
      scheduler,
      onRenewalFailure,
    });

    maintainer.start();
    expect(scheduler.scheduled.map((scheduled) => scheduled.delayMs)).toEqual([45_000]);

    await scheduler.fire(0);

    expect(renew).toHaveBeenCalledTimes(1);
    expect(scheduler.scheduled.map((scheduled) => scheduled.delayMs)).toEqual([45_000, 45_000]);
    expect(onRenewalFailure).not.toHaveBeenCalled();

    await maintainer.settle();
    expect(scheduler.scheduled[1]?.cancelled).toBe(true);
  });

  it("rejects a policy TTL that cannot produce a positive one-shot delay", () => {
    const scheduler = new ManualScheduler();
    const { handle } = createHandle(async () => renewed());

    expect(() => createGlobalCapacityLegacyLeaseMaintainer({
      handle,
      leaseTtlMs: 1,
      scheduler,
      onRenewalFailure: vi.fn(),
    })).toThrow("Global capacity legacy lease TTL must be a safe integer of at least 2 milliseconds");
    expect(scheduler.scheduled).toHaveLength(0);
  });

  it("stops after a durable renewal loss without releasing work and never calls failure twice", async () => {
    const scheduler = new ManualScheduler();
    const renew = vi.fn(async () => notRenewed());
    const onRenewalFailure = vi.fn();
    const { handle, finishCalls } = createHandle(renew);
    const maintainer = createGlobalCapacityLegacyLeaseMaintainer({
      handle,
      leaseTtlMs: 120_000,
      scheduler,
      onRenewalFailure,
    });

    maintainer.start();
    await scheduler.fire(0);
    await scheduler.fire(0);

    expect(renew).toHaveBeenCalledTimes(1);
    expect(onRenewalFailure).toHaveBeenCalledExactlyOnceWith(notRenewed());
    expect(scheduler.scheduled).toHaveLength(1);
    expect(finishCalls()).toBe(0);
  });

  it.each(["renew", "renew_persistence"] as const)(
    "stops and reports the unresolved %s outcome without scheduling another renewal",
    async (phase) => {
      const scheduler = new ManualScheduler();
      const result = unresolved(phase);
      const renew = vi.fn(async () => result);
      const onRenewalFailure = vi.fn();
      const { handle, finishCalls } = createHandle(renew);
      const maintainer = createGlobalCapacityLegacyLeaseMaintainer({
        handle,
        leaseTtlMs: 120_000,
        scheduler,
        onRenewalFailure,
      });

      maintainer.start();
      await scheduler.fire(0);

      expect(renew).toHaveBeenCalledTimes(1);
      expect(onRenewalFailure).toHaveBeenCalledExactlyOnceWith(result);
      expect(scheduler.scheduled).toHaveLength(1);
      expect(finishCalls()).toBe(0);
    },
  );

  it("serializes a timer renewal and makes settle wait for it before a caller can finish", async () => {
    const scheduler = new ManualScheduler();
    const pendingRenewal = deferred<GlobalCapacityLegacyAttemptRenewalResultV1>();
    const renew = vi.fn(() => pendingRenewal.promise);
    const onRenewalFailure = vi.fn();
    const { handle, finishCalls } = createHandle(renew);
    const maintainer = createGlobalCapacityLegacyLeaseMaintainer({
      handle,
      leaseTtlMs: 120_000,
      scheduler,
      onRenewalFailure,
    });

    maintainer.start();
    const firstTimer = scheduler.fire(0);
    await Promise.resolve();
    const duplicateTimer = scheduler.fire(0);
    const settling = maintainer.stop();
    let settled = false;
    void settling.then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(renew).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    pendingRenewal.resolve(renewed());
    await Promise.all([firstTimer, duplicateTimer, settling]);

    expect(scheduler.scheduled).toHaveLength(1);
    expect(onRenewalFailure).not.toHaveBeenCalled();
    expect(finishCalls()).toBe(0);
  });
});
