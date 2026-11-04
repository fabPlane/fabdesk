# Placement workspace

Open a project and choose **Placement** in the board panel, or **Edit placement** in the PCB preview. This is a local draft editor for arranging native KiCad footprints, based on [TensorFleet/placement-lab](https://github.com/TensorFleet/placement-lab).

## A short workflow

1. Open the project's board, a local `.kicad_pcb`, or a saved `.placement.json` session.
2. Select a component and drag it. Scroll to zoom; hold Space and drag to pan. Shift-click or drag a selection box for multiple parts. Use the Parts inspector for exact coordinates, locks, groups, anchors, rotation, alignment and spacing.
3. Open Review to inspect overlaps, board-edge crossings and reserved areas. Preview better placement or overlap cleanup, inspect the dashed original outlines and changed-parts list, then apply or cancel. Connection priorities list every net, with highlighted-net-only and reset actions. You can disable rotation in suggestions. Estimated connection length is a placement heuristic, not routed length or electrical validation.
4. Save draft to keep the editable session in `placement/draft.placement.json` in this project. Reopening the workspace restores it. Edits also get a project-scoped recovery copy on this device, with compression/IndexedDB fallback for larger drafts. Download session makes a portable JSON copy. Unsaved drafts survive tab/project switches in memory, and closing the renderer warns about unsaved drafts.
5. Export PCB creates a separate, uniquely named `placement/*-unrouted.kicad_pcb`. The source PCB and schematic stay unchanged. The export intentionally removes tracks, vias and copper zones: route it and run KiCad DRC before manufacturing.

Resize using the board's bottom-right handle or exact dimensions in Board. Turn off **Adjust placement when resizing** to retain component positions. Draw a reserved rectangle on the canvas, or add one from Board; edit its name, side, geometry and margin, and use Locate area to focus it. Optional spacing guidelines remain advisory.

The Parts inspector includes editable value/angle, position swap, numeric anchor offset, a geometry preview, connected neighbors and the nearest same-side envelope gap. **+ Footprint** opens the same 42-item KiCad catalog as Placement Lab. Compare dimensions, pin 1 and pad-to-net mappings, filter to matching pads, import a local `.kicad_mod`, or drag a library item onto empty board space to add it / onto a part to replace it. New parts are unconnected; compatible replacements retain existing numbered-pad nets. Every addition/replacement is previewed before apply and can be undone.

**Enclosure / STL** generates a case from the current placement. Adjust outline offset, clearance, vents and snap fits, then inspect the plan/isometric preview and download base STL, lid STL or STEP. The snapshot and generated models live under `placement/`, leaving the original PCB, existing enclosure and FreeCAD model unchanged. Heights and connector dimensions are estimated; inspect the model before printing.

## Shortcuts

| Action | Shortcut |
| --- | --- |
| Zoom at pointer | Mouse wheel |
| Pan | Space + drag, middle drag, or Pan mode |
| Add to selection / select all visible parts | Shift-click / Ctrl/Cmd+A |
| Nudge | Arrow keys; Shift for five grid steps |
| Rotate selection | R |
| Focus selection / fit board | F / Home |
| Undo / redo | Ctrl/Cmd+Z / Ctrl/Cmd+Shift+Z |
| Navigate inspector tabs | Left/Right, Home/End |

## Boundaries and implementation

- Imports are limited to 20 MiB and 1,500 parts. Local footprint replacement is limited to 1 MiB.
- Parse, analysis, optimization, resize, exact spacing, replacement and export run in cancellable workers. Each job times out after 30 seconds. Improvement search has a 1.5-second search budget.
- Live neighbor pushing and live gap computation are limited to boards with at most 200 parts. Larger boards can use background overlap cleanup.
- Undo keeps at most 60 snapshots, with a target budget of roughly 16 MiB of serialized past snapshots (at least one snapshot is retained). Drafts and the current board also use memory.
- The UI loads lazily and uses the app's theme variables, a canvas viewport, keyboard controls, and a compact inspector layout.
- Engine provenance and local adaptations are recorded in `packages/client-core/src/placement/UPSTREAM.md`. The USB timer and connectors/cutout examples are opt-in choices. The 42-footprint catalog loads lazily; its KiCad library license is retained.

## Validation

Client tests cover native board round trips, unchanged source geometry, footprint identity and net preservation, incompatible replacements, locks/anchors/groups, undo/redo, session migration, advisory guidelines, resizing and isolated drafts. Live desktop checks additionally exercise pointer drag, wheel zoom, pan, failed-save recovery, reload persistence, preview apply/cancel/undo, replacement and export. Placement findings are geometric checks; they do not replace KiCad DRC.

Full feature inventory, matching numeric outcomes, real comparison screenshots and remaining integration limits: [Placement Lab parity check](placement-parity.md).
