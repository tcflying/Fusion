import type { GlobalCapacityLegacyAttemptV1 } from "@fusion/core";

import type {
  GlobalCapacityLegacyAttemptExecutionHandleV1,
  GlobalCapacityLegacyAttemptRenewalResultV1,
} from "./global-capacity-legacy-attempt-runner.js";

export const GLOBAL_CAPACITY_LEGACY_LEASE_MAINTAINER_CONTRACT_VERSION = 1 as const;

const SAFE_RENEWAL_FRACTION_DENOMINATOR = 2;

export interface GlobalCapacityLegacyLeaseMaintainerScheduledTaskV1 {
  cancel(): void;
}

/** One-shot scheduler boundary; the maintainer never creates an unbounded interval. */
export interface GlobalCapacityLegacyLeaseMaintainerSchedulerV1 {
  schedule(
    delayMs: number,
    callback: () => void | Promise<void>,
  ): GlobalCapacityLegacyLeaseMaintainerScheduledTaskV1;
}

export type GlobalCapacityLegacyLeaseMaintainerFailureV1 = Extract<
  GlobalCapacityLegacyAttemptRenewalResultV1,
  { readonly state: "not_renewed" | "unresolved" }
>;

export interface CreateGlobalCapacityLegacyLeaseMaintainerInputV1 {
  readonly handle: GlobalCapacityLegacyAttemptExecutionHandleV1;
  /** The verified central policy TTL for this capacity lease, in milliseconds. */
  readonly leaseTtlMs: number;
  readonly scheduler?: GlobalCapacityLegacyLeaseMaintainerSchedulerV1;
  readonly onRenewalFailure: (failure: GlobalCapacityLegacyLeaseMaintainerFailureV1) => void;
}

export interface GlobalCapacityLegacyLeaseMaintainerV1 {
  /** Start one bounded renewal chain. Repeated calls leave the existing timer unchanged. */
  start(): void;
  /** Cancel future renewal ticks and wait for any renewal already in flight. */
  stop(): Promise<void>;
  /** Alias for the external-work settlement boundary before the caller invokes handle.finish(). */
  settle(): Promise<void>;
}

const defaultScheduler: GlobalCapacityLegacyLeaseMaintainerSchedulerV1 = Object.freeze({
  schedule(
    delayMs: number,
    callback: () => void | Promise<void>,
  ): GlobalCapacityLegacyLeaseMaintainerScheduledTaskV1 {
    let active = true;
    const timeout = setTimeout(() => {
      if (!active) return;
      void Promise.resolve(callback()).catch(() => undefined);
    }, delayMs);
    return Object.freeze({
      cancel(): void {
        if (!active) return;
        active = false;
        clearTimeout(timeout);
      },
    });
  },
});

function validatedLeaseTtlMs(value: number): number {
  if (!Number.isSafeInteger(value) || value < SAFE_RENEWAL_FRACTION_DENOMINATOR) {
    throw new TypeError("Global capacity legacy lease TTL must be a safe integer of at least 2 milliseconds");
  }
  return value;
}

function safeRenewalDelayMs(leaseTtlMs: number): number {
  return Math.floor(leaseTtlMs / SAFE_RENEWAL_FRACTION_DENOMINATOR);
}

function unresolvedRenewal(
  attempt: GlobalCapacityLegacyAttemptV1,
  phase: "renew" | "renew_persistence" = "renew",
): GlobalCapacityLegacyLeaseMaintainerFailureV1 {
  return { state: "unresolved", phase, attempt };
}

/*
 * FNXC:GlobalCapacityLegacyLeaseMaintainer 2026-07-20-05:53:
 * GlobalCapacityLegacyAttemptRunner remains timer-free: this engine-only companion owns one
 * cancellable, one-shot scheduler tick and serially renews the execution handle at half of the
 * caller-supplied, verified central-policy leaseTtlMs. Attempt/store/ledger timestamps are not a
 * clock authority for cadence. A renewed result schedules exactly one next tick; not_renewed and either
 * unresolved result terminally stop renewal and notify the failure callback once. Stop/settle
 * cancels future ticks and waits for an already-started renew before the caller may invoke
 * handle.finish(); this maintainer never releases capacity, restarts external work, mutates a
 * task/session/store, or creates a new operation identity.
 */
export function createGlobalCapacityLegacyLeaseMaintainer(
  input: CreateGlobalCapacityLegacyLeaseMaintainerInputV1,
): GlobalCapacityLegacyLeaseMaintainerV1 {
  const scheduler = input.scheduler ?? defaultScheduler;
  const leaseTtlMs = validatedLeaseTtlMs(input.leaseTtlMs);
  let started = false;
  let stopped = false;
  let failureNotified = false;
  let scheduledTask: GlobalCapacityLegacyLeaseMaintainerScheduledTaskV1 | null = null;
  let scheduleGeneration = 0;
  let renewalInFlight: Promise<void> | null = null;
  let settlePromise: Promise<void> | null = null;

  const cancelScheduledTask = (): void => {
    scheduleGeneration += 1;
    const task = scheduledTask;
    scheduledTask = null;
    task?.cancel();
  };

  const notifyFailure = (failure: GlobalCapacityLegacyLeaseMaintainerFailureV1): void => {
    if (failureNotified) return;
    failureNotified = true;
    stopped = true;
    cancelScheduledTask();
    try {
      input.onRenewalFailure(failure);
    } catch {
      // Failure reporting must not reopen scheduling or block a later explicit finish decision.
    }
  };

  const scheduleNext = (attempt: GlobalCapacityLegacyAttemptV1): void => {
    if (stopped) return;
    const delayMs = safeRenewalDelayMs(leaseTtlMs);

    const generation = ++scheduleGeneration;
    try {
      const task = scheduler.schedule(delayMs, async () => {
        if (stopped || generation !== scheduleGeneration || renewalInFlight) return;
        scheduledTask = null;
        await beginRenewal();
      });
      if (!stopped && generation === scheduleGeneration) scheduledTask = task;
      else task.cancel();
    } catch {
      notifyFailure(unresolvedRenewal(attempt));
    }
  };

  const beginRenewal = (): Promise<void> => {
    let renewal: Promise<GlobalCapacityLegacyAttemptRenewalResultV1>;
    try {
      renewal = input.handle.renew();
    } catch {
      notifyFailure(unresolvedRenewal(input.handle.attempt));
      return Promise.resolve();
    }

    const tracked = renewal.then(
      (result) => {
        if (result.state !== "renewed") {
          notifyFailure(result);
          return;
        }
        if (!stopped) scheduleNext(result.attempt);
      },
      () => {
        notifyFailure(unresolvedRenewal(input.handle.attempt));
      },
    );
    renewalInFlight = tracked;
    void tracked.then(() => {
      if (renewalInFlight === tracked) renewalInFlight = null;
    }, () => {
      if (renewalInFlight === tracked) renewalInFlight = null;
    });
    return tracked;
  };

  const stopAndSettle = (): Promise<void> => {
    if (settlePromise) return settlePromise;
    stopped = true;
    cancelScheduledTask();
    const pendingRenewal = renewalInFlight;
    settlePromise = pendingRenewal ? pendingRenewal.then(() => undefined) : Promise.resolve();
    return settlePromise;
  };

  return Object.freeze({
    start(): void {
      if (started || stopped) return;
      started = true;
      scheduleNext(input.handle.attempt);
    },
    stop(): Promise<void> {
      return stopAndSettle();
    },
    settle(): Promise<void> {
      return stopAndSettle();
    },
  });
}
