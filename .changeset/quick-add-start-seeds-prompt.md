---
"@runfusion/fusion": patch
---

summary: Fix quick-add Start creating tasks that could never be planned, and log how long held cards wait.
category: fix
dev: Quick-add "Start" submits a workflow id and the post-intake `todo` column in one request, so the card missed the intake branch in `task-creation.ts` and got `generateSpecifiedPrompt`'s hard-coded placeholder steps. Triage then read the non-seed PROMPT.md as "already planned" and never planned it, stranding the card in Todo with no log line (observed on FN-8587). Creates into `todo` on a manual-intake workflow (resolved intake != `triage`) now get the bootstrap seed; the pinned default-workflow direct-create-into-todo contract is unchanged. Separately, `runHoldReleaseSweep` now logs per-task held duration on release, a per-sweep summary with the prefetch cost broken out (the prefetch is a sequential await per non-archived task, so it scales with board size), and warns when a sweep exceeds 2s.
