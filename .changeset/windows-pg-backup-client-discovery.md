---
"@runfusion/fusion": patch
---

summary: Find existing Windows PostgreSQL clients for database backups.
category: fix
dev: Backup client discovery now checks the embedded runtime cache and standard Program Files PostgreSQL locations before reporting pg_dump or pg_restore missing.
