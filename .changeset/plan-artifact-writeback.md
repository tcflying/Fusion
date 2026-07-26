---
"@runfusion/fusion": patch
---

summary: Plans written inside a task worktree are now saved to the main project and stored in the database.
category: fix
dev: New `packages/engine/src/plan-artifact-writeback.ts` exposes `reconcileWorktreePlanArtifact`, `mirrorPlanToProjectDb`, and `persistPlanArtifact`. Planning sessions run in the task worktree with the coding tool surface, so a planner using the generic write tool resolved the relative `.fusion/tasks/<id>/PROMPT.md` against the worktree; triage finalization reads `<rootDir>/<promptPath>` and saw nothing. Triage now reconciles the worktree copy through `store.updateTask({ prompt })` before the finalize read. `project.tasks` has no `prompt` column, so the authoritative plan is also mirrored into the `plan` task document from triage finalization and from `fn_task_prompt_write`.
