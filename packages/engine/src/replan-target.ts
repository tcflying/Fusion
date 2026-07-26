import type { Task, TaskStore } from "@fusion/core";
import { resolveWorkflowIrForTask, workflowHasColumn } from "@fusion/core";

/*
FNXC:WorkflowReplan 2026-07-12-23:15:
Engine rebounds that send a task back for (re)planning — Plan Review REVISE, stale-spec
enforcement, filesystem-validation failures — used to hardcode moveTask(id, "triage").
Workflows without a "triage" column (Coding (Ideas) merges the planner into "todo") ended up
with a column-orphaned card: the board rendered it back in the intake lane ("Ideas") and the
aggregate All-workflows view dropped it entirely. The replan target must be resolved against
the task's OWN workflow: "triage" when declared, otherwise the plan-in-place planner column
("todo"). Triage's todo-discovery picks up `needs-replan` todo cards so plan-in-place replans
still run.

FNXC:WorkflowReplan 2026-07-13-11:30:
The final fallback is "triage", NEVER the workflow's entry column. Workflows that declare
neither "triage" nor "todo" (builtin marketing, arbitrary customs) have no column the triage
service scans, so parking a needs-replan card in their custom entry column strands it forever
— and the legacy move path throws on custom targets, aborting the replan before the status
write. "triage" preserves the pre-workflow-aware behavior for these workflows: the move is
legal from every legacy column and eligibleTriageTasks re-specifies unconditionally.
*/
/*
 * FNXC:WorkflowReplan 2026-07-15-13:15:
 * FN-7977: a planning/provider recovery may finish after another engine lane has
 * started execution. Recovery callers must prove the live row is still planning
 * before writing planning state; worktrees and execution or terminal columns are
 * durable evidence that the task has advanced.
 *
 * FNXC:WorkflowReplan 2026-07-16-05:35:
 * Materialized steps are NOT advancement evidence for a card still parked in a planner
 * lane. Triage materializes steps when it finalizes a spec, so every replan (Plan Review
 * REVISE -> needs-replan) legitimately carries the steps of its previous planning pass.
 * Counting steps>0 as "advanced" made the primary triage claim in specifyTask() skip its
 * status:"planning" write on every poll: the card was re-claimed forever, never planned,
 * and — because wedged cards keep occupying maxTriageConcurrent slots — starved every
 * healthy card queued behind them. Both planner surfaces must stay plannable: the "triage"
 * column, and plan-in-place workflows (Coding (Ideas)) that park needs-replan cards in
 * "todo" carrying a real spec. A planned-and-queued "todo" card with no planning status is
 * still genuinely advanced, so steps remain the deciding signal there.
 */

/** Statuses that explicitly park a card for (re)planning, whichever column holds it. */
const PLANNING_STAGE_STATUSES = new Set(["planning", "needs-replan", "plan-review-unavailable"]);

/**
 * The TRANSIENT planning-stage status: a planner is writing PROMPT.md right now. Everything else in
 * {@link PLANNING_STAGE_STATUSES} is a durable park.
 */
const TRANSIENT_PLANNING_STATUS = "planning";

/*
FNXC:WorkflowReplan 2026-07-26-07:40:
The DURABLE subset of PLANNING_STAGE_STATUSES: a card parked here was deliberately sent back by Plan
Review (or by a reviewer outage) and stays parked until a planner re-specifies it. Only these
outrank the execution timestamps below. `planning` is deliberately excluded — it is the TRANSIENT
in-flight planner claim, and a fresh execution stamp on a `planning` row means execution won the
race that FN-8361 guards (recovery must not clear the status out from under the claiming executor).

DERIVED, not re-listed: a new durable park status added to PLANNING_STAGE_STATUSES must automatically
join this set, or it reproduces the FN-8594 strand this file already fixed once (a park status that
lost to a sticky stamp, so the card was never re-planned). Only the transient status is subtracted.
*/
const REPLAN_PARK_STATUSES = new Set(
  [...PLANNING_STAGE_STATUSES].filter((status) => status !== TRANSIENT_PLANNING_STATUS),
);

export function hasAdvancedPastPlanning(
  task: Pick<Task, "column" | "worktree" | "steps" | "status">
    & Partial<Pick<Task, "firstExecutionAt" | "executionStartedAt">>,
): boolean {
  if (
    task.column === "in-progress"
    || task.column === "in-review"
    || task.column === "done"
    || task.column === "archived"
  ) {
    return true;
  }
  /*
  FNXC:WorkflowReplan 2026-07-26-06:10:
  A DURABLE parked-for-replan status outranks execution evidence, because that evidence is STICKY
  while a replan is a legitimate BACKWARD move. `firstExecutionAt`/`executionStartedAt` are never
  cleared once implementation starts, so a card that executed, failed Plan Review, and was rebounded
  to a planner lane (`needs-replan`) read as "advanced past planning" forever: triage's discovery
  filter (`column === "triage" && isTaskStillInPlanningStage`) never re-admitted it and the card sat
  in triage/needs-replan permanently — "stuck in planning" on the board (FN-8594). It hit every
  triage-column workflow (builtin:coding, the default); plan-in-place Ideas cards escaped only
  because todo discovery admits `needs-replan` without consulting this guard.
  This check covers BOTH planner lanes — the "triage" column and the plan-in-place "todo" lane.
  */
  if (task.status != null && REPLAN_PARK_STATUSES.has(task.status)) {
    return false;
  }
  /*
  FNXC:NodeWorktreeIsolation 2026-07-25-22:40:
  A worktree NO LONGER proves an executor claimed the card. Planning acquires the task's own
  worktree up front (so no lane runs in the shared checkout), which means a card being planned right
  now carries `worktree` — and reading that as "advanced" would make every planning write skip:
  `status:"planning"` never lands, the spec finalization is refused, and the card is re-claimed
  forever while occupying a maxTriageConcurrent slot. Execution TIMESTAMPS are the durable evidence
  instead; they are written when implementation actually starts, never by worktree acquisition.

  A triage card carrying a timestamp with NO planning status is the stranded-advanced class that
  self-healing's advanced recovery owns (PR #2360): planning must exclude it so it cannot burn a
  maxTriageConcurrent slot in a claim/skip loop.
  */
  if (task.firstExecutionAt != null || task.executionStartedAt != null) {
    return true;
  }
  // The planner column itself is never "advanced" — nothing executes out of triage, and the steps
  // below belong to the card's previous planning pass.
  if (task.column === "triage") {
    return false;
  }
  // Plan-in-place planner lane ("todo"): a card explicitly parked for planning has not advanced.
  // Reached only by `planning` here — the durable park statuses already returned above.
  if (task.status != null && PLANNING_STAGE_STATUSES.has(task.status)) {
    return false;
  }
  return (task.steps?.length ?? 0) > 0;
}

/*
FNXC:WorkflowReplan 2026-07-26-08:35:
The parameter type must mirror hasAdvancedPastPlanning's, including the execution stamps the
implementation reads. When it omitted them, a caller passing a narrowed object (rather than a whole
Task) type-checked while silently dropping the stamps — the guard then read them as absent, which is
the "not advanced" answer, and TypeScript could not flag it.
*/
export function isTaskStillInPlanningStage(
  task: Pick<Task, "column" | "worktree" | "steps" | "status">
    & Partial<Pick<Task, "firstExecutionAt" | "executionStartedAt">>,
): boolean {
  return !hasAdvancedPastPlanning(task);
}

export async function resolveReplanTargetColumn(store: TaskStore, taskId: string): Promise<string> {
  try {
    const ir = await resolveWorkflowIrForTask(store, taskId);
    if (workflowHasColumn(ir, "triage")) return "triage";
    if (workflowHasColumn(ir, "todo")) return "todo";
    return "triage";
  } catch {
    return "triage";
  }
}

/**
 * Move `task` to its workflow-aware replan column unless it is already there.
 * Pass `target` when the caller already resolved it (e.g. to log the target
 * first) so the resolve/compare/move contract still lives in one place.
 */
export async function moveTaskToReplanColumn(
  store: TaskStore,
  task: Pick<Task, "id" | "column">,
  target?: string,
): Promise<string> {
  const replanColumn = target ?? await resolveReplanTargetColumn(store, task.id);
  if (task.column !== replanColumn) {
    await store.moveTask(task.id, replanColumn);
  }
  return replanColumn;
}
