---
"@runfusion/fusion": minor
---

summary: Choose whether Anthropic lanes use your API key or your Claude subscription, and see which is in use.
category: feature
dev: New global setting `anthropicAuthPreference` ("api-key" | "subscription", default "api-key" — the historical precedence). Read in `resolveAnthropicRuntimeApiKey` (packages/engine/src/auth-storage.ts) straight from `~/.fusion/settings.json`, so it applies without a restart and needs no settings plumbing through `createFusionAuthStorage`. Settings → Authentication renders the control and an "In use" / "Overridden below" marker only when both Anthropic credentials are connected.
