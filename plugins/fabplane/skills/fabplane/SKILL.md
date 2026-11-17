---
name: fabplane
description: Work on fabPlane / fabdesk PCB projects - show boards, schematics, 3D and CAD drawings, edit the FreeCAD enclosure model, run build/route/DRC, take a placed board to release with the board workflow (board_check, board_route, board_edit, board_review, board_silk, board_release, board_job), and manage the fabplane.com shopping list and inventory. Use when the user mentions a PCB, board, schematic, KiCad file, DXF/STL/GLB drawing, BOM, parts to buy, or fabPlane.
---

# fabPlane

The `fabdesk` MCP server drives fabPlane projects (KiCad boards managed by the fabPlane app).

## Show things with the views

Hosts that render MCP Apps (ChatGPT, Codex, Claude) show interactive views:

- `board_viewer` opens **fabPlane Boards**: PCB and schematic as zoomable SVG, the 3D board, and
  CAD drawings (DXF, SVG, STL, GLB) under `exports/`, `renders/`, `mechanical/`, `cad/`,
  `enclosure/`. Arguments are optional: `project`, `view` (`pcb`, `schematic`, `3d`, `drawings`),
  `drawing` (project-relative path).
- `shopping_list_viewer` opens the project's fabplane.com **Shopping List**: lines grouped by
  purchase destination, editable quantity / destination / status, BOM sync and inventory search.

Open a view when the user wants to _see_ a board or the list. For analysis, call the regular tools
and answer in text; the view reflects the same files. When the user acts in a view, its selection
arrives as context naming the project (`project="..."`): pass that to the tools.

## Board workflow

A project with a placed board is taken to a releasable one with the `board_*` tools. Started in
such a project folder (or with `fabdesk mcp --project <dir>`), the session lists them from the
start, as fabPlane's own agent sees them; elsewhere, `load_toolset {"toolset":"board"}`. The server
instructions repeat the stages; the full method is the resource `fabdesk://docs/board-workflow`
and the prompt `board_workflow` (the same text fabPlane's agent reads in AGENTS.md).

| Stage | Tool |
| --- | --- |
| 1 onboard + check | `board_check`: requirements on first use, then the A1-A9 checks of the saved board |
| 2 layout | `board_route` check · place · rank · route · auto · status |
| 3 last mile | `board_route` new · try · loop · sweep · pairs · why · crossings · fit · validate · accept |
| 4 edit | `board_edit`: an ECO as a plan, proven before it is adopted |
| 5 review | `board_review`: whole-board review bound to one design hash |
| 5b silkscreen | `board_silk` |
| 6 release | `board_release`: BOM, Gerber check, readiness, the fabrication package behind its gates |

- **Done** is the board's own acceptance checks **A1-A9** passing (connectivity, DRC, parity,
  circuit, anchors, stack, widths, pairs, heights), measured by `board_check` against the
  requirements written at onboarding. Owner intent lives in `.fabdesk/board/review/intent.json`;
  ask the owner only for what it does not decide.
- Engines a stage needs (routers, KiCadRoutingTools) install on demand; a call that cannot get one
  names it.
- **Long calls return a job id.** Board jobs keep running; `board_job {"jobId": "..."}` waits for
  the result (`status`, `cancel`, `list` as `action`). Outside fabPlane's own runs, a call returns
  the id after about 50 s so it stays within the host's tool timeout; keep calling `board_job`.
- `board_check` replaces `verify_drc` for a placed board; `route_run` stays the single autoroute of
  the live board.

## Other tools

Without a placed board, the core, circuit, verify and render toolsets are listed at first
(`pcb_environment`, `project_status`, `circuit_build`, `schematic_edit`, `route_run`,
`verify_drc`, `render_view`, ...). Call `load_toolset` with `project`, `export`, `shopping`,
`board`, ... for more, or find one with `capability_search` (and run it with `capability_call` in
hosts that do not refresh the tool list).

- Board status: `project_status`. Checks before a board is placed: `verify_erc`, `verify_drc`.
- Drawings: `export_dxf` (per-layer DXF in `exports/dxf/`), `export_stencil` (3D-printed
  F.Paste / B.Paste stencil STL in `exports/stencil/`), `export_laser_stencil` (LightBurn
  `.lbrn2` + layered SVG/DXF), `render_glb` (3D board), then
  `board_viewer` with `view: "drawings"` or `"3d"`.
- Mechanical parts (enclosure, brackets): the `cad` toolset edits the project's FreeCAD model
  (`model.FCStd`): `cad_model`, `cad_add_object`, `cad_build_part`, `cad_kernels`, `cad_python`, ...
  `cad_export` with `format: "stl"` writes `exports/<name>.stl`, which `board_viewer` shows in
  the drawings tab (`drawing: "exports/model.stl"`); `format: "step"` is for fabrication.
- Shopping: load the `shopping` toolset. `shopping_list_get`, `shopping_list_sync_bom`,
  `shopping_list_add` / `_update` / `_remove`, `shopping_list_destinations`, `inventory_search`,
  `inventory_add`. Check `inventory_search` before buying parts the team may already have. These
  need a fabplane sign-in (fabPlane app: Settings -> Account).

Pass `project` (id, name or absolute path) unless the session was started inside a project folder.

Task done means the request scope is met. A single edit or task stops after its requested change is saved, its checks pass and previews are published once. A request broader than one edit or task must leave the board complete: everything placed and routed, checks and acceptance A1–A9 passing, previews published. Intermediate edits do not end that broader request. Report board completion separately from task completion. Review and release are still only recommended. Report stale stages and recommend once, then end the turn in plain text without a blocking what-next card. Only explicit review, release or fabrication finish requests authorize those stages.
