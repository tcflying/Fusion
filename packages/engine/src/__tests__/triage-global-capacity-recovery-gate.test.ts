import type { Task, TaskStore } from "@fusion/core";
import { describe, expect, it, vi } from "vitest";

import type { GlobalCapacityLegacyRecoveryGateV1 } from "../global-capacity-legacy-recovery-gate.js";
import type { GlobalCapacityLegacyDispatchControlV1 } from "../global-capacity-legacy-dispatch-control.js";
import { TriageProcessor } from "../triage.js";

const task = {
  id: "task-capacity-recovery-triage",
  title: "Capacity recovery triage test",
  description: "must not recreate a planner session after a durable recovery hold",
  column: "triage",
  dependencies: [],
} as Task;

type TriageGlobalCapacityInternals = {
  runWithGlobalCapacity(task: Task, work: () => Promise<string>): Promise<string | undefined>;
  pauseForGlobalCapacityReconciliation(
    taskId: string,
    reason: string,
  ): Promise<{ readonly state: "persisted" | "persistence_failed" }>;
};

function capacityInternals(processor: TriageProcessor): TriageGlobalCapacityInternals {
  return processor as unknown as TriageGlobalCapacityInternals;
}

function blockedGate(): GlobalCapacityLegacyRecoveryGateV1 {
  return {
    check: vi.fn(async () => ({
      state: "blocked" as const,
      projectId: "project-capacity-recovery",
      resourceKind: "legacy_triage" as const,
      resourceId: task.id,
      reason: "release_pending" as const,
      pausedReason: "global-capacity-recovery:v1:release_pending",
      pausePersisted: true,
    })),
  };
}

describe("TriageProcessor global capacity recovery gate", () => {
  it("stops direct specification before processing, planning status, or a model session", async () => {
    const store = {
      on: vi.fn(),
      getTask: vi.fn(),
      updateTask: vi.fn(),
    } as unknown as TaskStore;
    const gate = blockedGate();
    const onSpecifyStart = vi.fn();
    const processor = new TriageProcessor(store, process.cwd(), {
      globalCapacityLegacyRecoveryGate: gate,
      onSpecifyStart,
    });

    await processor.specifyTask(task);

    expect(gate.check).toHaveBeenCalledWith({
      taskId: task.id,
      resourceKind: "legacy_triage",
      resourceId: task.id,
    });
    expect(onSpecifyStart).not.toHaveBeenCalled();
    expect(store.getTask).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalled();
  });

  it("keeps the recovery gate optional for existing constructor callers", () => {
    const store = { on: vi.fn() } as unknown as TaskStore;
    expect(() => new TriageProcessor(store, process.cwd())).not.toThrow();
  });

  it("withholds a normal capacity hold without replacing a concurrent paused/userPaused projection", async () => {
    const concurrentlyPausedTask = {
      ...task,
      paused: true,
      userPaused: true,
      pausedReason: "operator-pause",
    } as Task;
    const store = {
      on: vi.fn(),
      getTask: vi.fn(async () => concurrentlyPausedTask),
      getSettings: vi.fn(async () => ({})),
      logEntry: vi.fn(async () => undefined),
      updateTask: vi.fn(async () => undefined),
      pauseTask: vi.fn(async () => undefined),
      moveTask: vi.fn(async () => undefined),
    } as unknown as TaskStore;
    const control = {
      begin: vi.fn(async () => ({
        state: "withheld" as const,
        reason: "ledger_held" as const,
        attempt: { expiresAt: "2026-07-20T00:05:00.000Z" },
      })),
      maintain: vi.fn(),
    } as unknown as GlobalCapacityLegacyDispatchControlV1;
    const onSpecifyStart = vi.fn();
    const processor = new TriageProcessor(store, process.cwd(), {
      globalCapacityLegacyDispatchControl: control,
      onSpecifyStart,
    });

    await processor.specifyTask(task);

    expect(onSpecifyStart).toHaveBeenCalledWith(task);
    expect(control.begin).toHaveBeenCalledWith({
      resourceKind: "legacy_triage",
      resourceId: task.id,
      workClass: "normal",
      slots: 1,
    });
    expect(control.maintain).not.toHaveBeenCalled();
    expect(store.updateTask).toHaveBeenCalledWith(task.id, {
      nextRecoveryAt: "2026-07-20T00:05:00.000Z",
    });
    expect(store.pauseTask).not.toHaveBeenCalled();
    expect(store.moveTask).not.toHaveBeenCalled();
    expect(concurrentlyPausedTask).toMatchObject({
      paused: true,
      userPaused: true,
      pausedReason: "operator-pause",
    });
    expect(store.logEntry).toHaveBeenCalledWith(
      task.id,
      expect.stringContaining("Global capacity withheld"),
    );
  });

  it("uses one durable pause projection for duplicate reconciliation signals on an active task", async () => {
    const pauseTask = vi.fn(async () => task);
    const store = {
      on: vi.fn(),
      pauseTask,
    } as unknown as TaskStore;
    const processor = new TriageProcessor(store, process.cwd());
    const internals = capacityInternals(processor);

    const first = internals.pauseForGlobalCapacityReconciliation(task.id, "renewal-lost");
    const duplicate = internals.pauseForGlobalCapacityReconciliation(task.id, "release_pending");

    expect(duplicate).toBe(first);
    await expect(first).resolves.toEqual({ state: "persisted" });
    expect(pauseTask).toHaveBeenCalledTimes(1);
    expect(pauseTask).toHaveBeenCalledWith(task.id, true, undefined, {
      pausedReason: "global-capacity-recovery:v1:renewal-lost",
    });
  });

  it("retains the work-start receipt when the renewal pause cannot be durably projected", async () => {
    const pauseTask = vi.fn(async () => {
      throw new Error("storage unavailable");
    });
    const finish = vi.fn(async () => ({ state: "released" as const }));
    const maintainer = {
      start: vi.fn(),
      settle: vi.fn(async () => undefined),
    };
    const control = {
      begin: vi.fn(async () => ({
        state: "execution_granted" as const,
        attempt: {},
        executionReceiptId: "receipt-capacity-triage",
        admission: {},
        handle: { finish },
      })),
      maintain: vi.fn((input: {
        onRenewalFailure: (failure: { state: "not_renewed" }) => void;
      }) => {
        input.onRenewalFailure({ state: "not_renewed" });
        return maintainer;
      }),
    } as unknown as GlobalCapacityLegacyDispatchControlV1;
    const store = {
      on: vi.fn(),
      pauseTask,
    } as unknown as TaskStore;
    const processor = new TriageProcessor(store, process.cwd(), {
      globalCapacityLegacyDispatchControl: control,
    });
    const work = vi.fn(async () => "planner-finished");

    await expect(capacityInternals(processor).runWithGlobalCapacity(task, work)).resolves.toBeUndefined();

    expect(work).not.toHaveBeenCalled();
    expect(pauseTask).toHaveBeenCalledWith(task.id, true, undefined, {
      pausedReason: "global-capacity-recovery:v1:renewal-lost",
    });
    expect(maintainer.start).toHaveBeenCalledTimes(1);
    expect(maintainer.settle).toHaveBeenCalledTimes(1);
    expect(finish).not.toHaveBeenCalled();
  });
});
