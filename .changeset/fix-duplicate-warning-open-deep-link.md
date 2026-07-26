---
"@runfusion/fusion": patch
---

summary: Fix the "Open" button on possible-duplicate task warnings doing nothing.
category: fix
dev: `#/tasks/<id>` had no consumer — five surfaces wrote it (duplicate-warning Open in InlineCreateCard/NewTaskModal/QuickEntryBox, Column/ListView quick-add fallbacks) while only `?task=<id>` was implemented. `useDeepLink` now owns both shapes; unresolvable ids toast instead of no-op'ing.
