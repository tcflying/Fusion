---
"@runfusion/fusion": patch
---

summary: Harden Room control-plane trusted-device authorization.
category: security
dev: Room routes require an explicit public origin plus a durable PostgreSQL RBAC registry; daemon bearer credentials remain transport-only.
