---
"@runfusion/fusion": patch
---

summary: Fix the Settings footer update notice and buttons being cut off on mobile.
category: fix
dev: On mobile the update-check result renders in a new `.settings-modal-footer-update-row` above the nowrap `.modal-actions` rail; desktop/tablet keep it inline next to the version button.
