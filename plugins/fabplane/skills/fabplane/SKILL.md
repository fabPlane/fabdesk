---
name: fabplane
description: Work on fabPlane / fabdesk PCB projects - show boards, schematics, 3D and CAD drawings, edit the FreeCAD enclosure model, run build/route/DRC, and manage the fabplane.com shopping list and inventory. Use when the user mentions a PCB, board, schematic, KiCad file, DXF/STL/GLB drawing, BOM, parts to buy, or fabPlane.
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

## Tools

Only the core toolset is listed at first (`pcb_environment`, `project_status`, `circuit_build`,
`route_run`, `verify_drc`, `render_board`, ...). Call `load_toolset` with `project`, `render`,
`export`, `verify`, `shopping`, ... for more, or find one with `capability_search`.

- Board status: `project_status`. Checks: `verify_drc`, `verify_erc`.
- Drawings: `export_dxf` (per-layer DXF in `exports/dxf/`), `export_stencil` (3D-printed
  F.Paste / B.Paste stencil STL in `exports/stencil/`), `export_laser_stencil` (LightBurn
  `.lbrn2` + layered SVG/DXF), `render_glb` (3D board), then
  `board_viewer` with `view: "drawings"` or `"3d"`.
- Mechanical parts (enclosure, brackets): the `cad` toolset edits the project's FreeCAD model
  (`model.FCStd`): `cad_model`, `cad_add_object`, `cad_set_properties`, `cad_python`, ...
  `cad_export` with `format: "stl"` writes `exports/<name>.stl`, which `board_viewer` shows in
  the drawings tab (`drawing: "exports/model.stl"`); `format: "step"` is for fabrication.
- Shopping: load the `shopping` toolset. `shopping_list_get`, `shopping_list_sync_bom`,
  `shopping_list_add` / `_update` / `_remove`, `shopping_list_destinations`, `inventory_search`,
  `inventory_add`. Check `inventory_search` before buying parts the team may already have. These
  need a fabplane sign-in (fabPlane app: Settings -> Account).

Pass `project` (id, name or absolute path) unless the session was started inside a project folder.
