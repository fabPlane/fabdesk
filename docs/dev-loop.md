# Dev loop: what reloads when

`bun run dev` (from `apps/desktop`) runs electron-vite. Three processes are involved; each reloads
differently.

| You edit… | What happens | State kept |
|---|---|---|
| `packages/ui/**`, `apps/desktop/src/renderer/**` | Vite HMR. React component modules swap in place; changes to plain modules (stores, renderers, the `@fabdesk/ui` barrel) fall back to a full page reload. | Zustand `ui` store is persisted (`localStorage` key `fabdesk.ui`): project, thread, board tab, drafts, panel layout survive reloads. Cinema frames do not (they are re-fetched from `/route/runs/:id/frames`). |
| `apps/core/**`, `packages/{tools,tscircuit,kicad,router,sim,agents,auth-client,protocol}/**` | The daemon runs under `bun --watch`: it restarts itself (~1 s) on a fixed dev port (`FABDESK_DEV_PORT`, default 47831) with the same token, prints a new ready line, and the Electron supervisor re-announces it. The renderer's SSE reconnects and queries refetch. | SQLite (threads, messages, runs, settings) persists. In-flight jobs, route runs, MCP sessions and running agent subprocesses are lost, same as a crash. |
| `apps/desktop/src/main/**`, `src/preload/**` | electron-vite rebuilds and restarts Electron. The core keeps running (its parent watchdog allows 30 s) and the new main attaches to it via `daemon.json`. | Everything in the core; renderer state per the persisted store. |

Options (environment variables for `bun run dev`):

- `FABDESK_CORE_RELOAD=watch` (default) restart on change; `hot` swaps modules in place with
  `bun --hot` (faster, keeps `Bun.serve` up, but Workers and module-level state can go stale — use
  when iterating on HTTP handlers); `off` for no reload.
- `FABDESK_DEV_PORT=0` for a random port per restart (the renderer follows automatically; external
  MCP configs won't).
- `FABDESK_CHANNEL=internal` to include the js_autorouter adapter.

Tips: the `core` badge in the top bar shows "core reloaded" briefly after a watch restart; a Route
Cinema run interrupted by a reload shows its persisted frames but no further updates — start a new
route. Unit tests are the fast loop for pure logic: `bun test` inside the package.
