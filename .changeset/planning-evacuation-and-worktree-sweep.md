---
"@runfusion/fusion": minor
---

summary: Moving a card out of Todo while it plans now stops planning, clears the badge, and frees its worktree.
category: fix
dev: TriageProcessor gains `taskEvacuatedFromPlanningHandler` (reuses the pause/delete abort path, clears `status: "planning"`); the executor aborts in-flight work on a backward move out of todo/triage and calls `releasePreExecutionWorktree`, which requires no execution timestamp, no live session, and a clean branch. A new self-healing sweep `reconcile-pre-execution-worktrees` reclaims parked worktrees only after 30 days of complete inactivity, skipping todo/executing/paused/status-carrying/blocked/recovery-scheduled rows. `hasAdvancedPastPlanning` no longer reads `worktree` as execution evidence — planning owns one now — and uses `firstExecutionAt`/`executionStartedAt` instead.
