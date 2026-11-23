# Retain a newly retyped question

Follow-up for #415, 2026-11-16. This fixes draft acknowledgement only; durable
project updates and coordinated parallel read-only runs remain outside this PR.

A pending send compared the current text with the submitted text. Clearing the
composer and retyping the exact same question made that newer draft look like
the original, so acknowledgement erased it. The composer now observes edits to
that chat until the request settles, including while another chat is open.
Unchanged submissions still clear; submitted attachments clear independently.
The observation is removed after success or failure.

## Verification

- Nine focused composer/acknowledgement tests pass (33 assertions), including
  identical retyped text and independently retained new attachments.
- Root typecheck and desktop build pass.
- Root Windows tests reproduce 55 unchanged-main failures plus the previously
  observed telemetry snapshot timeout. That test passed alone in 26.45 seconds.
  No assertions were weakened or skips added; the full suite is not green.
- Actual Electron 44.1.1 Windows development app, isolated profile, disposable
  chats in the Artwork restoration review project. No agent run was started.
- Before: delayed send acknowledgement after clearing and retyping “Repeat
  this question” leaves an empty composer.
- After: the same sequence retains the question at 1440×920. At 960×600 it also
  survives switching to another chat in the same project before acknowledgement,
  then returning. A subsequent unchanged submission clears normally.
- Send acknowledgements were deliberately injected. Normal requests were restored
  afterward. This verifies UI timing, not agent execution or cloud delivery.
- Screenshots show the actual renderer before and after; they exclude native
  window chrome. Physical Mac and packaged installers were not tested.
