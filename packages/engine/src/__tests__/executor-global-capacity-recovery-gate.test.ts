import "./executor-test-helpers.js";
import type { Task, TaskStore } from "@fusion/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TaskExecutor } from "../executor.js";
import type { GlobalCapacityLegacyDispatchControlV1 } from "../global-capacity-legacy-dispatch-control.js";
import type { GlobalCapacityLegacyRecoveryGateV1 } from "../global-capacity-legacy-recovery-gate.js";
import * as worktreeAcquisition from "../worktree-acquisition.js";
import * as worktreePool from "../worktree-pool.js";
import { createMockStore, resetExecutorMocks } from "./executor-test-helpers.js";

const task = {
  id: "task-capacity-recovery-executor",
  title: "Capacity recovery executor test",
  description: "must not dispatch after a durable recovery hold",
  column: "todo",
  dependencies: [],
} as Task;

function blockedGate(): GlobalCapacityLegacyRecoveryGateV1 {
  return {
    check: vi.fn(async () => ({
      state: "blocked" as const,
      projectId: "project-capacity-recovery",
      resourceKind: "legacy_task" as const,
      resourceId: task.id,
      reason: "external_work_may_have_started" as const,
      pausedReason: "global-capacity-recovery:v1:external_work_may_have_started",
      pausePersisted: true,
    })),
  };
}

describe("TaskExecutor global capacity recovery gate", () => {
  beforeEach(() => {
    resetExecutorMocks();
  });

  it("stops direct execution before graph, authoritative, or work-engine routing", async () => {
    const store = { on: vi.fn() } as unknown as TaskStore;
    const gate = blockedGate();
    const authoritative = vi.fn(async () => false);
    const executor = new TaskExecutor(store, process.cwd(), {
      globalCapacityLegacyRecoveryGate: gate,
      workflowAuthoritativeDispatch: authoritative,
    });

    await executor.execute(task);

    expect(gate.check).toHaveBeenCalledWith({
      taskId: task.id,
      resourceKind: "legacy_task",
      resourceId: task.id,
    });
    expect(authoritative).not.toHaveBeenCalled();
  });

  it("keeps the recovery gate optional for existing constructor callers", () => {
    const store = { on: vi.fn() } as unknown as TaskStore;
    expect(() => new TaskExecutor(store, process.cwd())).not.toThrow();
  });

  it("returns a normal capacity hold to todo before a worktree or agent session starts", async () => {
    const capacityTask = {
      ...task,
      column: "in-progress",
      createdAt: "2026-07-20T00:00:00.000Z",
      updatedAt: "2026-07-20T00:00:00.000Z",
      steps: [],
      currentStep: 0,
      log: [],
    } as Task;
    const store = createMockStore();
    store.getTask.mockResolvedValue(capacityTask);
    vi.spyOn(worktreePool, "detectGitRepository").mockResolvedValue({ status: "repo" });
    const acquire = vi.spyOn(worktreeAcquisition, "acquireTaskWorktree");
    const control = {
      begin: vi.fn(async () => ({
        state: "withheld" as const,
        reason: "ledger_held" as const,
        attempt: { expiresAt: "2026-07-20T00:05:00.000Z" },
      })),
      maintain: vi.fn(),
    } as unknown as GlobalCapacityLegacyDispatchControlV1;
    const executor = new TaskExecutor(store, process.cwd(), {
      globalCapacityLegacyDispatchControl: control,
    });

    await executor.execute(capacityTask);

    expect(control.begin).toHaveBeenCalledWith({
      resourceKind: "legacy_task",
      resourceId: capacityTask.id,
      workClass: "normal",
      slots: 1,
    });
    expect(control.maintain).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
    expect(store.updateTask).toHaveBeenCalledWith(
      capacityTask.id,
      expect.objectContaining({ nextRecoveryAt: "2026-07-20T00:05:00.000Z" }),
      expect.anything(),
    );
    expect(store.moveTask).toHaveBeenCalledWith(
      capacityTask.id,
      "todo",
      expect.objectContaining({
        preserveProgress: true,
        preserveResumeState: true,
        preserveWorktree: true,
        preservePause: true,
        moveSource: "engine",
      }),
    );
  });

  it("does not overwrite a concurrent user/system pause while recording a normal capacity hold", async () => {
    const capacityTask = {
      ...task,
      column: "in-progress",
      createdAt: "2026-07-20T00:00:00.000Z",
      updatedAt: "2026-07-20T00:00:00.000Z",
      steps: [],
      currentStep: 0,
      log: [],
    } as Task;
    const store = createMockStore();
    store.getTask.mockResolvedValue({ ...capacityTask, paused: true, pausedReason: "operator-hold" });
    vi.spyOn(worktreePool, "detectGitRepository").mockResolvedValue({ status: "repo" });
    const control = {
      begin: vi.fn(async () => ({
        state: "withheld" as const,
        reason: "ledger_held" as const,
        attempt: {},
      })),
      maintain: vi.fn(),
    } as unknown as GlobalCapacityLegacyDispatchControlV1;
    const executor = new TaskExecutor(store, process.cwd(), {
      globalCapacityLegacyDispatchControl: control,
    });

    await executor.execute(capacityTask);

    expect(store.moveTask).not.toHaveBeenCalled();
    expect(worktreeAcquisition.acquireTaskWorktree).not.toHaveBeenCalled();
    expect(store.logEntry).toHaveBeenCalledWith(
      capacityTask.id,
      expect.stringContaining("concurrent pause"),
      undefined,
      expect.anything(),
    );
  });

  it("keeps a work-started receipt unreleased when a renewal pause cannot be durably projected", async () => {
    const capacityTask = {
      ...task,
      column: "in-progress",
      createdAt: "2026-07-20T00:00:00.000Z",
      updatedAt: "2026-07-20T00:00:00.000Z",
      steps: [],
      currentStep: 0,
      log: [],
    } as Task;
    const store = createMockStore();
    store.getTask.mockResolvedValue(capacityTask);
    store.pauseTask = vi.fn(async () => {
      throw new Error("database unavailable");
    });
    vi.spyOn(worktreePool, "detectGitRepository").mockResolvedValue({ status: "repo" });
    vi.spyOn(worktreeAcquisition, "acquireTaskWorktree").mockRejectedValue(new Error("worktree stopped before provider session"));
    const finish = vi.fn(async () => ({ state: "released" as const }));
    const control = {
      begin: vi.fn(async () => ({
        state: "execution_granted" as const,
        attempt: {},
        admission: {},
        handle: {
          attempt: {},
          renew: vi.fn(),
          finish,
        },
      })),
      maintain: vi.fn(({ onRenewalFailure }: { onRenewalFailure: (failure: unknown) => void }) => ({
        start: () => onRenewalFailure({ state: "not_renewed", attempt: {} }),
        settle: vi.fn(async () => undefined),
      })),
    } as unknown as GlobalCapacityLegacyDispatchControlV1;
    const executor = new TaskExecutor(store, process.cwd(), {
      globalCapacityLegacyDispatchControl: control,
    });

    await executor.execute(capacityTask);

    expect(store.pauseTask).toHaveBeenCalledWith(
      capacityTask.id,
      true,
      expect.anything(),
      expect.objectContaining({ pausedReason: "global-capacity-recovery:v1:renewal-lost" }),
    );
    expect(worktreeAcquisition.acquireTaskWorktree).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
  });

  it("preserves a durable renewal pause instead of requeueing or completing the task", async () => {
    const capacityTask = {
      ...task,
      column: "in-progress",
      createdAt: "2026-07-20T00:00:00.000Z",
      updatedAt: "2026-07-20T00:00:00.000Z",
      steps: [],
      currentStep: 0,
      log: [],
    } as Task;
    const store = createMockStore();
    store.getTask.mockResolvedValue(capacityTask);
    store.pauseTask = vi.fn(async () => undefined);
    vi.spyOn(worktreePool, "detectGitRepository").mockResolvedValue({ status: "repo" });
    vi.spyOn(worktreeAcquisition, "acquireTaskWorktree").mockRejectedValue(new Error("worktree stopped before provider session"));
    const finish = vi.fn(async () => ({ state: "released" as const }));
    const control = {
      begin: vi.fn(async () => ({
        state: "execution_granted" as const,
        attempt: {},
        admission: {},
        handle: {
          attempt: {},
          renew: vi.fn(),
          finish,
        },
      })),
      maintain: vi.fn(({ onRenewalFailure }: { onRenewalFailure: (failure: unknown) => void }) => ({
        start: () => onRenewalFailure({ state: "not_renewed", attempt: {} }),
        settle: vi.fn(async () => undefined),
      })),
    } as unknown as GlobalCapacityLegacyDispatchControlV1;
    const executor = new TaskExecutor(store, process.cwd(), {
      globalCapacityLegacyDispatchControl: control,
    });

    await executor.execute(capacityTask);

    expect(worktreeAcquisition.acquireTaskWorktree).not.toHaveBeenCalled();
    expect(finish).toHaveBeenCalledTimes(1);
    expect(store.moveTask).not.toHaveBeenCalledWith(capacityTask.id, "todo", expect.anything());
    expect(store.handoffToReview).not.toHaveBeenCalled();
  });

  it("does not release capacity before an unresolved child cleanup is durably parked", async () => {
    const capacityTask = {
      ...task,
      column: "in-progress",
      createdAt: "2026-07-20T00:00:00.000Z",
      updatedAt: "2026-07-20T00:00:00.000Z",
      steps: [],
      currentStep: 0,
      log: [],
    } as Task;
    const store = createMockStore();
    store.getTask.mockResolvedValue(capacityTask);
    store.pauseTask = vi.fn(async () => undefined);
    vi.spyOn(worktreePool, "detectGitRepository").mockResolvedValue({ status: "repo" });
    vi.spyOn(worktreeAcquisition, "acquireTaskWorktree").mockRejectedValue(new Error("worktree stopped before provider session"));
    const finish = vi.fn(async () => ({ state: "released" as const }));
    const control = {
      begin: vi.fn(async () => ({
        state: "execution_granted" as const,
        attempt: {},
        admission: {},
        handle: {
          attempt: {},
          renew: vi.fn(),
          finish,
        },
      })),
      maintain: vi.fn(() => ({
        start: vi.fn(),
        settle: vi.fn(async () => undefined),
      })),
    } as unknown as GlobalCapacityLegacyDispatchControlV1;
    const executor = new TaskExecutor(store, process.cwd(), {
      globalCapacityLegacyDispatchControl: control,
    });
    vi.spyOn(executor as any, "terminateAllChildren").mockRejectedValue(new Error("child still alive"));

    await executor.execute(capacityTask);

    expect(store.pauseTask).toHaveBeenCalledWith(
      capacityTask.id,
      true,
      expect.anything(),
      expect.objectContaining({ pausedReason: "global-capacity-recovery:v1:child-cleanup-unresolved" }),
    );
    expect(finish).not.toHaveBeenCalled();
  });
});
