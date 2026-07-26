---
"@runfusion/fusion": patch
---

summary: AI helper lanes now run on your configured model instead of silently falling back to a default Anthropic model.
category: fix
dev: `createFnAgent`/`createResolvedAgentSession` forward no model unless BOTH `defaultProvider` and `defaultModelId` are set, after which pi-coding-agent picks its own built-in default (`anthropic/claude-opus-4-8`). Milestone/slice interviews, subtask breakdown (triage + streaming), agent generation, text refine, goal drafting, and agent reflection all resolved no pair and hit that path on every call — a permanent `401 invalid x-api-key` for custom-provider/subscription operators and a hole in test-mode forcing. All now resolve through the shared `resolveLaneSessionModel` (dashboard) or `resolveProjectDefaultModel` (engine). Also pairs the research synthesis provider/model halves and replaces `pr-conflict-resolver`'s hand-rolled default resolution. A source ratchet (`lane-model-pair-ratchet.test.ts`) keeps new dashboard lanes from reintroducing the pattern.
