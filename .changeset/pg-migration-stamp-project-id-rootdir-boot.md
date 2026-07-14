---
"@runfusion/fusion": patch
---

summary: Fix empty task board after the PostgreSQL migration when booting via fn dashboard.
category: fix
dev: The first-boot auto-migration only stamped migrated rows' project_id when the boot passed a bound projectId, but `fn dashboard` boots with rootDir only — so rows stayed NULL and every project-bound reader (engine, project-store-resolver) filtered them out. The stamping id is now resolved from the just-migrated central registry by matching the registered project path to rootDir; unregistered single-project setups still leave rows NULL for their unbound (unfiltered) readers.
