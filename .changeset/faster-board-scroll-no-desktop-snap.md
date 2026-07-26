---
"@runfusion/fusion": minor
---

summary: Board scrolling feels faster — desktop no longer snaps, and phone swipes page immediately instead of coasting.
category: feature
dev: Base `.board`/`.board-workflow-columns`/`.lane-columns` declare `scroll-snap-type: none`; proximity snap is re-declared in phone-tier media blocks only. `useColumnScrollSnap` now owns post-lift motion: a directional lift kills native inertia (`overflow-x: hidden` for the animation) and animates to its target column via rAF ease-out (~190-300ms), with the page count derived from release velocity sampled off scroll ticks (`resolvePageCount`, `resolveFlingTargetIndex`, `resolvePageAnimationMs`). Re-touch cancels the animation; reduced motion and missing rAF fall back to the instant hard jump. Tap-to-stop-during-momentum is gone as an interaction (no long coast remains).
