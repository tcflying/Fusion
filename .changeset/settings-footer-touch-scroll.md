---
"@runfusion/fusion": patch
---

summary: Let the mobile Settings footer scroll sideways by touch when its buttons overflow the screen.
category: fix
dev: The footer rail already had `overflow-x: auto`, but the global mobile `* { touch-action: pan-y }` lock swallowed horizontal drags; the rail and its inner touch targets now opt back into `pan-x`, groups escape the mobile `max-width: 100%` reset, and the footer block tracks the full mobile breakpoint (`max-width: 768px, max-height: 480px`) so landscape phones get the same rail.
