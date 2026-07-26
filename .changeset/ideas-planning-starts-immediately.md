---
"@runfusion/fusion": patch
---

summary: Starting a task begins planning immediately, and cards waiting on a planning slot now say so.
category: fix
dev: TriageProcessor gains `requestImmediatePoll()` plus a store-event wake (`task:updated`/`task:created`) that fires when a task lands in `todo`/`triage`, debounced 150ms with a mid-poll replay — so every move surface (board drag, context menu, CLI, tools, `POST /tasks/:id/move`) wakes planning rather than waiting out `pollIntervalMs` (15s default). Planning discovery now admits a `todo` task whose `PROMPT.md` is missing (ENOENT) instead of dropping it via a silent `catch {}`, and logs unreadable prompts. `isUnplannedSeedPrompt` normalizes line endings/trailing whitespace before comparing, and `scheduler.ts`'s dispatch filter now uses that shared predicate instead of an open-coded strict bootstrap compare that disagreed with triage on the refinement-seed shape. Dashboard: an unplanned idle Todo card shows a "Queued to plan" badge (the complement of "Ready"), and the Start toast now reads "Queued {id} for planning" instead of claiming planning began.
