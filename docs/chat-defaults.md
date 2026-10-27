# New chats and agent preferences

## Project selection

Desktop New Chat opens a project picker. Choose an existing project, create one,
or import one from GitHub. Canceling the picker leaves the current conversation
open. A project can have multiple conversations; each chat does not require a new
project.

Without a project, the composer keeps the draft and attachments but disables Send.
Enter and the global send shortcut reopen the project picker instead of creating
a projectless thread. Thread creation also checks the project as a final guard.
The composer waits for an existing conversation to load before allowing sends.

The control API still supports scratch threads for existing integrations and
historical conversations. The project requirement applies to starting a new chat
through the desktop composer.

## Remembered agent and model

Explicitly choosing an agent/model in the composer saves it for future new chats.
The same selection path is used by desktop automation. Settings shows these saved
defaults, which are stored in the daemon's existing SQLite settings database.
Reloading the renderer or restarting the daemon does not require choosing again.

`PUT /settings/agent-preference` accepts `{ agentId, model }`, where `model: null`
uses the agent's default. It atomically updates `defaultAgent` and that agent's
configured model while preserving binary paths, permissions, model lists and all
other agents. Invalid preferences do not change settings. The existing cloud
settings callback is notified just as it is for other settings changes.

The client waits for the save before allowing another selection or send, cancels
older settings fetches before updating the cache, and reports save failures.
Viewing an old conversation does not overwrite the saved defaults. Existing
threads retain their own agent/model, and refreshing an unchanged thread does not
undo a selection made in its composer.

There is currently no separate reasoning-effort control in the desktop app. This
change does not modify the agents' native effort configuration. A packaged update
was not installed as part of validation; persistence uses the same database and
settings fields as before, without a migration or reset.
