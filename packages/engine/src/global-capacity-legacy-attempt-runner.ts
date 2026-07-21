import {
  GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION,
  type GlobalCapacityLedgerMutationResultV1,
  type GlobalCapacityLedgerPolicyV1,
  type GlobalCapacityLedgerPostgresPortsV1,
  type GlobalCapacityLegacyAttemptPrepareInputV1,
  type GlobalCapacityLegacyAttemptReferenceV1,
  type GlobalCapacityLegacyAttemptStoreV1,
  type GlobalCapacityLegacyAttemptV1,
} from "@fusion/core";

export const GLOBAL_CAPACITY_LEGACY_ATTEMPT_RUNNER_CONTRACT_VERSION = 1 as const;

export interface GlobalCapacityLegacyAttemptRunnerInputV1 {
  readonly projectId: string;
  readonly store: GlobalCapacityLegacyAttemptStoreV1;
  readonly ledger: GlobalCapacityLedgerPostgresPortsV1;
  readonly policy: GlobalCapacityLedgerPolicyV1;
  /** Host-owned clock used only for explicit caller-triggered renewals. */
  readonly now: () => string;
}

export interface GlobalCapacityLegacyAttemptExecutionHandleV1 {
  readonly attempt: GlobalCapacityLegacyAttemptV1;
  readonly executionReceiptId: string;
  renew(): Promise<GlobalCapacityLegacyAttemptRenewalResultV1>;
  /** Invoke only after the caller has settled the external work represented by this receipt. */
  finish(): Promise<GlobalCapacityLegacyAttemptFinishResultV1>;
}

export type GlobalCapacityLegacyAttemptRenewalResultV1 =
  | {
      readonly state: "renewed";
      readonly attempt: GlobalCapacityLegacyAttemptV1;
      readonly renewal: GlobalCapacityLedgerMutationResultV1;
    }
  | {
      readonly state: "not_renewed";
      readonly attempt: GlobalCapacityLegacyAttemptV1;
      readonly renewal: GlobalCapacityLedgerMutationResultV1;
    }
  | {
      readonly state: "unresolved";
      readonly phase: "renew" | "renew_persistence";
      readonly attempt: GlobalCapacityLegacyAttemptV1;
      readonly renewal?: GlobalCapacityLedgerMutationResultV1;
    };

export type GlobalCapacityLegacyAttemptFinishResultV1 =
  | {
      readonly state: "released";
      readonly attempt: GlobalCapacityLegacyAttemptV1;
      readonly release: GlobalCapacityLedgerMutationResultV1;
    }
  | {
      readonly state: "unresolved";
      readonly phase: "work_settlement" | "release" | "release_persistence";
      readonly attempt: GlobalCapacityLegacyAttemptV1;
      readonly release?: GlobalCapacityLedgerMutationResultV1;
    };

export type GlobalCapacityLegacyAttemptRunResultV1 =
  | {
      readonly state: "execution_granted";
      readonly attempt: GlobalCapacityLegacyAttemptV1;
      readonly executionReceiptId: string;
      readonly admission: GlobalCapacityLedgerMutationResultV1;
      readonly handle: GlobalCapacityLegacyAttemptExecutionHandleV1;
    }
  | {
      readonly state: "withheld";
      readonly reason: "active_attempt_conflict" | "ledger_held";
      readonly attempt: GlobalCapacityLegacyAttemptV1;
      readonly admission?: GlobalCapacityLedgerMutationResultV1;
    }
  | {
      readonly state: "rejected";
      readonly reason: "invalid_input" | "admission_mismatch" | GlobalCapacityLedgerMutationResultV1["reason"];
      readonly attempt?: GlobalCapacityLegacyAttemptV1;
      readonly admission?: GlobalCapacityLedgerMutationResultV1;
    }
  | {
      readonly state: "recovery_required";
      readonly attempt: GlobalCapacityLegacyAttemptV1;
      readonly admission?: GlobalCapacityLedgerMutationResultV1;
    }
  | {
      readonly state: "unresolved";
      readonly phase: "prepare" | "acquire" | "withheld_persistence" | "admission" | "work_start";
      readonly attempt?: GlobalCapacityLegacyAttemptV1;
      readonly admission?: GlobalCapacityLedgerMutationResultV1;
    };

export interface GlobalCapacityLegacyAttemptRunnerV1 {
  run(input: GlobalCapacityLegacyAttemptPrepareInputV1): Promise<GlobalCapacityLegacyAttemptRunResultV1>;
}

function referenceOf(attempt: GlobalCapacityLegacyAttemptV1): GlobalCapacityLegacyAttemptReferenceV1 {
  return {
    contractVersion: attempt.contractVersion,
    attemptId: attempt.id,
    resourceKind: attempt.resourceKind,
    resourceId: attempt.resourceId,
    capacityFence: attempt.capacityFence,
  };
}

function exactAcquired(
  result: GlobalCapacityLedgerMutationResultV1,
  attempt: GlobalCapacityLegacyAttemptV1,
): boolean {
  return result.action === "acquired"
    && result.claimId === attempt.claimId
    && result.fence === attempt.capacityFence;
}

function canonicalTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value && Number.isFinite(Date.parse(value));
}

function renewalExpiry(asOf: string, leaseTtlMs: number): string | null {
  if (!canonicalTimestamp(asOf) || !Number.isSafeInteger(leaseTtlMs) || leaseTtlMs <= 0) return null;
  const expiresAt = new Date(Date.parse(asOf) + leaseTtlMs).toISOString();
  return canonicalTimestamp(expiresAt) ? expiresAt : null;
}

function exactRenewed(
  result: GlobalCapacityLedgerMutationResultV1,
  attempt: GlobalCapacityLegacyAttemptV1,
): boolean {
  return result.action === "renewed"
    && result.claimId === attempt.claimId
    && result.fence === attempt.capacityFence;
}

function exactReleased(
  result: GlobalCapacityLedgerMutationResultV1,
  attempt: GlobalCapacityLegacyAttemptV1,
): boolean {
  return result.action === "released"
    && result.claimId === attempt.claimId
    && result.fence === attempt.capacityFence;
}

function createExecutionHandle(
  input: GlobalCapacityLegacyAttemptRunnerInputV1,
  initialAttempt: GlobalCapacityLegacyAttemptV1,
  executionReceiptId: string,
): GlobalCapacityLegacyAttemptExecutionHandleV1 {
  let attempt = initialAttempt;
  let finishedResult: Extract<GlobalCapacityLegacyAttemptFinishResultV1, { state: "released" }> | null = null;
  let finishInFlight: Promise<GlobalCapacityLegacyAttemptFinishResultV1> | null = null;
  let renewalTail: Promise<void> = Promise.resolve();

  const renewOnce = async (): Promise<GlobalCapacityLegacyAttemptRenewalResultV1> => {
    if (attempt.state !== "admitted" && attempt.state !== "work_started") {
      return { state: "unresolved", phase: "renew", attempt };
    }
    let asOf: string;
    try {
      asOf = input.now();
    } catch {
      return { state: "unresolved", phase: "renew", attempt };
    }
    const expiresAt = renewalExpiry(asOf, input.policy.leaseTtlMs);
    if (!expiresAt) return { state: "unresolved", phase: "renew", attempt };

    let renewal: GlobalCapacityLedgerMutationResultV1;
    try {
      renewal = await input.ledger.renew({
        contractVersion: GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION,
        projectId: attempt.projectId,
        resourceKind: attempt.resourceKind,
        resourceId: attempt.resourceId,
        claimId: attempt.claimId,
        operationId: attempt.renewOperationId,
        holderId: attempt.holderId,
        leaseId: attempt.leaseId,
        fence: attempt.capacityFence,
        asOf,
        expiresAt,
      });
    } catch {
      return { state: "unresolved", phase: "renew", attempt };
    }

    if (exactRenewed(renewal, attempt)) {
      try {
        attempt = await input.store.recordRenewed({
          ...referenceOf(attempt),
          observedRenewOperationId: attempt.renewOperationId,
        });
      } catch {
        return { state: "unresolved", phase: "renew_persistence", attempt, renewal };
      }
      return { state: "renewed", attempt, renewal };
    }

    try {
      attempt = await input.store.advanceRenewalAfterDurableFailure({
        ...referenceOf(attempt),
        observedRenewOperationId: attempt.renewOperationId,
      });
    } catch {
      return { state: "unresolved", phase: "renew_persistence", attempt, renewal };
    }
    return { state: "not_renewed", attempt, renewal };
  };

  /*
   * FNXC:GlobalCapacityLegacyAttemptRunner 2026-07-20-05:40:
   * Renew and finish both mutate the same durable capacity attempt. Queue an
   * explicit finish after prior renewals and share its in-flight promise so a
   * settled worker cannot race a late renewal into an ambiguous release.
   */
  const finishOnce = async (): Promise<GlobalCapacityLegacyAttemptFinishResultV1> => {
    if (finishedResult) return finishedResult;

    try {
      attempt = await input.store.recordWorkFinished({
        ...referenceOf(attempt),
        executionReceiptId,
      });
    } catch {
      return { state: "unresolved", phase: "work_settlement", attempt };
    }

    let asOf: string;
    try {
      asOf = input.now();
    } catch {
      return { state: "unresolved", phase: "release", attempt };
    }
    if (!canonicalTimestamp(asOf)) return { state: "unresolved", phase: "release", attempt };

    let release: GlobalCapacityLedgerMutationResultV1;
    try {
      release = await input.ledger.release({
        contractVersion: GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION,
        projectId: attempt.projectId,
        resourceKind: attempt.resourceKind,
        resourceId: attempt.resourceId,
        claimId: attempt.claimId,
        operationId: attempt.releaseOperationId,
        holderId: attempt.holderId,
        leaseId: attempt.leaseId,
        fence: attempt.capacityFence,
        asOf,
      });
    } catch {
      return { state: "unresolved", phase: "release", attempt };
    }

    if (!exactReleased(release, attempt)) {
      return { state: "unresolved", phase: "release", attempt, release };
    }

    try {
      attempt = await input.store.recordReleased({
        ...referenceOf(attempt),
        observedReleaseOperationId: attempt.releaseOperationId,
        executionReceiptId,
      });
    } catch {
      return { state: "unresolved", phase: "release_persistence", attempt, release };
    }
    finishedResult = { state: "released", attempt, release };
    return finishedResult;
  };

  return Object.freeze({
    get attempt(): GlobalCapacityLegacyAttemptV1 {
      return attempt;
    },
    executionReceiptId,
    renew(): Promise<GlobalCapacityLegacyAttemptRenewalResultV1> {
      const queued = renewalTail.then(renewOnce);
      renewalTail = queued.then(
        () => undefined,
        () => undefined,
      );
      return queued;
    },
    finish(): Promise<GlobalCapacityLegacyAttemptFinishResultV1> {
      if (finishInFlight) return finishInFlight;
      if (finishedResult) return Promise.resolve(finishedResult);

      const finishRun = renewalTail.then(finishOnce);
      const sharedFinish = finishRun.then(
        (result) => {
          if (result.state !== "released") finishInFlight = null;
          return result;
        },
        (error: unknown) => {
          finishInFlight = null;
          throw error;
        },
      );
      finishInFlight = sharedFinish;
      renewalTail = sharedFinish.then(
        () => undefined,
        () => undefined,
      );
      return sharedFinish;
    },
  });
}

/**
 * FNXC:GlobalCapacityLegacyAttemptRunner 2026-07-20-05:20:
 * A ledger acquire reply alone cannot authorize an external executor or triage
 * side effect: a crash between the reply and durable state could duplicate work.
 * Expose a grant only after Core records both admission and work start; this
 * engine-only helper owns neither task/session mutation nor a background timer.
 */
export function createGlobalCapacityLegacyAttemptRunner(
  input: GlobalCapacityLegacyAttemptRunnerInputV1,
): GlobalCapacityLegacyAttemptRunnerV1 {
  return Object.freeze({
    async run(
      prepareInput: GlobalCapacityLegacyAttemptPrepareInputV1,
    ): Promise<GlobalCapacityLegacyAttemptRunResultV1> {
      let attempt: GlobalCapacityLegacyAttemptV1;
      try {
        const prepared = await input.store.prepare(prepareInput);
        if (prepared.outcome === "blocked") {
          return {
            state: "withheld",
            reason: "active_attempt_conflict",
            attempt: prepared.attempt,
          };
        }
        if (prepared.outcome === "recovery_required") {
          return { state: "recovery_required", attempt: prepared.attempt };
        }
        attempt = prepared.attempt;
      } catch {
        return { state: "unresolved", phase: "prepare" };
      }

      if (attempt.projectId !== input.projectId) {
        return { state: "rejected", reason: "admission_mismatch", attempt };
      }

      let admission: GlobalCapacityLedgerMutationResultV1;
      try {
        admission = await input.ledger.acquire({
          contractVersion: GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION,
          projectId: attempt.projectId,
          resourceKind: attempt.resourceKind,
          resourceId: attempt.resourceId,
          claimId: attempt.claimId,
          operationId: attempt.acquireOperationId,
          workClass: attempt.workClass,
          slots: attempt.slots,
          holderId: attempt.holderId,
          leaseId: attempt.leaseId,
          fence: attempt.capacityFence,
          asOf: attempt.preparedAt,
          expiresAt: attempt.expiresAt,
        });
      } catch {
        return { state: "unresolved", phase: "acquire", attempt };
      }

      if (admission.action === "held") {
        try {
          const withheld = await input.store.recordWithheld({
            ...referenceOf(attempt),
            observedAcquireOperationId: attempt.acquireOperationId,
          });
          return {
            state: "withheld",
            reason: "ledger_held",
            attempt: withheld,
            admission,
          };
        } catch {
          return { state: "unresolved", phase: "withheld_persistence", attempt, admission };
        }
      }

      if (!exactAcquired(admission, attempt)) {
        return {
          state: "rejected",
          reason: admission.action === "acquired" ? "admission_mismatch" : admission.reason,
          attempt,
          admission,
        };
      }

      let admitted: GlobalCapacityLegacyAttemptV1;
      try {
        admitted = await input.store.recordAdmission({
          ...referenceOf(attempt),
          observedAcquireOperationId: attempt.acquireOperationId,
        });
      } catch {
        return { state: "unresolved", phase: "admission", attempt, admission };
      }

      try {
        const workStart = await input.store.recordWorkStarted(referenceOf(admitted));
        if (workStart.outcome === "recovery_required") {
          return { state: "recovery_required", attempt: workStart.attempt, admission };
        }
        return {
          state: "execution_granted",
          attempt: workStart.attempt,
          executionReceiptId: workStart.executionReceiptId,
          admission,
          handle: createExecutionHandle(input, workStart.attempt, workStart.executionReceiptId),
        };
      } catch {
        return { state: "unresolved", phase: "work_start", attempt: admitted, admission };
      }
    },
  });
}
