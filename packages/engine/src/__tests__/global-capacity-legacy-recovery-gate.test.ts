import type {
  GlobalCapacityLegacyAttemptRecoveryInspectionV1,
  GlobalCapacityLegacyAttemptStoreV1,
  TaskStore,
} from "@fusion/core";
import { describe, expect, it, vi } from "vitest";

import {
  GLOBAL_CAPACITY_LEGACY_RECOVERY_PAUSE_REASON_PREFIX,
  createGlobalCapacityLegacyRecoveryGate,
} from "../global-capacity-legacy-recovery-gate.js";

const taskId = "task-recovery-gate-1";
const projectId = "project-recovery-gate";

function inspection(
  result: GlobalCapacityLegacyAttemptRecoveryInspectionV1 | Error,
): Pick<GlobalCapacityLegacyAttemptStoreV1, "inspectRecovery"> {
  return {
    inspectRecovery: vi.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
  };
}

function pausePort(): Pick<TaskStore, "pauseTask"> & { readonly pauseTask: ReturnType<typeof vi.fn> } {
  return { pauseTask: vi.fn(async () => ({ id: taskId })) } as unknown as Pick<TaskStore, "pauseTask"> & { readonly pauseTask: ReturnType<typeof vi.fn> };
}

function checkInput() {
  return { taskId, resourceKind: "legacy_task" as const, resourceId: taskId };
}

describe("global capacity legacy recovery gate", () => {
  it("allows a clear durable resource without pausing", async () => {
    const pause = pausePort();
    const gate = createGlobalCapacityLegacyRecoveryGate({
      projectId,
      inspection: inspection({ state: "clear" }),
      pause,
    });

    await expect(gate.check(checkInput())).resolves.toMatchObject({ state: "allowed", projectId });
    expect(pause.pauseTask).not.toHaveBeenCalled();
  });

  it("parks work_started before any external dispatch can resume", async () => {
    const pause = pausePort();
    const release = vi.fn();
    const gate = createGlobalCapacityLegacyRecoveryGate({
      projectId,
      inspection: Object.assign(inspection({
        state: "reconciliation_required",
        reason: "external_work_may_have_started",
        attempt: { id: "attempt-1", state: "work_started" },
      } as GlobalCapacityLegacyAttemptRecoveryInspectionV1), { release }),
      pause,
    });

    await expect(gate.check(checkInput())).resolves.toMatchObject({
      state: "blocked",
      reason: "external_work_may_have_started",
      pausePersisted: true,
      pausedReason: `${GLOBAL_CAPACITY_LEGACY_RECOVERY_PAUSE_REASON_PREFIX}external_work_may_have_started`,
    });
    expect(pause.pauseTask).toHaveBeenCalledWith(
      taskId,
      true,
      undefined,
      { pausedReason: `${GLOBAL_CAPACITY_LEGACY_RECOVERY_PAUSE_REASON_PREFIX}external_work_may_have_started` },
    );
    expect(release).not.toHaveBeenCalled();
  });

  it("parks a durable release_pending attempt without replaying release", async () => {
    const pause = pausePort();
    const gate = createGlobalCapacityLegacyRecoveryGate({
      projectId,
      inspection: inspection({
        state: "reconciliation_required",
        reason: "release_pending",
        attempt: { id: "attempt-2", state: "work_finished" },
      } as GlobalCapacityLegacyAttemptRecoveryInspectionV1),
      pause,
    });

    await expect(gate.check(checkInput())).resolves.toMatchObject({
      state: "blocked",
      reason: "release_pending",
      pausedReason: `${GLOBAL_CAPACITY_LEGACY_RECOVERY_PAUSE_REASON_PREFIX}release_pending`,
    });
    expect(pause.pauseTask).toHaveBeenCalledTimes(1);
  });

  it("fails closed and parks when durable inspection is unavailable", async () => {
    const pause = pausePort();
    const gate = createGlobalCapacityLegacyRecoveryGate({
      projectId,
      inspection: inspection(new Error("database unavailable")),
      pause,
    });

    await expect(gate.check(checkInput())).resolves.toMatchObject({
      state: "blocked",
      reason: "inspection_unavailable",
      pausePersisted: true,
    });
    expect(pause.pauseTask).toHaveBeenCalledTimes(1);
  });

  it("fails closed on malformed identity without inspecting or releasing", async () => {
    const pause = pausePort();
    const inspect = inspection({ state: "clear" });
    const gate = createGlobalCapacityLegacyRecoveryGate({ projectId, inspection: inspect, pause });

    await expect(gate.check({ ...checkInput(), resourceId: "" })).resolves.toMatchObject({
      state: "blocked",
      reason: "invalid_identity",
    });
    expect(inspect.inspectRecovery).not.toHaveBeenCalled();
    expect(pause.pauseTask).toHaveBeenCalledTimes(1);
  });
});
