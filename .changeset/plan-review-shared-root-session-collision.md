---
"@runfusion/fusion": patch
---

summary: Two tasks can now run Plan Review at the same time instead of one failing and parking.
category: fix
dev: `TaskExecutor.sessionRegistryPath` now task-scopes the activeSessionRegistry key for any session rooted at `rootDir`, not just in workspace mode. Read-only graph nodes (Plan Review) run at the repo root, so the bare-root key made the second concurrent task throw `ActiveSessionPathHeldByForeignTaskError`, which surfaced as a Plan Review provider failure and burned the in-place retry budget.
