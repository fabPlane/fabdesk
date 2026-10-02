# FreeCAD in fabPlane (`fab_cad`)

fabPlane's mechanical side: the project's enclosure, brackets and other parts live in a FreeCAD
document, `model.FCStd`, next to the board. Agents edit it through the `cad` toolset; the desktop
shows it live in the board panel's **CAD** tab.

Three repositories are involved:

| repo                                                    | what                                                                                                                                    |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| [fabPlane/FreeCAD](https://github.com/fabPlane/FreeCAD) | the FreeCAD fork. Adds `src/Api`: the FreeCAD API (`src/Api/PROTOCOL.md`), `FreeCADApiServer --listen ws://…`, and a WebAssembly build. |
| [fabPlane/fab_cad](https://github.com/fabPlane/fab_cad) | the web UI (FreeCAD's desktop frontend in the browser), `@fab-cad/{protocol,client,mock-server,bridge,freecad-wasm}`. `vendor/fab_cad`. |
| fabdesk (here)                                          | the `cad` toolset, the `CadService` over the bridge, the desktop's CAD tab and bridge supervisor.                                       |

It is the FreeCAD sibling of the FabPlane PCB integration (`docs/fab-pcb-migration.md`) and has the
same shape: a bridge per machine, one server process per project, core as a client of both.

```
agent ──MCP──► fabdesk-core ── cad_* tools ──► CadService (apps/core/src/fab-cad.ts)
                                                  │ HTTP  /health /sessions        (FabCadBridgeClient)
                                                  │ WS    /ws?session=…  FreeCAD API (@fab-cad/client)
                                                  ▼
desktop CAD tab ──iframe──► @fab-cad/bridge (127.0.0.1:4030) ──► FreeCADApiServer per project
  (fab_cad web UI, ?ws=…/ws?session=<the project's session>)        model.FCStd open in it
```

The agent and the CAD tab share one FreeCAD session per project: each gets its own upstream
connection, so FreeCAD's events show the agent's edits in the tab as they happen, and what a user
changes in the tab is in the document the next tool call reads.

## The `cad` toolset

`load_toolset {"toolset":"cad"}`. Every editing tool recomputes and then saves `model.FCStd`, so the
file on disk always matches the session.

| tool                 | what                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------- |
| `cad_status`         | bridge reachable, which FreeCAD it runs, the project's model summary                          |
| `cad_model`          | objects: name, label, type, recompute status, children, bounding-box size                     |
| `cad_properties`     | an object's properties (value, unit, expression, group)                                       |
| `cad_add_object`     | add `Part::Box`, `Part::Cylinder`, `PartDesign::Body`, … with properties                      |
| `cad_set_properties` | set values and bind expressions (`{"Width": "Lid.Length / 2"}`)                               |
| `cad_remove_object`  | remove (optionally recursively)                                                               |
| `cad_recompute`      | recompute + save, reporting objects that failed                                               |
| `cad_undo`           | undo / redo                                                                                   |
| `cad_export`         | STEP / IGES / BREP / STL / OBJ to `exports/<name>.<ext>`                                      |
| `cad_python`         | Python in the project's FreeCAD (sketches, pads, booleans, fillets): what the others don't do |
| `cad_view`           | the web UI URL attached to the project's session (what the CAD tab loads)                     |

Values use the FreeCAD API's JSON form: numbers in base units (mm, deg), strings with units
(`"25 mm"`), tagged objects (`{"$type":"Placement", …}`), see `PROTOCOL.md` in the fork.

`CadService` is optional in `CoreServices` (like `cloud` and `appBridge`); without a reachable
bridge the tools fail with `unavailable` and say how to start one.

## Sessions

`apps/core/src/fab-cad.ts` keeps one bridge session per project directory:

- `model.FCStd` exists → a session started on it (`POST /sessions {path}`), or the running one the
  bridge already lists for that path.
- It does not → a bare session; the document is created (`NewDocument`) and saved there.
- After a daemon restart, a bare session that has the model open is adopted rather than started
  again.
- A session the bridge lost (deleted, crashed, a restarted FreeCAD whose token changed) is
  reconnected once per call and reopens the saved model.
- `Part`, `Sketcher` and `PartDesign` are loaded on attach.

The bridge's `WORKSPACE_ROOT` must contain the projects directory (`FABDESK_PROJECTS_DIR`): session
paths are confined to it.

## Running it

| variable                     | where   | what                                                                              |
| ---------------------------- | ------- | --------------------------------------------------------------------------------- |
| `FABDESK_FAB_CAD_BRIDGE_URL` | core    | bridge origin; default `http://127.0.0.1:4030`                                    |
| `FABDESK_FAB_CAD_BRIDGE_TOKEN` | core  | bearer for the bridge (HTTP and the `/ws` upgrade); the desktop mints one per launch |
| `FAB_CAD_BRIDGE_TOKEN`       | bridge  | the token the bridge requires of non-browser callers (set by the desktop)        |
| `FABDESK_FAB_CAD_SOURCE`     | desktop | run the bridge from a fab_cad checkout under Bun (`bun run dev:cad` sets it)      |
| `FABDESK_FAB_CAD_BUNDLE`     | desktop | a packaged backend's `bundle.json`; default `resources/cad/bundle.json`           |
| `FREECAD_API_SERVER`         | bridge  | the FreeCAD API server command; with a source checkout, default is fab_cad's mock |

**Development.** `bun run dev:cad` starts the desktop with the bridge from `vendor/fab_cad`. With
no `FREECAD_API_SERVER` it runs fab_cad's mock server (Part primitives with real tessellation,
expressions, undo, STL/OBJ export; no Python, no STEP) — enough for the tools and the tab. For real
FreeCAD, build the fork's `FreeCADApiServer` and pass it:

```sh
FREECAD_API_SERVER=/path/to/FreeCAD/build/bin/FreeCADApiServer bun run dev:cad
```

The CAD tab needs fab_cad's web UI built into `vendor/fab_cad/apps/web/dist`. Build it in a
separate fab_cad clone (`bun install && bun run build`, fab_cad's own lockfile) and point the bridge
at it with `STATIC_DIR`, or copy the `dist` in; never run `bun install` inside `vendor/fab_cad`.
Without it the tab says so and the tools still work.

**Desktop.** `CadSupervisor` (`apps/desktop/src/main/cad-supervisor.ts`) starts the bridge before
core and hands core `FABDESK_FAB_CAD_BRIDGE_URL` and `FABDESK_FAB_CAD_BRIDGE_TOKEN`. The token is
32 random bytes (base64url), new every launch, given to the bridge as `FAB_CAD_BRIDGE_TOKEN`; core
sends it as `Authorization: Bearer` on HTTP and on the `/ws` upgrade, never in a URL (the `cad_view`
WebSocket and the web UI URL stay token-free; the web UI is same-origin). A bridge pointed at with
`FABDESK_FAB_CAD_BRIDGE_URL` keeps its own token: pass it in `FABDESK_FAB_CAD_BRIDGE_TOKEN`. A bridge
from before tokens ignores the header. It is optional: no bundle and no source checkout
means nothing starts, and a bridge that fails only disables the `cad` toolset (the PCB backend, by
contrast, is fatal). A bridge already on the port is reused only when it serves the same workspace
and accepts the token; otherwise a fresh loopback port is used, unless the URL was set explicitly.

**Doctor.** `fabdesk-core doctor` lists `fab-cad` next to `fp-pcb` in the bridges line; it is never
a warning.

## Native packaging

See [native-cad-packaging.md](native-cad-packaging.md) for the real engine build, dependency
closure, signing, source/notices and FCStd/STEP package smoke. `cad:stage` creates
`dist/cad/<target>/bundle.json`; `afterPack` requires and copies it to `Resources/cad`.
Packaged startup requires `engine: "native"` and ignores the development mock source.
The first validated target is macOS ARM64. Other targets require their own native runtime;
a missing runtime fails staging rather than omitting CAD.

## Pins and upstream state

- `vendor/fab_cad` is pinned at `65c72d69` (the merged security/viewer main tip). fab_cad now has `main`, bootstrapped at the previous default tip without rewriting history.
  The submodule currently has no `branch =`; bump its reviewed commit with
  `git -C vendor/fab_cad fetch && git -C vendor/fab_cad checkout <commit>`.
- `vendor/fab_cad/packages/protocol/FREECAD_COMMIT` pins the fork at `9bcf850`, which is on the
  fork's `claude/freecad-repos-ipc-wasm-53j8he` branch, not on its `main`. The `src/Api` work has to
  land on the fork's `main` before release builds come from it.
- `@fab-cad/{protocol,client,mock-server,bridge}` are root workspaces (the bridge and the mock are
  used by core's tests and by `dev:cad`); `bun run fab-cad:types` (part of `typecheck`) emits the
  client's declarations and `apps/core/tsconfig.typecheck.json` maps the imports to them, exactly as
  for `@fp-pcb/client`.

## In ChatGPT, Codex and Claude

The fabPlane Boards MCP App view (`board_viewer`, [mcp-extensions.md](mcp-extensions.md)) shows a
project's FreeCAD model in its CAD drawings tab: _Export FreeCAD model_ runs `cad_export` to
`exports/model.stl` and renders it, and _Open in FreeCAD_ opens this web UI on the project's
session through the host.

## Tests

- `apps/core/test/fab-cad.test.ts` runs `CadService` against the real `@fab-cad/bridge` with the
  mock as FreeCAD: create, edit, expressions, recompute, export, adopting a session after a restart,
  reconnecting after the bridge lost one, error mapping, release.
- `packages/tools/test/cad.test.ts` covers the tools over a fake `CadService`.
- `apps/desktop/src/main/cad-supervisor.test.ts` covers bundle/source resolution and starts the
  bridge from `vendor/fab_cad`.
