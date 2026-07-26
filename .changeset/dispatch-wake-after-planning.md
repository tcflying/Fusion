---
"@runfusion/fusion": patch
---

summary: Execution now starts as soon as planning finishes, instead of waiting for the next engine poll.
category: fix
dev: Scheduler tracks task ids seen with `status: "planning"` and triggers a scheduling pass on the planning -> dispatchable transition. Plan-in-place workflows (Coding (Ideas)) clear `status` in place without a `task:moved`, so none of the pre-existing event wakes (task:created, globalPause/enginePaused unpause, per-task unpause) fired for a card that had just become executable — it waited out `pollIntervalMs`. The wake is guarded on `!task.status`, not paused/userPaused, and a schedulable column, so a planning -> failed/awaiting-approval park does not trigger a pass; `schedule()`'s re-entrance guard drops it if a pass is already running.
