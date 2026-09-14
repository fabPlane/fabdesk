# fabdesk-background-grace

iOS suspends an app within a second or two of it leaving the foreground; the WebSocket goes
quiet and `agent.done` never reaches JS, so the local "run finished" notification cannot fire.
This module asks iOS for background execution time (`beginBackgroundTask`) whenever the app
goes to the background and gives it back when the app returns or the budget runs out (~25 s).
Android needs nothing: JS keeps running in the background until the OS reclaims the process.

No JS API. Its presence is the feature.
