---
"@runfusion/fusion": patch
---

summary: Fix startup failure where the SQLite → PostgreSQL migration aborted on CE session timestamps.
category: fix
dev: project.ce_sessions.last_activity_at was `integer` but stores epoch milliseconds, overflowing PG int4 and failing first-boot auto-migration. Now `bigint` in the Drizzle shape and CE plugin schema-hook DDL, with an idempotent `ALTER COLUMN ... TYPE bigint` for datadirs that already materialized the integer column.
