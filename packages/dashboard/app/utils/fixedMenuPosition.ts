/*
FNXC:QuickAddDepsMenu 2026-07-25-12:00:
Portaled `position: fixed` menus (Quick Add Deps and sibling pickers) must stay attached to their trigger.
`getBoundingClientRect()` and fixed CSS both use the layout viewport, so sizing must use
`document.documentElement.clientWidth/clientHeight` (or `window.inner*`) and must never mix in
`visualViewport` width/height/offset — that mix detaches menus under pinch-zoom or an open keyboard
(same failure class as the TaskDetail Activity menu fix).

FNXC:QuickAddDepsMenu 2026-07-25-12:00:
Anchor-first: place the menu immediately below (or above) the trigger, then shrink `maxHeight` to the
real free space. Never clamp `top` away from the trigger to preserve a preferred/min height floor —
that produced the Deps menu floating too high and unattached when space was tight.
*/

export interface FixedMenuTriggerRect {
  top: number;
  bottom: number;
  left: number;
  width: number;
}

export interface FixedMenuPositionInput {
  triggerRect: FixedMenuTriggerRect;
  viewportWidth: number;
  viewportHeight: number;
  preferredWidth: number;
  preferredHeight: number;
  /** Soft floor for width when the viewport is wide enough; never forces horizontal overflow. */
  minWidth?: number;
  horizontalPadding?: number;
  verticalPadding?: number;
  gap?: number;
}

export interface FixedMenuPosition {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
  openUpward: boolean;
}

export interface LayoutViewportSize {
  width: number;
  height: number;
}

/**
 * Layout-viewport size for `position: fixed` portal menus.
 * Prefer `documentElement.client*` so zoom/keyboard visual-viewport drift cannot shove anchors.
 */
export function getLayoutViewportSize(
  doc: Pick<Document, "documentElement"> | null | undefined = typeof document !== "undefined" ? document : null,
  win: Pick<Window, "innerWidth" | "innerHeight"> | null | undefined = typeof window !== "undefined" ? window : null,
): LayoutViewportSize {
  const docEl = doc?.documentElement;
  return {
    width: docEl?.clientWidth || win?.innerWidth || 0,
    height: docEl?.clientHeight || win?.innerHeight || 0,
  };
}

/**
 * Compute fixed portal menu geometry that stays attached to the trigger.
 * Shrinks height into free space instead of sliding the menu off the trigger.
 */
export function computeFixedMenuPosition(input: FixedMenuPositionInput): FixedMenuPosition {
  const horizontalPadding = input.horizontalPadding ?? 16;
  const verticalPadding = input.verticalPadding ?? 16;
  const gap = input.gap ?? 4;
  const minWidth = input.minWidth ?? 0;

  const maxViewportWidth = Math.max(input.viewportWidth - horizontalPadding * 2, 0);
  const width = Math.min(
    Math.max(input.preferredWidth, minWidth > 0 ? Math.min(minWidth, maxViewportWidth) : 0),
    maxViewportWidth > 0 ? maxViewportWidth : Math.max(input.preferredWidth, minWidth),
  );

  // Keep the left edge under the trigger; shift only enough to stay inside horizontal padding.
  const left = Math.max(
    horizontalPadding,
    Math.min(input.triggerRect.left, Math.max(horizontalPadding, input.viewportWidth - horizontalPadding - width)),
  );

  const spaceBelow = input.viewportHeight - input.triggerRect.bottom - verticalPadding - gap;
  const spaceAbove = input.triggerRect.top - verticalPadding - gap;
  const openUpward = spaceBelow < input.preferredHeight && spaceAbove > spaceBelow;

  if (openUpward) {
    const maxHeight = Math.max(0, Math.min(input.preferredHeight, spaceAbove));
    // Bottom edge of the menu sits `gap` above the trigger top — always attached.
    const top = input.triggerRect.top - gap - maxHeight;
    return { top, left, width, maxHeight, openUpward: true };
  }

  const maxHeight = Math.max(0, Math.min(input.preferredHeight, spaceBelow));
  // Top edge sits `gap` below the trigger bottom — always attached.
  const top = input.triggerRect.bottom + gap;
  return { top, left, width, maxHeight, openUpward: false };
}
