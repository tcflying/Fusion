---
"@runfusion/fusion": patch
---

summary: Stop leaving cards stuck with stale worktree metadata when their branch inherited another task's commit.
category: fix
dev: The reclaim sweep's `tip-already-merged` arm vetoed on the branch tip's foreign `Fusion-Task-Id` trailer alone, so a task branch cut from the base that never committed anything (planning aborted, moved back to `todo`) was rejected as foreign contamination and re-logged `already-merged rejected ... reason=foreign-task-tip` every sweep. The merge-base diff-proof classification used by already-merged and branch-misbound recovery is now a shared `SelfHealingManager.foreignTipRejection` helper used by all three callers; rejection still fires when the branch has unique content or the base already carries the task's own commit.
