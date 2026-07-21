---
"@runfusion/fusion": patch
---

summary: Repair PostgreSQL startup migration drift and audit-event retry compatibility.
category: fix
dev: Reconcile interrupted legacy markers with missing additive tables and columns, preserve runtime bookkeeping access, and use the project-scoped audit key during idempotent retries.
