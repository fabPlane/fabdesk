# Board Art draft-save recovery

Follow-up for #394, 2026-11-16. The broader circuit-first Apply workflow remains
open; this change repairs failed draft saving only.

## Problem and change

After an automatic draft write failed, the UI said “use Save draft to retry”.
There was no such control: **Save artwork** writes a separate saved artwork
record. The failed working draft could remain stale on disk, and the original
error remained visible after a later successful automatic save.

The failure now has a **Retry draft save** action for the actual working draft.
The action shows progress, prevents repeated clicks during the write, and clears
only the draft-save error after success. Other artwork errors remain separate.
The notice also works without an image, including a failed empty-draft save.
Saved-artwork status cannot conceal an outstanding draft-save failure.

## Verification

- 21 focused tests pass (68 assertions), including repeated write failures,
  later edits, successful retry and reopening through a fresh client. Writes
  remain confined to the owning project's `board-art/draft.json`.
- Root typecheck and desktop build pass.
- Root Windows tests retain exactly the 55 failing names reproduced on main
  `be14cc1df52439fa1651a51d34b72ba24ebbb94b`. No new skips or weakened assertions.
- Actual Electron 44.1.1 development app, isolated profile and disposable
  **Artwork restoration review** project; synthetic color-grid source image.
- At 1440×920, injected failure of that project's draft write reproduces the
  misleading instruction in the prior build. In the fixed build the image and
  125% zoom stay visible, and Retry remains available after another failure.
- At 960×600, Retry stays within the visible tools pane; no document horizontal
  overflow. A deliberately delayed write shows a disabled “Retrying draft
  save…” button. Releasing the real write clears the notice and reports saved.
- After a complete app restart, the same image and 125% zoom restore from disk.
  The temporary write interception was removed before restarting.

Before/after renderer screenshots are attached to the draft PR. They exclude
native window chrome. No circuit, agent run, sharing account or cloud data was
changed. Physical Mac and packaged-installation checks are not claimed.
