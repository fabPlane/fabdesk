/** Compact empty height: one to two lines plus padding, matching Codex/Claude. */
export const COMPOSER_TEXTAREA_MIN_PX = 44;
/** Grow-with-content cap; overflow scrolls after this. */
export const COMPOSER_TEXTAREA_MAX_PX = 240;

export type ComposerAutosizeInput = {
  /** `scrollHeight` after collapsing the element so it is not stretched by a prior inline height. */
  scrollHeight: number;
  /**
   * Layout width. `0` means flex/fonts have not settled — `scrollHeight` then reflects a
   * wrapped placeholder or a collapsed box, not the real content height.
   */
  clientWidth: number;
  /** Current draft. Empty must stay compact; placeholders must not inflate the first paint. */
  value: string;
};

/**
 * Content-box height for the chat composer textarea.
 *
 * First paint often runs before the field has a real width. Measuring `scrollHeight` then
 * (especially after setting `height: 0`) yields a huge value — typically the 240px cap —
 * until the next input event remasures. Empty drafts and unset widths therefore stay at
 * the compact min; only laid-out, non-empty content may grow up to the max.
 */
export function composerTextareaHeight({ scrollHeight, clientWidth, value }: ComposerAutosizeInput): number {
  if (value.length === 0 || clientWidth <= 0) return COMPOSER_TEXTAREA_MIN_PX;
  return Math.min(COMPOSER_TEXTAREA_MAX_PX, Math.max(COMPOSER_TEXTAREA_MIN_PX, scrollHeight));
}

export function applyComposerTextareaHeight(
  el: { style: { height: string }; scrollHeight: number; clientWidth: number },
  value: string,
): number {
  const width = el.clientWidth;
  if (value.length === 0 || width <= 0) {
    el.style.height = `${COMPOSER_TEXTAREA_MIN_PX}px`;
    return COMPOSER_TEXTAREA_MIN_PX;
  }
  el.style.height = "0px";
  const next = composerTextareaHeight({ scrollHeight: el.scrollHeight, clientWidth: width, value });
  el.style.height = `${next}px`;
  return next;
}
