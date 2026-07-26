---
"@runfusion/fusion": patch
---

summary: Small mobile board swipes no longer jump several columns at once.
category: fix
dev: `resolvePageCount` in `useColumnScrollSnap` now gates each extra fling page on net gesture travel (max of board scroll delta and horizontal finger travel) against viewport width, not release velocity alone.
