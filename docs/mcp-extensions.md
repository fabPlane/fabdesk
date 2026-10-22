# fabPlane in ChatGPT, Codex and Claude (MCP Apps + OpenAI MCP Extensions)

Fabdesk's MCP server ships interactive views that MCP Apps hosts render next to the conversation,
and uses the [OpenAI MCP Extensions](https://github.com/openai/mcp-extensions) so they also show up
as native features in ChatGPT and Codex: a sidebar entry, a thread tab, a file handler for board and
CAD files, and composer @-mentions. Everything is plain MCP underneath; hosts that do not know an
extension ignore its metadata.

Code: `packages/tools/src/adapters/mcp-apps.ts` (registration), `packages/tools/src/apps/*` (the
views and the DXF converter). Plugin package: `plugins/fabplane/`.

## What is exposed

| Tool                   | Visible to  | View                    | OpenAI entrypoints                                                                |
| ---------------------- | ----------- | ----------------------- | --------------------------------------------------------------------------------- |
| `board_viewer`         | model + app | `ui://fabdesk/boards`   | sidebar (`global`), thread tab, file: `.kicad_pcb .kicad_sch .dxf .svg .stl .glb` |
| `shopping_list_viewer` | model + app | `ui://fabdesk/shopping` | sidebar (`global`), thread tab                                                    |
| `fabdesk_ui_call`      | app only    |                         | the views' single door into the server                                            |
| `search_mentions`      | app only    |                         | `openai/extensions` `mentions/search`: projects, shopping lists and CAD files     |

**fabPlane Boards** (`board_viewer`): project picker, DRC / route badges, and four tabs:

- **PCB** and **Schematic**: KiCad SVG exports (cached in `renders/`, re-rendered when the KiCad file
  is newer or on _Re-render_), pan / zoom / pinch, multi-sheet schematics.
- **3D**: `renders/board.glb` (exported on demand) in a three.js orbit viewer.
- **CAD drawings**: DXF, SVG, STL and GLB files under `exports/`, `renders/`, `mechanical/`, `cad/`
  and `enclosure/`. DXF is converted to SVG on the server (`dxfToSvg`: LINE, CIRCLE, ARC,
  LWPOLYLINE with bulges, POLYLINE, SPLINE control polygon, SOLID/TRACE/3DFACE, POINT; text, blocks
  and dimensions are listed as not drawn). _Export DXF_ runs `export_dxf`. _Export stencil_
  runs `export_stencil` (F.Paste apertures → `exports/stencil/F-Paste.stl`). _Export laser stencil_
  runs `export_laser_stencil` (LightBurn `.lbrn2` + layered SVG/DXF).
- **FreeCAD** ([fab-cad.md](fab-cad.md)): for a project with a `model.FCStd`, _Export FreeCAD model_
  runs `cad_export` (STL to `exports/model.stl`) and shows it in the 3D viewer, and _Open in
  FreeCAD_ asks the host to open the fab_cad web UI on the project's live session (`cad_view`,
  `ui/open-link`). Both need the FreeCAD bridge; without it they report `unavailable`.
  _Generate enclosure_ runs `cad_enclosure` from the board outline, mounting holes and edge
  connectors (STL/STEP even when FreeCAD is down).

Buttons run _Run DRC_ (`verify_drc`, parity only when the project has a schematic) and _Ask agent_
(`ui/message`). Selecting a project sends `ui/update-model-context`, so the next turn knows which
`project` to pass. Deep links: `…/app/board_viewer?path=%2Fproject%2F<id>%2F<pcb|schematic|3d|drawings>`.

**Shopping List** (`shopping_list_viewer`): the project's fabplane.com cart grouped by destination,
with inline quantity / destination / status edits, remove, _Sync from BOM_, a quick-add row,
team-inventory search, _Open on fabplane.com_ and _Ask agent to source_. It needs a fabplane
sign-in, like the `shopping` toolset.

**Resources** added for mentions: `fabdesk://project/{id}/shopping-list` (JSON) and
`fabdesk://project/{id}/files/{path}` (a CAD file; `path` URL-encoded, jailed to the project, CAD
extensions only).

The views call only the tools in `UI_CALLABLE_TOOLS` (status, DRC, DXF / stencil / GLB export, the
shopping tools and `cad_status` / `cad_export` / `cad_view` / `cad_enclosure`) plus four view helpers (`projects`, `preview`, `host_file`, `convert`), whatever
toolsets the session has loaded.

## When the views are listed

`attachToRegistry(..., { apps })`:

- `auto` (default): registered disabled, enabled once the client's `initialize` advertises
  `capabilities.extensions["io.modelcontextprotocol/ui"]`. Terminal agents that do not render MCP
  Apps (Claude Code, Codex CLI, Grok) keep the lean core list.
- `on`: always listed. `fabdesk-core mcp --apps`, or `/mcp?apps=on` over HTTP.
- `off`: `?profile=native` and `?profile=substrate` (fabPlane's own agent) and `toolsOnly` servers.

The stdio proxy (`fabdesk-core mcp` while the app runs) reads the host's `initialize` and re-opens
its daemon session with `?apps=on` when the host supports MCP Apps, so `auto` works through the
proxy too.

## OpenAI extensions used

- **Entrypoints** (`_meta["openai/ui"].entrypoints`): `global` and `thread` open with `{}`; the view
  then fetches the project list itself. `file` passes `{ file: { name, resourceUri } }`; the view
  calls `fabdesk_ui_call host_file`, and the host adds the opened file's absolute path as
  `_meta["openai/resource"].path`. KiCad files are rendered to SVG in a temp dir; DXF / SVG / STL /
  GLB are read directly. Hosts without the path hint fall back to `resources/read` of the opaque
  URI.
- **Display modes**: `_meta["openai/ui"].availableDisplayModes: ["inline", "fullscreen"]` on the UI
  resources.
- **Model context titles**: `_meta["openai/title"]` on the context text block.
- **Messages**: `ui/message` for the _Ask agent_ buttons.
- **Composer mentions**: `search_mentions` returns `resource_link` items.
- **Onboarding**: the plugin's `extensions["com.openai"].onboardingSkill`.
- **Icons**: `serverInfo.icons` carries a 20×20 `currentColor` SVG, the fallback for entrypoint icons.

Not used yet: structured settings (`openai/settings`) and extended form elicitation.

## Security notes

- The only external origin is `https://cdn.jsdelivr.net` for three.js, declared in the boards view's
  `_meta.ui.csp.resourceDomains`. 2D views work without it. The shopping view declares no domains.
- Views render SVG through `<img src="data:…">`, so SVG scripts never run, and build the DOM with
  text nodes (no `innerHTML`).
- `host_file` accepts only an absolute path supplied in `_meta["openai/resource"]` and only the
  viewer's file extensions, up to `MAX_PREVIEW_BYTES` (24 MB). Any authenticated MCP client can
  send that `_meta`, so it can read files of those types that the daemon user can read.

## Installing the plugin

The desktop app must be installed and `fabdesk` on `PATH` (`fabdesk-core install-cli`); see
[mcp-install.md](mcp-install.md).

**Codex** (the repo is a Codex marketplace: `.agents/plugins/marketplace.json`):

```bash
codex plugin marketplace add TensorFleet/fabdesk --sparse .agents/plugins --sparse plugins
# or from a checkout
codex plugin marketplace add /path/to/fabdesk
```

Then install **fabPlane** from the plugin directory. Its server runs `fabdesk mcp --apps`; the
onboarding skill checks the setup and opens fabPlane Boards.

**Claude Code** (`.claude-plugin/marketplace.json`):

```text
/plugin marketplace add TensorFleet/fabdesk
/plugin install fabplane@fabplane
```

**ChatGPT, Claude Desktop and other MCP Apps hosts** without the plugin: add `fabdesk mcp` as a
local MCP server (or the HTTP endpoint from `daemon.json`); the views appear automatically for
hosts that advertise MCP Apps. Add `--apps` if a host renders views but does not advertise the
extension.

## Trying the views locally

Any MCP Apps host works. The views are self-contained HTML (`resources/read ui://fabdesk/boards`)
that speak the MCP Apps postMessage protocol (`ui/initialize`, `tools/call`, `ui/message`, …), so a
test host only has to answer `ui/initialize`, send `ui/notifications/tool-input` and
`…/tool-result`, and forward `tools/call` / `resources/read` to the server.
