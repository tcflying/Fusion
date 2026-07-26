---
"@runfusion/fusion": patch
---

summary: Fix duplicate project-settings requests when voice dictation is present in task composers.
category: fix
dev: useVoiceDictation now uses project-scoped useVoiceAvailability and no longer calls fetchSettings; it reuses health.ts withProjectId.
