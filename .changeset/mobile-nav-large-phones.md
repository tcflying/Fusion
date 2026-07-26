---
"@runfusion/fusion": patch
---

summary: Restore the mobile bottom nav bar on large phones, which were being treated as tablets.
category: fix
dev: `isMobileViewport()` gained a phone width floor (`PHONE_MAX_CSS_WIDTH` = 600) that overrides the FN-8557 `isTabletClassTouchScreen()` exclusion. That check treats any touch device whose `window.screen` min edge exceeds 480px as tablet-class, which large Android phones report, so they lost mobile mode at any CSS width while `MobileNavBar.css` still displayed at `(max-width: 768px)`. The tablet carve-out now applies only in the 601-768px band.
