---
"@runfusion/fusion": patch
---

summary: Stop PostgreSQL-mode boots from opening and checkpointing the legacy SQLite files.
category: fix
dev: The first-boot auto-migration guard probed .fusion/fusion.db with a read-write DatabaseSync open on every boot, performing WAL recovery + checkpoint (file writes). The PostgreSQL emptiness count now runs first; the SQLite probe only runs on the empty-PG path where auto-migration is actually considered, so steady-state PG boots leave the legacy files byte-quiet.
