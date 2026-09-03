# App automation: driving the desktop window from an agent

The `app` MCP toolset lets an agent connected to the `fabdesk` MCP server screenshot and drive the
Electron window without OS-level computer use: find elements, click, type, switch project / tab /
thread, send chat messages through the real composer, and control Route Cinema.

## How it fits together

```
agent ──MCP──▶ fabdesk-core (app_* tools, packages/tools/src/tools/app.ts)
                    │  AppBridgeClient (apps/core/src/app-bridge.ts)
                    │  reads <userData>/app-bridge.json, bearer = daemon token
                    ▼
             Electron main: automation bridge (apps/desktop/src/main/automation{,-server}.ts)
                    │  http://127.0.0.1:<random>  GET /state  POST /screenshot /eval /click /type /key /ui  GET /find
                    ▼
             renderer: window.__fabdeskApp (apps/desktop/src/renderer/automation.ts)
                    zustand stores + composer handlers → the same code paths the user exercises
```

- **Electron main** starts a Node `http` server on `127.0.0.1` at a random port and writes
  `${userData}/app-bridge.json` (`{ url, pid, startedAt }`, mode 0600, atomic rename) next to
  `daemon.json`; the file is removed on quit. Screenshots use `webContents.capturePage`; clicks and
  keys are real input events (`webContents.sendInputEvent`) so React handlers fire; `/eval` runs in
  the renderer main world with a 64 KB / 10 s guard.
- **Renderer** installs `window.__fabdeskApp` only when the preload reports
  `automationEnabled` (main passes `--fabdesk-automation`). It exposes `state()`, `find()`,
  `selectProject()`, `openTab()`, `openThread()`, `newChat()`, `setComposer()`, `send()`,
  `sendMessage()`, `openSettings()`, `cinema.{setView,seek,goLive,toggleLayer,load}` and `waitFor()`
  (string predicates for `app_wait_for` are compiled in main and polled through `executeJavaScript`,
  since the renderer CSP has no `unsafe-eval`).
- **Core** exposes an `AppBridge` on `CoreServices` (`apps/core/src/services.ts`). The client
  locates the file next to the handshake (`FABDESK_APP_BRIDGE_FILE` overrides), checks the pid is
  alive, and forwards requests. Every `app_*` tool returns an `unavailable` error with instructions
  when no bridge is running.

`GET /tools/manifest` (WebMCP) picks the tools up automatically; only `app_state`,
`app_screenshot`, `app_find` and `app_wait_for` are `readOnlyHint`, so the write tools stay
hidden from WebMCP unless `settings.webmcpWriteTools` is on.

## Security model

- Loopback only: the server binds `127.0.0.1`, rejects non-loopback peers and any browser
  `Origin` that is not `localhost` / `127.0.0.1`.
- Bearer auth with the daemon token (`FABDESK_TOKEN`, the same secret in `daemon.json`), compared
  in constant time. Until the core is ready every request is `401`.
- Off in packaged builds unless `FABDESK_AUTOMATION=1` is set in the app's environment; on in dev
  (`bun run dev`). `FABDESK_AUTOMATION=0` disables it in dev too.
- The bridge file is `0600`; the renderer API never sees the token (`window.__fabdeskRuntime`
  carries the client and status only).
- `app_eval` is marked destructive + open-world; treat it as a debugging tool.

## Enabling in a packaged build

```bash
FABDESK_AUTOMATION=1 open -a Fabdesk            # macOS
FABDESK_AUTOMATION=1 ./fabdesk                  # Linux
```

Then check `~/Library/Application Support/@fabdesk/desktop/app-bridge.json` (or the platform's
`userData`). The core the app spawns picks the file up on the next tool call; no restart needed.

## Tools

| tool | what it does |
| --- | --- |
| `app_state` | app version, windows, renderer UI snapshot (project, thread, board tab, cinema, auth, core) |
| `app_screenshot` | image of the window or a `region` (CSS px); `scale` 0.1–1 (default 0.5), `format` png/jpeg |
| `app_find` | interactive/labelled elements matching a query; returns `ref` selectors for `app_click` / `app_type` |
| `app_click` | click a `selector` (ref) or `x,y`; `<option>` refs select the option in their `<select>` |
| `app_type` | type text with key events, optionally focusing `selector` first |
| `app_key` | press an accelerator: `Enter`, `Escape`, `CommandOrControl+K`, `Shift+Enter` |
| `app_select_project` | make a project (id, name or path) active in the UI |
| `app_open_tab` | schematic, pcb, cinema, 3d, drc, renders, files |
| `app_open_thread`, `app_new_chat` | switch threads / start a fresh chat |
| `app_send_message` | put text in the composer and send through the UI (creates the thread, starts the agent run) |
| `app_cinema` | `view` (board/activity), `seek`, `live`, `layer`, `load` (replay a persisted run id) |
| `app_wait_for` | poll a JS predicate over `state` / `document` until truthy |
| `app_eval` | run JavaScript in the renderer (dev only) |

## Example Claude Code session

```
> load_toolset {"toolset":"app"}
Toolset "app" enabled…

> app_screenshot {}
[image 720×460]

> app_find {"query":"Route Cinema"}
| ref | role | name | text | … |
| #root > … > button:nth-of-type(3) | tab | Route Cinema | Route Cinema | … |

> app_click {"selector":"#root > … > button:nth-of-type(3)"}
Clicked … at (612, 58).

> app_find {"query":"whole board"}
| select:nth-of-type(2) > option:nth-of-type(2) | option | whole board | … |

> app_click {"selector":"select:nth-of-type(2) > option:nth-of-type(2)"}
Clicked … (option selected via its <select>).

> app_screenshot {"region":{"x":600,"y":80,"width":800,"height":600},"format":"png"}
```

Or skip the DOM: `app_open_tab {"tab":"cinema"}` and `app_cinema {"action":"view","mode":"board"}`
do the same through the stores.

## Testing

- `apps/desktop/src/main/automation-server.test.ts`: routing, guards and input synthesis against a
  fake window (no Electron).
- `apps/desktop/src/renderer/automation-core.test.ts`: element ranking, CSS paths, UI snapshot
  (no DOM).
- `packages/tools/test/app.test.ts`: the tools against a fake `AppBridge`.
- `apps/core/test/app-bridge.test.ts`: `AppBridgeClient` against a local HTTP stub.
