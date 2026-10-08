# fabPlane architecture

## Processes

```
┌──────────────────────────────┐        ┌──────────────────────────────────────────┐
│ Electron (apps/desktop)      │  HTTP  │ fabdesk-core (apps/core, Bun, compiled)  │
│  main: spawns core, IPC      │◄──────►│  Hono on 127.0.0.1:<random>              │
│  renderer: React UI, WebMCP  │  SSE   │  /projects /threads /tools /jobs /events │
└──────────────────────────────┘        │  /mcp  (streamable HTTP, per-session)    │
                                        │  SQLite (bun:sqlite) · job runner · bus  │
   claude / codex / grok / cursor ─────►│  fp-pcb bridge client · kicad-cli        │
                                        │  fab-cad bridge client (FreeCAD)         │
   (spawned by core, or external via    └──────────────────────────────────────────┘
    `fabdesk-core mcp` stdio bridge)
```

- **Electron is a thin client.** It owns the window, the OS integrations (open browser, file
  pickers, keychain later) and supervises the core process. All state lives in the core.
  Unpackaged `bun run dev` uses a separate "fabPlane Dev" identity (userData, lock, `FABDESK_HOME`,
  fixed core port) so it can run beside the packaged app; see [dev-loop.md](dev-loop.md).
- **fabdesk-core** is one Bun binary (`bun build --compile`). It runs the same whether the GUI
  started it or an external agent started it with `fabdesk-core mcp`. It authenticates every
  request with a bearer token handed over at spawn time (`FABDESK_TOKEN`) and recorded in
  `daemon.json` (0600) so other local processes can find and attach to it.
- **Agents are subprocesses.** The core spawns `claude -p`, `codex exec`, `grok -p` or the cursor
  `agent` in the project directory with an MCP config pointing at the core's `/mcp`. Every tool
  call is therefore visible to the UI regardless of which agent made it.

## Tool surface

`packages/tools` holds the single registry. Each tool is a zod-typed, deterministic handler.
Three adapters expose it: MCP (stdio and streamable HTTP), HTTP (`POST /tools/:name`, used by the
renderer and by WebMCP wrappers), and the AGENTS.md cheat-sheet written into every project.
Toolsets other than `core` are loaded on demand with `load_toolset` to keep agent context small.

## PCB pipeline

```
prompt / sketch ─► agent writes circuit.netlist.json ─► circuit_build (compile job on the FabPlane PCB bridge:
  ImportNetlist + autoplace into board.kicad_pcb) ─► route_run (route job on the bridge, progress streamed to the UI)
  ─► circuit.routed.json ─► kicad_convert (circuit-json-to-kicad) ─► board.kicad_pcb / .kicad_sch
  ─► verify_drc / verify_erc / verify_gate (kicad-cli --format json) ─► render_board (kicad-cli render)
  ─► export_* (gerbers, drill, pos, bom, netlist) · sim_run (circuit-json-to-spice → spicey / ngspice)
```

Routers run on the bridge: `capacity` maps to its built-in JS router; `freerouting` (its Freerouting adapter)
is offered only when `FABDESK_CHANNEL=internal`
and is never included in public artifacts.

## Mechanical model

`model.FCStd` in the project is a FreeCAD document, edited through the `cad` toolset over the
FabPlane CAD bridge (`vendor/fab_cad`, one `FreeCADApiServer` from the fabPlane FreeCAD fork per
project) and shown live in the board panel's CAD tab. Optional: without a bridge only the `cad`
toolset is unavailable. See [fab-cad.md](fab-cad.md).

## Auth

The core signs in to fabplane.com with the OAuth device-authorization grant and keeps the opaque
`fpd_…` token in `${FABDESK_HOME}/credentials.json` (0600). `FABDESK_AUTH_MODE=local` substitutes
a local principal; it is honored only in non-public channels or when `.fabdesk-dev` exists.
The desktop hides the staging password form and local mode on the sign-in screen unless the build is
an unpackaged dev build or the user presses the undocumented ⌘L / Ctrl+L reveal; switching local mode
on writes `.fabdesk-dev`, so the reveal works in packaged builds too. It is deliberately not listed in
Settings › Shortcuts.

Once signed in, portable settings (theme, default agent, runtime mode, error reporting,
notification prefs) last-write-wins to `GET`/`PUT /v1/private/settings` on the account. Binary
paths, remote access and keep-core-running stay on the machine. The phone has its own account
session in Settings (appearance / haptics / keep-awake) against the same document. Device
connectivity through that account is later work.

## Project on disk

`~/fabdesk/<slug>/` — `fabdesk.json`, `circuit.netlist.json`, `board.kicad_pcb`, `board.kicad_pro`,
`<name>.kicad_pcb|sch|pro`, `model.FCStd`, `sketches/`, `renders/`, `reports/`, `exports/`, `comments.json`,
`NOTES.md`, `AGENTS.md`, `CLAUDE.md`, `.fabdesk/runs/<runId>/frames.jsonl`. Pins and the shared notes
sheet are git-tracked; see [board comments](board-comments.md).
