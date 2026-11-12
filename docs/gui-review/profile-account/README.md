# Profile & account verification (#437)

Native macOS development build, 2026-11-12. Baseline: current main at
`6c3ddee4f22e1bc90ca126115f8400fd96719f6b`. The PR description records the exact
feature capture revision and embeds GitHub attachment images; no screenshot binaries
are committed here.

## Behavior

The header avatar on Home and projects opens the same Profile & account window as
Settings → Account. Account changes keep the local workspace mounted and preserve
project selection, chat drafts and local edits. Private cloud query keys and dialog
state change with the authenticated identity. fabPlane identity is separate from
agent/provider connections; sharing access still belongs to each project's Share window.

## Verification

- Bun 1.4.4 (repository permits 1.4.x): root typecheck, root tests and desktop build.
- Mobile typecheck and 345 Mobile tests pass after the shared query changes.
- Native app with isolated home, projects, preferences and daemon port; two disposable
  accounts served by a loopback fabPlane API fixture. The real AuthClient, device-code
  polling, credential storage, core HTTP API, SSE and Electron renderer were exercised.
- Home and project entry points, Settings routing without discarding the underlying
  settings section, signed-in/out, failed/pending login, switch account and expired
  cloud-session recovery.
- Sign-out/switch preserve the active local project and unsent composer text.
- A `fabplane://project/<id>` invitation unavailable to the first account becomes
  available after switching to the invited account. The old account's board disappears
  on switching away. Closing recovery returns to the same invitation with keyboard focus.
- Tab and Shift-Tab remain in the top dialog; Escape returns focus to the avatar or
  underlying invitation. Refreshing an underlying dialog cannot steal recovery focus.
  Focus is restored inside the top window after temporarily disabling sign-in actions;
  recovery was repeated with real Electron clicks at both window sizes.
- 1440×920 and 960×600; all four themes checked at the smaller size. The compact
  dialog scrolls vertically; its close button remains reachable and no horizontal overflow occurs.
- Regression tests cover account email across online/offline credential reload, stale
  identity removal, local/cloud identity boundaries, cache invalidation including late
  previous-account responses, and preserving settings/project/chat/notes state.

## Reproduction checklist

1. From Home, open the avatar. Confirm name, email and Signed in. Switch account;
   approve the existing device flow in the browser using the other account.
2. Create a local project and leave an unsent chat draft. Sign out, close Profile, then
   sign in again. Confirm project and draft remain. Restart and confirm identity/email.
3. Open an invitation for the other account. Choose Switch account, approve it, then
   Escape. Confirm the original invitation and its board list remain open, with focus inside.
4. Reject/expire the cloud session. Choose Sign in again, approve, and retry access.
5. Repeat keyboard/layout checks at 960×600 and 1440×920; verify the agent-settings link
   opens the existing provider configuration rather than treating fabPlane login as agent login.

## Limits and test observations

The local fixture does not prove production browser/SSO approval, live invitation
email delivery or production backend deployment. Those remain release smoke checks;
no production account, sharing permissions or backend deployment was changed.
Windows native interaction was not tested on this Mac.

The first root run had one process-ownership cleanup assertion fail because an atomic
`.tmp` record was still present. Its targeted rerun and the full unchanged-main run
passed; the subsequent feature root run also passed. No assertion was weakened and
no skip was added. This observation is retained rather than asserting a proven cause.
Existing optional native integration skips remain reported in the root test totals.

## Follow-up bug audit

- Reproduced and fixed a late previous-account HTTP 401 signing out the replacement
  session, and an in-flight auth-status query overwriting a newer SSE sign-out event.
- Delayed login responses now respect newer auth events. Native verification held a
  pending HTTP response until after browser approval, then confirmed the signed-in
  identity remained intact when that response arrived.
- Profile owns workspace shortcuts and Electron menu actions, so Command-K and board
  navigation cannot open or rearrange the workspace behind account recovery.
- A session approved while the identity service is unavailable is labeled Signed in
  with an explicit missing-details message and working Sign out. Unidentified-session
  caches are still cleared on logout.
- Returning to shared projects from an expired invitation reuses its existing dialog.
- Dashboard/organization content mounts only while expanded and resets on account
  change: native checks observed zero cloud-status requests while collapsed and one
  request when opened.
- Added six regression tests for auth ordering and fallback identity. Rechecked native
  shortcuts/focus at both sizes, deferred login responses, missing identity, invitation
  recovery and organization loading using disposable accounts and no agent runs.

## Final audit follow-up

- Reproduced a microphone request from Alt-Space while Profile was open. Voice
  activation now ignores modal windows; native checks at both window sizes confirm
  Profile and Settings block the shortcut while the normal composer still receives it.
  Microphone access was mocked and rejected; no audio was recorded or transcribed.
- Reproduced a delayed initial LoginScreen response reverting an approved session to
  Pending and opening Profile unexpectedly. Initial device/password sign-in and
  fallback polling now use the same guarded auth snapshots as Profile; unmounted
  polling callbacks are discarded. The real Electron reproduction passes after rebuilding.
- Root typecheck, desktop build and 3,077 root tests pass (38 existing optional skips,
  zero failures). Existing auth-ordering regression tests remain unchanged.
- Repeated native modal shortcuts, keyboard focus, missing-identity sign-out, deferred
  sign-in responses, project/draft retention and Settings return at both window sizes.
  The production SSO, live invitation delivery and native Windows limits above remain.
