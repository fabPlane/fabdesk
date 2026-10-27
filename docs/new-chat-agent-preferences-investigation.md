# New Chat Bug & Default agent effort saving

Investigation only; no application behavior changed. Checked on Windows against
`519cc3c` on 2026-10-27 using the local desktop development build.

## 1. Chats can start without a project

**Confirmed:** New Chat opens a project picker with an explicit **Continue without
a project** action. Choosing it opens the composer while the board workspace says
**No project selected**. This was reproduced in the running app without sending a
message or starting an agent run.

The send path also permits this state:

- `packages/ui/src/chat/ProjectPickerDialog.tsx` calls `choose(null)`.
- `packages/ui/src/chat/Composer.tsx` checks message content and sending state,
  but does not require a project before creating a thread or queueing a message.
- `packages/ui/src/chat/ThreadView.tsx` passes the nullable active project ID to
  thread creation.
- `packages/protocol/src/api.ts` allows an omitted or null `CreateThread.projectId`.
- `apps/core/src/http/app.ts` rejects a nonexistent supplied project, but accepts
  no project. `apps/core/src/agent-runs.ts` uses `scratch/<threadId>` as the working
  directory when there is no project.
- `packages/ui/src/stores/ui.test.ts` explicitly covers a null project selection.

Projectless chats are deliberately supported by the current implementation.
Requiring a project would therefore change that behavior. The reported downstream
board failures have not yet been reproduced; permitting a projectless chat alone
does not prove those failures.

Proposed requirement: before sending the first message, require choosing an
existing project or creating/importing one. A fresh project should not be required
for every conversation. Dismissing the picker must not bypass that requirement.

## 2. New Chat does not remember the last agent/model choice

**Confirmed in the running app:** an existing conversation displayed
**Codex: GPT-6 Astra**. Clicking **New chat** switched the composer to
**Claude: Opus 5 (1M)**. Choosing **Continue without a project** retained Claude.
Returning to the original conversation restored Codex / GPT-6 Astra.

In `packages/ui/src/chat/Composer.tsx`, the agent/model picker only calls local
React state setters. It does not persist the selection as a preference. When
there is no thread, initialization and the thread/settings effect instead use
`settings.defaultAgent` and that agent's configured model. The schema default in
`packages/protocol/src/api.ts` is `claude`; the separate default-agent control in
`packages/ui/src/settings/SettingsDialog.tsx` can change the saved default.

This explains why the next new conversation can revert to Claude instead of the
last-used agent. It is not invariably Claude: it follows the saved default. The
same initialization path is used when the composer mounts again. An application
upgrade was not performed, and loss of saved settings during an update has not
been established.

Proposed requirement: persist an explicit agent/model selection and use it for
subsequent new chats and restarts, while preserving existing threads' own agent
and model. Verify preference retention across an actual update separately.

## Effort and follow-up validation

The title also mentions effort. No dedicated reasoning-effort selection field was
found in the desktop composer picker or the app's agent settings schema during
this inspection. An effort-reset bug has not been independently confirmed; its
intended control and persistence behavior should be defined before implementation.

Validation for eventual fixes should cover project-picker cancellation, selecting
an existing project, project creation/import, agent/model selection followed by a
new chat and restart, and reopening an existing chat. Define effort-specific
coverage when its behavior is specified.

This investigation used source inspection and desktop UI navigation. No agent
messages were sent, existing project files were not changed, and the original
conversation was restored. Automated tests were not run for this documentation-only
change.
