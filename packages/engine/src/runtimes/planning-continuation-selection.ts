import type { Task, WorkflowWorkItem } from "@fusion/core";

export interface PlanningContinuationCandidate {
  item: WorkflowWorkItem;
  task: Task | null | undefined;
}

export function isPlanningContinuationTaskDispatchable(
  task: Task | null | undefined,
): task is Task {
  if (task == null || task.paused === true || task.userPaused === true || task.deletedAt) return false;
  return task.column !== "archived" && task.column !== "done";
}

export type PlanningContinuationResolution =
  | { kind: "actionable"; item: WorkflowWorkItem; task: Task }
  | { kind: "skip"; item: WorkflowWorkItem; reason: "not-planning" | "paused" }
  | { kind: "orphan"; item: WorkflowWorkItem; reason: "task-not-found" | "task-terminal" };

export function resolvePlanningContinuationCandidate(
  item: WorkflowWorkItem,
  task: Task | null | undefined,
  opts?: { taskLookupFailed?: boolean },
): PlanningContinuationResolution {
  if (opts?.taskLookupFailed === true || task == null) {
    return { kind: "orphan", item, reason: "task-not-found" };
  }
  if (task.deletedAt || task.column === "archived" || task.column === "done") {
    return { kind: "orphan", item, reason: "task-terminal" };
  }
  if (item.waitReason !== "planning") {
    return { kind: "skip", item, reason: "not-planning" };
  }
  if (task.paused === true || task.userPaused === true) {
    return { kind: "skip", item, reason: "paused" };
  }
  return { kind: "actionable", item, task };
}

export function selectActionablePlanningContinuations(
  candidates: readonly PlanningContinuationCandidate[],
): Array<{ item: WorkflowWorkItem; task: Task }> {
  return candidates.flatMap((candidate) => {
    const resolved = resolvePlanningContinuationCandidate(candidate.item, candidate.task);
    return resolved.kind === "actionable" ? [{ item: resolved.item, task: resolved.task }] : [];
  });
}
