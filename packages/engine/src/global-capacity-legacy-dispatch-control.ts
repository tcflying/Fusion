import {
  GLOBAL_CAPACITY_LEGACY_ATTEMPT_POSTGRES_CONTRACT_VERSION,
  type GlobalCapacityLegacyAttemptPrepareInputV1,
  type GlobalCapacityLegacyAttemptResourceKindV1,
  type GlobalCapacityWorkClassV1,
} from "@fusion/core";

import {
  type GlobalCapacityLegacyAttemptExecutionHandleV1,
  type GlobalCapacityLegacyAttemptRunResultV1,
  type GlobalCapacityLegacyAttemptRunnerV1,
} from "./global-capacity-legacy-attempt-runner.js";
import {
  createGlobalCapacityLegacyLeaseMaintainer,
  type GlobalCapacityLegacyLeaseMaintainerFailureV1,
  type GlobalCapacityLegacyLeaseMaintainerSchedulerV1,
  type GlobalCapacityLegacyLeaseMaintainerV1,
} from "./global-capacity-legacy-lease-maintainer.js";

export const GLOBAL_CAPACITY_LEGACY_DISPATCH_CONTROL_CONTRACT_VERSION = 1 as const;

export interface CreateGlobalCapacityLegacyDispatchControlInputV1 {
  readonly projectId: string;
  readonly runner: GlobalCapacityLegacyAttemptRunnerV1;
  /** Loaded from CentralCore's verified policy authority; never project settings. */
  readonly leaseTtlMs: number;
  readonly scheduler?: GlobalCapacityLegacyLeaseMaintainerSchedulerV1;
}

export interface GlobalCapacityLegacyDispatchStartInputV1 {
  readonly resourceKind: GlobalCapacityLegacyAttemptResourceKindV1;
  readonly resourceId: string;
  readonly workClass: GlobalCapacityWorkClassV1;
  readonly slots: number;
}

export interface GlobalCapacityLegacyDispatchLeaseInputV1 {
  readonly handle: GlobalCapacityLegacyAttemptExecutionHandleV1;
  readonly onRenewalFailure: (failure: GlobalCapacityLegacyLeaseMaintainerFailureV1) => void;
}

export interface GlobalCapacityLegacyDispatchControlV1 {
  begin(input: GlobalCapacityLegacyDispatchStartInputV1): Promise<GlobalCapacityLegacyAttemptRunResultV1>;
  maintain(input: GlobalCapacityLegacyDispatchLeaseInputV1): GlobalCapacityLegacyLeaseMaintainerV1;
}

function canonicalString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validResourceKind(value: unknown): value is GlobalCapacityLegacyAttemptResourceKindV1 {
  return value === "legacy_task" || value === "legacy_triage";
}

function validWorkClass(value: unknown): value is GlobalCapacityWorkClassV1 {
  return value === "normal" || value === "verifier" || value === "recovery";
}

export function globalCapacityLegacyHolderId(
  projectId: string,
  resourceKind: GlobalCapacityLegacyAttemptResourceKindV1,
  resourceId: string,
): string {
  return `fusion-global-capacity-legacy-v1:${projectId}:${resourceKind}:${resourceId}`;
}

/**
 * FNXC:GlobalCapacityLegacyDispatchControl 2026-07-20-06:00:
 * Executor and triage share one narrow adapter for the durable capacity runner.
 * It makes a stable holder identity from the project/resource boundary, passes
 * only explicit work class/slot values to Core, and injects the verified central
 * policy TTL into the timer-owning maintainer. This layer never supplies a
 * default policy, mutates task/session state, or decides whether a failed lease
 * may be retried; its caller must park/reconcile those outcomes explicitly.
 */
export function createGlobalCapacityLegacyDispatchControl(
  input: CreateGlobalCapacityLegacyDispatchControlInputV1,
): GlobalCapacityLegacyDispatchControlV1 {
  if (
    !canonicalString(input.projectId)
    || !input.runner
    || typeof input.runner.run !== "function"
    || !positiveSafeInteger(input.leaseTtlMs)
  ) {
    throw new TypeError("Global capacity legacy dispatch control requires a verified project runner and lease TTL");
  }

  return Object.freeze({
    async begin(start: GlobalCapacityLegacyDispatchStartInputV1): Promise<GlobalCapacityLegacyAttemptRunResultV1> {
      if (
        !validResourceKind(start.resourceKind)
        || !canonicalString(start.resourceId)
        || !validWorkClass(start.workClass)
        || !positiveSafeInteger(start.slots)
      ) {
        return { state: "rejected", reason: "invalid_input" };
      }
      const prepare: GlobalCapacityLegacyAttemptPrepareInputV1 = {
        contractVersion: GLOBAL_CAPACITY_LEGACY_ATTEMPT_POSTGRES_CONTRACT_VERSION,
        resourceKind: start.resourceKind,
        resourceId: start.resourceId,
        workClass: start.workClass,
        slots: start.slots,
        holderId: globalCapacityLegacyHolderId(input.projectId, start.resourceKind, start.resourceId),
      };
      return input.runner.run(prepare);
    },
    maintain(lease: GlobalCapacityLegacyDispatchLeaseInputV1): GlobalCapacityLegacyLeaseMaintainerV1 {
      return createGlobalCapacityLegacyLeaseMaintainer({
        handle: lease.handle,
        leaseTtlMs: input.leaseTtlMs,
        scheduler: input.scheduler,
        onRenewalFailure: lease.onRenewalFailure,
      });
    },
  });
}
