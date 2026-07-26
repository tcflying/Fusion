---
"@runfusion/fusion": minor
---

summary: Promote on a held card now explains why it was refused and can force execution past a pending replan.
category: feature
dev: `promoteHeldTask(store, id, deps, { force })` waives only the `unplanned-for-execution` gate (capacity, hold membership and slot reservation still arbitrate), clears a `needs-replan`/`plan-review-unavailable` status, and emits `task:promote-forced-unplanned`. `POST /tasks/:id/promote` accepts `{ force: true }` and `fn_task_promote` accepts `force: true`; the board asks for confirmation first. Adds the missing `board.rejection.unplannedForExecution` catalog entry that made the raw i18n key render.
