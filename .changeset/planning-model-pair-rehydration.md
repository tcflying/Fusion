---
"@runfusion/fusion": patch
---

summary: Fix Planning Mode failing mid-interview with a provider auth error on a model you never selected.
category: fix
dev: `ensureSessionAgent` rebuilt the planning agent with an empty provider/model pair, so resumed turns (`/planning/respond`, `/planning/:id/retry`, rewind, drafts resumed after the in-memory agent was dropped) fell through to the runtime's built-in default model (`anthropic/claude-opus-4-8`) and hit api.anthropic.com with a key the operator never configured. The pair is now resolved from the persisted draft, then the lane's `resolvePlanningSettingsModel` result, on every rebuild and on the non-streaming start. Planning also now constructs sessions through `createResolvedAgentSession` (`sessionPurpose: "executor"`) like chat/executor/merger, so CLI and plugin runtimes can own their own auth and planning emits `session:runtime-resolved`.
