# Ten boards across desktop and phone — what broke, what was fixed (2026-09-13)

Ten retro-console boards from the youtube plan (`~/projects/tensorfleet/youtube/ideas/retro-pcb-projects.md`),
each started on one device and finished on the other, with a different split every time. The
desktop was the `fabPlane Dev` app driven through its automation bridge; the phones were the
Android emulator (until host load froze it) and the AYN Thor over LAN; the daemon was the dev
profile's, the bridge a fab_pcb checkout at the vendor pin with the KiCad fork nightly
`20260912-5e09a6e3be` (the local fork build no longer starts: Homebrew's protobuf moved from 32 to
36). Everything below landed on `boards/desktop-mobile-fixes`.

| # | Board | Started | Finished | Outcome |
| --- | --- | --- | --- | --- |
| 1 | PS1 serial dev dongle | desktop (netlist) | phone (build → route → DRC → render) | built; 59 router errors; agent hand-edited the board for 16 min before the guidance existed |
| 2 | GB link USB bridge | phone (project, netlist, build) | desktop (route) | 41 parts; router thrashed 45 min, stopped from the API |
| 3 | PS1 PIO breakout | desktop (netlist, build) | phone (route, export) | passive 68-net board; router `HB ran out of iterations` |
| 4 | Famicom expansion adapter | phone (everything) | desktop (export) | first board placed with `circuit_place`; routes 39/39 with the corner placement, fails with a sane one |
| 5 | SMS flash cart | desktop (netlist, build, place) | Thor (route, DRC, 3D) | placed like a real board; route 5 min, 149 router errors; 3D exported |
| 6 | Dreamcast serial SD | Thor (everything) | — | 84/84 routed, 8 router errors; agent hit the rotation bug |
| 7 | NES UNROM flash cart | desktop (netlist, build, supervised on) | Thor (place, route) | question answered on desktop, Edit approved on Thor; 3 router errors |
| 8 | GBA multiboot adapter | Thor (photo attachment, netlist, build) | desktop (place, route) | photo uploaded to `sketches/`; desktop showed neither message nor photo until fixed |
| 9 | N64 Controller Pak | desktop (all) | phone (review) | in flight at time of writing |
| 10 | Genesis flash cart | Thor (netlist, build) | desktop (place, route) | in flight at time of writing |

## Fixed on the branch

Cross-device state (both clients, `packages/client-core`):

- **Stale desktop after a daemon restart** — SSE reconnected but nothing refetched. `useCoreEvents`
  invalidates every query when the stream reopens (the rule the phone had locally now lives in one place).
- **Runs the client never saw** — a thread started on the other device, or a renderer reload mid-run,
  left a disabled Send, no Stop, and dropped deltas (the store could not map runId → thread). New
  `GET /runs/live`; both clients sync the live-run store on every stream open.
- **Runs killed by a restart** stayed "working · 20m / Stop" on the phone forever; the sync above ends
  them, and the phone marks the cut-off tool call "interrupted" with a footer saying what happened.
- **Messages missing on the other device** — a thread first seen through events had a fresh, one-message
  cache; the user's own message (and photo) never appeared. The first seed schedules a fetch.
- **Deleted projects** came back after a restart (manifest re-adopted) and lingered on the other
  device (no event). Forgetting renames the manifest; deletion is announced.
- **Thread titles** were the first 60 characters, cut mid-word, and the desktop set them itself so the
  daemon's naming (and its `thread.updated`) never ran. The daemon names every thread by its opening clause.

Design tooling (`packages/tools`, `apps/core`, `packages/kicad`):

- **`circuit_search_parts` was dead** (`GetLibraryTables: AS_UNHANDLED`): the api-server registers
  library handlers only once a project is open. The shared library session gets a scratch project;
  multi-word queries match token by token.
- **No way to move a part** — the autoplacer corner-packs and leaves connectors across the outline;
  the agent tried every guessed netlist key, then hand-edited the board. `circuit_place` rewrites the
  footprint transform in the saved file (children are relative there; the API's `UpdateItems` moves
  only the anchor, fab_pcb G28), turns child angles with it, and reloads the board. Verified by render.
- **Board size changes did nothing** — a build never redraws an outline that exists and the session
  holds the board in memory. `circuit_build {fresh: true}` wipes the slate.
- **Route Cinema sat on "waiting for frames…"** for every run: the bridge's `progress` events carry
  no job id and were rejected by the schema, and the JS router reports only phase/percent, which
  produced no frames. Both fixed; the canvas is still empty because the router streams no geometry.
- **`app_eval` let the agent restart the daemon** (`window.fabdesk.restartCore()` through the bridge),
  failing every live run. Off unless `FABDESK_APP_EVAL=1`; the app toolset blurb tells the agent it is
  for acting on the UI, not diagnosing routes.
- **26 orphaned `kicad-cli api-server` processes (5 GB)** after an afternoon: nothing deleted a bridge
  session. Project deletion and daemon shutdown now release them.
- **`renders/pcb.svg` was an A4 sheet** with the board in a corner (phone viewer showed a thumbnail);
  cropped to the board.
- The per-project `AGENTS.md` tells the agent to check placement, use `circuit_place`, never hand-edit
  the board, and to report router-caused DRC errors instead of repairing tracks.

Phone (`apps/mobile`):

- Negative run timer when the phone's clock lags the daemon; chat search dropped the keyboard after one
  letter (the whole screen swapped for a spinner per keystroke); empty-board copy sent people to the desktop.

Desktop (`apps/desktop`, `packages/ui`): automation actions hung while the window was occluded
(rAF never fires); `app_screenshot` returned stale frames; user bubbles now show phone-attached photos.

## Still open

- **The autorouter.** Every board with a fine-pitch part fails DRC; coarse boards fail outright or
  non-deterministically. Cases, one-command reproduction and failure classes:
  [`router-issues.md`](router-issues.md). With `circuit_place` in hand the router is now the only thing
  between the agent and a fabbable board (board 7: 3 errors, all router).
- **Autoplacer**: still corner-packs and puts tall parts across the outline; the agent now fixes it by
  hand with `circuit_place`, which costs a round of queries per board. Placement hints in the netlist
  (`components[].at`) belong in fab_pcb's compile.
- **Dev-mode restarts kill runs.** `bun --watch` restarts the daemon on any core-side edit and every
  live agent run dies with no error text (`runs` has no error column). Three runs were lost this way
  while fixing other things; a `guard` that refuses edits while `GET /runs/live` is non-empty is the
  workaround. Worth a `runs.error` column and an "interrupted by restart" message.
- **Cinema without geometry**: the JS router streams no shapes; the cinema shows phase/percent text
  on an empty canvas and `done: 0/0 routed` because `RouteResult.complete` is always `[]`.
- **Thor landscape**: bottom pills/rows on the project screen sit under the Android nav bar; Gboard
  still goes fullscreen for every field.
- Emulator on a loaded host: System UI ANR / system_server restart while another agent ran Freerouting
  benches (load average 160+). Not ours; the Thor was unaffected.
- **Interrupted runs on the desktop** show no footer yet (the phone does); the desktop reuses the same
  `ThreadDetail` and can grow the same note.
- Board 5's SMS cart, board 2's RP2040 board and board 3's breakout are worth re-running once the
  router agent lands something: their netlists are in `docs/router-cases/`.
