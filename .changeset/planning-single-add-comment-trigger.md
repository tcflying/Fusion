---
"@runfusion/fusion": patch
---

summary: Planning Mode shows one "Add comment to selection" button, and only once the selection is finished.
category: fix
dev: Removes the `planning-add-comment--document` trigger and the `--mobile` modifier (single `.planning-add-comment` rail button at every breakpoint); `planSelectionDragActiveRef` suppresses quote writes between pointerdown and pointerup inside the plan document so mid-drag `selectionchange` no longer mounts/unmounts the trigger.
