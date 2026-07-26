---
"@runfusion/fusion": minor
---

summary: Planning and every review step now run in the task's own worktree, never the shared checkout.
category: fix
dev: Planning acquires the task worktree (TriageProcessor `acquirePlanningWorktree` → `TaskExecutor.ensureTaskWorktreeForPlanning`); graph nodes with no worktree acquire one instead of falling back to `rootDir`, and Plan Review re-acquires when its recorded worktree is gone (replacing the FN-7996 repo-root degrade). Registration goes through `acquireActiveSessionPath`, which reclaims a leaked entry whose holder is provably dead and aged past the FN-5256 floor. Remaining contention gets `SESSION_CONTENTION_HOLD_VALUE`: `isSessionContentionError` classifies it transient, `isNonPlanDefectPlanReviewFailure` explicitly excludes it, and the executor waits on a 10-attempt 5s→60s ladder that ends in a benign requeue, never a park.
