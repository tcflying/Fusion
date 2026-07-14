---
"@runfusion/fusion": patch
---

summary: Bind dashboard/serve stores to the central project registry instead of relying on cwd identity.
category: fix
dev: createTaskStoreForBackend now resolves the central-registry project id for rootDir-only boots (fn dashboard, fn serve, desktop, per-path project stores) and binds the AsyncDataLayer to it — cwd/rootDir is only a lookup key into central.projects; identity/partitioning comes from the registry. Also re-keys the migrated legacy config row ('' → project id) during first-boot auto-migration so bound readers keep the migrated settings, workflowSteps, taskPrefix, and nextId counters. Unregistered paths still boot unbound (legacy single-project behavior).
