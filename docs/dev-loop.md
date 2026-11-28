# Dev loop: what reloads when

`bun run dev` runs electron-vite (through `scripts/dev.ts`, which adds the PCB backend below). Three processes are involved; each reloads
differently.

`bun run dev` from the repository root also starts the PCB backend (board editing, compiling,
routing) when it can find a bundle for this platform: first under
`apps/desktop/release/**/resources/pcb/bundle.json`, then inside an installed fabPlane (for example
`/Applications/fabPlane.app/Contents/Resources/pcb`). It prints which one it chose, and starts without
a backend when there is none. `FABDESK_DEV_PCB=0` skips this; an explicit
`FABDESK_FP_PCB_BUNDLE=/absolute/path/to/bundle.json`, `FABDESK_FP_PCB_BRIDGE_BIN` or
`FABDESK_FP_PCB_BRIDGE_URL` is left alone. Developers do not run the Linux image build to start
Fabdesk. `bun run dev:pcb` is the strict form: it fails when no bundle is found and always uses the
isolated development profile. To iterate on the bridge/router itself while reusing the bundle's
KiCad runtime and libraries, add `FABDESK_FP_PCB_SOURCE=/path/to/fab_pcb`; Fabdesk then runs the
bridge from that checkout and owns its lifetime too.

| You edit…                                                                   | What happens                                                                                                                                                                                                                                                         | State kept                                                                                                                                                                                                     |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/ui/**`, `apps/desktop/src/renderer/**`                            | Vite HMR. React component modules swap in place; changes to plain modules (stores, renderers, the `@fabdesk/ui` barrel) fall back to a full page reload.                                                                                                             | Zustand `ui` store is persisted (`localStorage` key `fabdesk.ui`): project, thread, board tab, drafts, panel layout survive reloads. Cinema frames do not (they are re-fetched from `/route/runs/:id/frames`). |
| `apps/core/**`, `packages/{tools,kicad,sim,agents,auth-client,protocol}/**` | The daemon runs under `bun --watch`: it restarts itself (~1 s) on a fixed dev port (`FABDESK_DEV_PORT`, default 47831) with the same token, prints a new ready line, and the Electron supervisor re-announces it. The renderer's SSE reconnects and queries refetch. | SQLite (threads, messages, runs, settings) persists. In-flight jobs, route runs, MCP sessions and running agent subprocesses are lost, same as a crash.                                                        |
| `apps/desktop/src/main/**`, `src/preload/**`                                | electron-vite rebuilds and restarts Electron. The core keeps running (its parent watchdog allows 30 s) and the new main attaches to it via `daemon.json`.                                                                                                            | Everything in the core; renderer state per the persisted store.                                                                                                                                                |

Options (environment variables for `bun run dev`):

- `FABDESK_CORE_RELOAD=watch` (default) restart on change; `hot` swaps modules in place with
  `bun --hot` (faster, keeps `Bun.serve` up, but Workers and module-level state can go stale — use
  when iterating on HTTP handlers); `off` for no reload.
- `FABDESK_DEV_PORT=0` for a random port per restart (the renderer follows automatically; external
  MCP configs won't).
- `FABDESK_CHANNEL=internal` to offer the bridge's Freerouting router.
- A FabPlane PCB bridge on `http://127.0.0.1:4020` (or `FABDESK_FP_PCB_BRIDGE_URL`) for `circuit_build` / `route_run`: `KICAD_SRC=<kicad fork> bun run --filter @fp-pcb/bridge start` in a `fab_pcb` checkout.
- `FABDESK_DEV_PROFILE=1` forces the isolated "fabPlane Dev" identity on a packaged nightly;
  `FABDESK_DEV_PROFILE=0` forces the production identity even when unpackaged.
- Unpackaged runs show the app icon with a "DEV" band. `FABDESK_DEV_ICON=0` shows the plain icon
  (screen recordings); it does not change the app name or the data folders.

## Running next to an installed fabPlane

Unpackaged `bun run dev` is **fabPlane Dev**: a separate Electron identity so it can stay open
alongside the packaged production app (same idea as VS Code Insiders). Isolation, applied before
the single-instance lock and any `userData` read:

|                                       | Production (packaged)        | fabPlane Dev (`!app.isPackaged`, or `FABDESK_DEV_PROFILE=1`) |
| ------------------------------------- | ---------------------------- | ------------------------------------------------------------ |
| Name / window title                   | fabPlane                     | fabPlane Dev                                                 |
| `appUserModelId`                      | `com.tensorfleet.fabdesk`    | `com.tensorfleet.fabdesk.dev`                                |
| userData (lock, `daemon.json`, prefs) | `~/.config/fabPlane` (Linux) | `~/.config/fabPlane Dev`                                     |
| Core home (SQLite, credentials)       | `~/.config/fabdesk`          | `~/.config/fabdesk-dev` (`FABDESK_HOME`)                     |
| Core port                             | random                       | `FABDESK_DEV_PORT` (default 47831)                           |
| Linux WM_CLASS                        | fabPlane                     | `fabplane-dev`                                               |

Production paths are unchanged. An explicit `FABDESK_HOME` is left alone. Each identity still
allows only one instance of itself.

Tips: the `core` badge in the top bar shows "core reloaded" briefly after a watch restart; a Route
Cinema run interrupted by a reload shows its persisted frames but no further updates — start a new
route. Unit tests are the fast loop for pure logic: `bun test` inside the package.

## Driving the app from an agent

In dev the Electron main process also runs the app automation bridge (loopback HTTP, bearer = the
daemon token) and writes `<userData>/app-bridge.json` next to `daemon.json`. Any MCP client on the
`fabdesk` server can then `load_toolset app` and use `app_screenshot`, `app_find` / `app_click`,
`app_send_message`, `app_cinema`, … to look at and drive the running window; the tools go through
the same stores and composer handlers as the user. It restarts with Electron (main/preload edits)
and survives core reloads (the file is re-read on every call). Details, security model and the
packaged-build switch (`FABDESK_AUTOMATION=1`): [app-automation.md](app-automation.md).
