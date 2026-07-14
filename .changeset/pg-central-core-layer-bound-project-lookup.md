---
"@runfusion/fusion": patch
---

summary: Fix engine failing to connect after the PostgreSQL migration with "Project not found".
category: fix
dev: getOrCreateForProjectImpl built its fallback CentralCore without the AsyncDataLayer; post-cutover a layer-less CentralCore has no database (legacy SQLite CentralDatabase is deleted), so projectId-only boots (engine InProcessRuntime, dashboard project-store-resolver) threw ProjectRequiredError despite the row existing in central.projects. The fallback is now bound to the caller's layer.
