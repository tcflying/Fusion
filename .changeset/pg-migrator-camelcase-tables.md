---
"@runfusion/fusion": patch
---

summary: Fix SQLite → PostgreSQL migration silently skipping legacy camelCase tables.
category: fix
dev: The migrator snake_cased column names but matched TABLE names verbatim, so all 22 legacy camelCase SQLite tables (activityLog, runAuditEvents, mergeQueue, taskClaims, projectNodePathMappings, …) found no PostgreSQL counterpart and were silently skipped — surfacing as "Project/node path mapping not found" on engine start. TablePlan now carries a snake_cased pgTable used for all PostgreSQL-side operations. Re-run `fn db migrate` (idempotent) to top up databases migrated before this fix. Migration reports also now count inserted rows via RETURNING (previously "inserted 0" even when every row landed).
