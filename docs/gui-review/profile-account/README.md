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
