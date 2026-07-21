import {
  GLOBAL_CAPACITY_LEGACY_ATTEMPT_POSTGRES_CONTRACT_VERSION,
  type GlobalCapacityLegacyAttemptRecoveryInspectionV1,
  type GlobalCapacityLegacyAttemptResourceKindV1,
  type GlobalCapacityLegacyAttemptStoreV1,
  type RunMutationContext,
  type TaskStore,
} from "@fusion/core";

export const GLOBAL_CAPACITY_LEGACY_RECOVERY_GATE_CONTRACT_VERSION = 1 as const;
export const GLOBAL_CAPACITY_LEGACY_RECOVERY_PAUSE_REASON_PREFIX = "global-capacity-recovery:v1:";

export type GlobalCapacityLegacyRecoveryGateInspectionPortV1 = Pick<
  GlobalCapacityLegacyAttemptStoreV1,
  "inspectRecovery"
>;

export type GlobalCapacityLegacyRecoveryGatePausePortV1 = Pick<TaskStore, "pauseTask">;

export interface CreateGlobalCapacityLegacyRecoveryGateInputV1 {
  readonly projectId: string;
  readonly inspection: GlobalCapacityLegacyRecoveryGateInspectionPortV1;
  readonly pause: GlobalCapacityLegacyRecoveryGatePausePortV1;
}

export interface GlobalCapacityLegacyRecoveryGateCheckInputV1 {
  readonly taskId: string;
  readonly resourceKind: GlobalCapacityLegacyAttemptResourceKindV1;
  readonly resourceId: string;
  readonly runContext?: RunMutationContext;
}

export type GlobalCapacityLegacyRecoveryGateReasonV1 =
  | "external_work_may_have_started"
  | "release_pending"
  | "inspection_unavailable"
  | "invalid_identity";

export type GlobalCapacityLegacyRecoveryGateResultV1 =
  | {
      readonly state: "allowed";
      readonly projectId: string;
      readonly resourceKind: GlobalCapacityLegacyAttemptResourceKindV1;
      readonly resourceId: string;
    }
  | {
      readonly state: "blocked";
      readonly projectId: string;
      readonly resourceKind: GlobalCapacityLegacyAttemptResourceKindV1;
      readonly resourceId: string;
      readonly reason: GlobalCapacityLegacyRecoveryGateReasonV1;
      readonly pausedReason: string;
      readonly pausePersisted: boolean;
      readonly inspection?: Exclude<GlobalCapacityLegacyAttemptRecoveryInspectionV1, { state: "clear" }>;
    };

export interface GlobalCapacityLegacyRecoveryGateV1 {
  check(input: GlobalCapacityLegacyRecoveryGateCheckInputV1): Promise<GlobalCapacityLegacyRecoveryGateResultV1>;
}

function canonicalString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function validResourceKind(value: unknown): value is GlobalCapacityLegacyAttemptResourceKindV1 {
  return value === "legacy_task" || value === "legacy_triage";
}

function pauseReasonFor(reason: GlobalCapacityLegacyRecoveryGateReasonV1): string {
  return `${GLOBAL_CAPACITY_LEGACY_RECOVERY_PAUSE_REASON_PREFIX}${reason}`;
}

/**
 * FNXC:GlobalCapacityLegacyRecoveryGate 2026-07-20-05:57:
 * Before an executor or triage path touches a worktree/session, project-local
 * dispatch asks Core whether the newest durable capacity attempt may already
 * have crossed an external-effect boundary. Unknown inspection and every
 * post-boundary state are projected into the existing paused + pausedReason
 * task surface. This gate never retries, releases, or replays a worker: an
 * independent recovery/operator path must resolve the parked attempt first.
 */
export function createGlobalCapacityLegacyRecoveryGate(
  input: CreateGlobalCapacityLegacyRecoveryGateInputV1,
): GlobalCapacityLegacyRecoveryGateV1 {
  if (
    !canonicalString(input.projectId)
    || !input.inspection
    || typeof input.inspection.inspectRecovery !== "function"
    || !input.pause
    || typeof input.pause.pauseTask !== "function"
  ) {
    throw new TypeError("Global capacity legacy recovery gate requires project-scoped inspection and pause ports");
  }

  const block = async (
    check: GlobalCapacityLegacyRecoveryGateCheckInputV1,
    reason: GlobalCapacityLegacyRecoveryGateReasonV1,
    inspection?: Exclude<GlobalCapacityLegacyAttemptRecoveryInspectionV1, { state: "clear" }>,
  ): Promise<Extract<GlobalCapacityLegacyRecoveryGateResultV1, { state: "blocked" }>> => {
    const pausedReason = pauseReasonFor(reason);
    let pausePersisted = false;
    if (canonicalString(check.taskId)) {
      try {
        await input.pause.pauseTask(check.taskId, true, check.runContext, { pausedReason });
        pausePersisted = true;
      } catch {
        // Returning blocked remains mandatory if the visibility projection fails.
      }
    }
    return {
      state: "blocked",
      projectId: input.projectId,
      resourceKind: check.resourceKind,
      resourceId: check.resourceId,
      reason,
      pausedReason,
      pausePersisted,
      ...(inspection ? { inspection } : {}),
    };
  };

  return Object.freeze({
    async check(
      check: GlobalCapacityLegacyRecoveryGateCheckInputV1,
    ): Promise<GlobalCapacityLegacyRecoveryGateResultV1> {
      if (
        !canonicalString(check.taskId)
        || !validResourceKind(check.resourceKind)
        || !canonicalString(check.resourceId)
      ) {
        return block(check, "invalid_identity");
      }

      let inspection: GlobalCapacityLegacyAttemptRecoveryInspectionV1;
      try {
        inspection = await input.inspection.inspectRecovery({
          contractVersion: GLOBAL_CAPACITY_LEGACY_ATTEMPT_POSTGRES_CONTRACT_VERSION,
          resourceKind: check.resourceKind,
          resourceId: check.resourceId,
        });
      } catch {
        return block(check, "inspection_unavailable");
      }
      if (inspection.state === "clear") {
        return {
          state: "allowed",
          projectId: input.projectId,
          resourceKind: check.resourceKind,
          resourceId: check.resourceId,
        };
      }
      return block(check, inspection.reason, inspection);
    },
  });
}
