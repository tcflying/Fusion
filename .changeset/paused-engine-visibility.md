---
"@runfusion/fusion": patch
---

summary: A paused engine now reads "Paused" in the footer instead of "Idle", and pausing from the terminal takes two presses.
category: fix
dev: `deriveExecutorState` (dashboard `app/hooks/useExecutorStats.ts`) now returns "paused" for any `enginePaused` value regardless of `runningTaskCount`; the previous matrix mapped paused-with-zero-running to "idle". In the CLI TUI, the global `t` (Git view) branch now yields when the Utilities section owns input, making the advertised "[t] Toggle Engine Pause" reachable, and pausing requires a second `t` within `PAUSE_CONFIRM_WINDOW_MS` (5s); resuming stays single-press.
