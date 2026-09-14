/**
 * Which shell the app draws for a window size. "wide" is a sidebar next to a detail pane; "phone"
 * is one screen at a time.
 *
 * Width alone is not enough: an iPhone Pro Max is 956 dp wide in landscape but only 440 dp tall,
 * and a two-pane layout on it would leave the thread a letterbox. So the *shorter* side has to be
 * tablet-sized too. An iPad mini in portrait (744 × 1133) qualifies; a phone never does, in either
 * orientation; an iPad split-view slot narrower than 700 dp falls back to the phone shell.
 */
export type LayoutMode = "phone" | "wide";

export const WIDE_MIN_WIDTH = 700;
export const WIDE_MIN_SHORT_SIDE = 600;
export const SIDEBAR_WIDTH = 320;

export function layoutMode({ width, height }: { width: number; height: number }): LayoutMode {
  if (!(width >= WIDE_MIN_WIDTH)) return "phone";
  return Math.min(width, height) >= WIDE_MIN_SHORT_SIDE ? "wide" : "phone";
}
