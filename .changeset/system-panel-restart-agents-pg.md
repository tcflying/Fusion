---
"@runfusion/fusion": patch
---

summary: Fix "Restart all agents" in the System panel failing with a SQLite removal error.
category: fix
dev: `POST /system/agents/restart-all` built its `AgentStore` from `rootDir` alone, falling through to the deleted sync SQLite path (VAL-REMOVAL-005). It now passes the scoped project's `AsyncDataLayer` via `requireAsyncLayer` and the scoped `taskStore`.
