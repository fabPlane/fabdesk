# Agent switching and compact recovery · November 3, 2026

This milestone addresses the user's Claude-to-Codex screenshot. It does not establish whole-app acceptance or change the teammate-owned enclosure/replacement/resize scope. Source changes remain local until a new publication request.

## Cause and implementation

- The composer changed its displayed selection before saving, then replaced the actual failure with a generic message. The running development service predated the merged `PUT /settings/agent-preference` endpoint and returned HTTP 404.
- An existing conversation now saves its agent/model through `PATCH /threads/:id` first. Saving future defaults is independent: a defaults failure cannot undo or block a saved conversation switch. Failed chat saves retain the previous choice. Pending saves show Switching…; send/model changes are guarded while saving or running.
- Query cache updates preserve thread history and cancel stale reads. A replaced connection gets its own owned query cache, so an old client's authorization error cannot populate the new connection. Late picker responses cannot change a different conversation's composer.
- Recoverable failures use one compact row: explanation title, relevant action and Details. Sign-in commands and original diagnostics remain collapsed. Composer notices can be dismissed; they do not disappear on a timer. Historical failures retain their original agent identity.
- Review prompt restores the latest failed request and its image attachments for inspection, never sends automatically, never overwrites an unsent revision and never copies into a different conversation.
- A metadata warning accompanying a terminal model failure is kept in Details. Ordinary prose, partial work and other warnings remain visible.
- Codex's exact advisory about resuming with a changed model is informational. It now produces separated warning text rather than an error event that incorrectly marks a successful run failed. Explicit `turn.failed`, authentication/model rejection and other errors still fail. The UI renders the advisory compactly without telling the user to undo their choice.

## Human walkthrough

Actual Electron “fabPlane Dev”, localhost:5173, existing fresh-user-flow test profile. Started inside the user's existing Untitled idea/Conversation, with their original request and failed Claude run. Nothing was deleted or replaced. Screenshots in [agent-switch-20261103](agent-switch-20261103/) are actual, unaltered captures; earlier intermediate states are preserved.

| Step | Visible action / expected outcome | Actual result | Status / evidence |
| --- | --- | --- | --- |
| Baseline | Inspect the reported screen | Large Claude auth explanation and separate generic save failure consumed conversation space | Reproduced; before-switch-errors.png |
| Change agent | Switch agent → Codex → GPT-6.1 Sol, keep same conversation | Chat switch saved; old service's defaults endpoint returned 404. Warning distinguished usable chat from unsaved default and exposed the real endpoint under Details | Passed with friction; chat-switched-default-warning.png, defaults-endpoint-details.png |
| Recover prompt | Review prompt | Original prompt returned to composer; send enabled; no new message was sent | Passed; compact-error-and-restored-prompt.png |
| Inspect auth | Details → inspect → close | Claude-specific sign-in instructions and original error remained available, closed by default | Passed; original run was not relabeled as a Codex auth failure |
| Load updated service | Visible Restart core action | Connection briefly showed an authorization error; visible Retry recovered. Newly introduced privacy choice appeared; sharing was left unchecked | Passed with friction; cache isolation subsequently added |
| Save defaults | Pick Codex again; inspect Settings → Agents | Save succeeded without a second error; Settings showed Codex as default | Passed; codex-saved-prompt-ready.png |
| Keep draft | Home → Close idea | Home listed the original idea; dialog explicitly kept its unsent draft. Home composer inherited Codex | Passed |
| Isolated agent test | Home → send a harmless “Reply only Ready; no file actions” prompt | GPT-6.1 Sol rejected by the Codex account after 1m47s. Failure remained compact with Choose model and Review prompt | Blocked on that model; codex-model-rejection-compact.png |
| Model recovery | Choose model → GPT-6 Astra → Review prompt → Send | Astra returned Ready, but the pre-fix parser incorrectly marked the run failed because of a changed-model advisory | Failed status reproduced; regression fixed, original record retained |
| Reload parser fix | Development-service restart, then visible Send | Reconnected without manual Retry; same conversation remained. Astra returned Ready in 11s without a failure marker | Passed; codex-reply-completed.png |
| Same-chat model switch | Picker → Codex → GPT-5.6 Sol → Send harmless test | Ready in 5s; changed-model advisory is one compact warning row with Details; run has no failure marker | Passed; model-switch-notice-and-success.png |
| Original request | Home → Close idea → original saved idea | Original Claude history and unsent user prompt retained; Codex selected with saved default GPT-5.6 Sol; no request submitted | Passed; original-draft-ready-unsent.png |

The development-service restart was explicitly disclosed test setup: a shell command stopped only the verified matching core process and its existing desktop supervisor restarted it. It was not counted as success through a hidden UI route. An earlier invalid-input endpoint probe could not save a preference; installed CLI model-list and saved-thread GET probes were read-only diagnostics, not UI acceptance. The saved-thread check confirmed Codex for both chats; the original thread's model is unset and resolves the saved Codex default, while the test thread stores GPT-5.6 Sol explicitly. No account credentials or security settings were changed. One isolated test draft is retained; the user's original request has not been submitted by this walkthrough.

## Verification and limits

- UI: 289 passed / 1,233 assertions; client: 390 passed / 1,827 assertions; agents: 105 passed / 1 platform skip / 496 assertions. Existing process and loopback tests initially failed in the sandbox because `ps`/binding were blocked; the permitted reruns passed. No old failure is assumed unresolved.
- Agents, client, UI and desktop typechecks passed. Final production desktop build passed; no emitted source maps. Diff check passed.
- Regression coverage includes an old service's missing defaults endpoint, failed conversation save, explicit model clearing, compact error details, draft/attachment preservation and narrow nonfatal advisory classification while preserving true failures.
- This account's GPT-6.1 Sol request failed despite the stale picker showing it. A read-only installed CLI catalog probe returned GPT-6 Astra as default and GPT-5.6 Sol/Terra/Luna. After reconnect/catalog refresh, the visible picker offered that list. Model availability is account/runtime-specific; no universal access claim.
- Successful Codex replies are not evidence of a generated circuit, native edits or electrical validation. No engineering action was requested in the smoke test. New project generation, media/export, other agent credentials, mobile and narrow-window acceptance were not retested here.
- The separate private-dependency CI checkout blocker is recorded in the local BUILD-FAILURE-20261103 note. This local production build does not claim remote CI success.

## Change list / resume

- [x] P1: Save the actual chat choice before changing its displayed agent; defaults failure must not strand the conversation.
- [x] P1: Preserve original diagnostics and unsent prompts; provide direct Switch agent / Choose model / Review prompt recovery.
- [x] P2: Reduce duplicated error copy and large cards; keep details available without occupying canvas space.
- [x] P1: Do not treat the exact successful changed-model advisory as a failed run; preserve genuine failures and historical records.
- [x] P2: Isolate old connection query errors on service replacement; service-restart retest required no manual Retry.
- [ ] Human acceptance remains specific to this tested desktop/profile. Other account/model combinations and broader app journeys remain separate.

Do not merge/deploy or restart the paused automation/keep-awake process as part of this milestone.
