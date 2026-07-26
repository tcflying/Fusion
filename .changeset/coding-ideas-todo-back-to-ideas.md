---
"@runfusion/fusion": patch
---

summary: Coding (Ideas) boards can now move cards back from Todo to Ideas.
category: fix
dev: Legacy source columns in the flag-OFF `moveTaskInternal` path now union `VALID_TRANSITIONS` with the task's workflow-resolved adjacency (`resolveAllowedColumns`), resolved lazily only when the legacy table alone would reject. builtin:coding adjacency is unchanged.
