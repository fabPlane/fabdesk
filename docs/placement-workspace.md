# Placement workspace

Open a project and choose **Placement** in the board panel, or **Edit placement** in the PCB preview. This is a local draft editor for arranging native KiCad footprints, based on [TensorFleet/placement-lab](https://github.com/TensorFleet/placement-lab).

## A short workflow

1. Open the project's board, a local `.kicad_pcb`, or a saved `.placement.json` session.
2. Select a component and drag it. Scroll to zoom; hold Space and drag to pan. Shift-click or drag a selection box for multiple parts. Use the Parts inspector for exact coordinates, locks, groups, anchors, rotation, alignment and spacing.
3. Open Review to inspect overlaps, board-edge crossings and reserved areas. Preview better placement or overlap cleanup, inspect the dashed original outlines and changed-parts list, then apply or cancel. Connection priorities let you weight a selected net. Estimated connection length is a placement heuristic, not routed length or electrical validation.
4. Save draft to keep the editable session in `placement/draft.placement.json` in this project. Reopening the workspace restores it. Unsaved drafts survive tab/project switches in memory, and closing the renderer warns about unsaved drafts.
5. Export PCB creates a separate, uniquely named `placement/*-unrouted.kicad_pcb`. The source PCB and schematic stay unchanged. The export intentionally removes tracks, vias and copper zones: route it and run KiCad DRC before manufacturing.

The Board inspector previews board resizing and manages reserved areas. Optional spacing guidelines are advisory and disabled initially. A selected component can use a local `.kicad_mod` replacement with matching pad numbers; preview, cancel and undo are available, and existing pad net assignments are retained.

## Shortcuts

| Action | Shortcut |
| --- | --- |
| Zoom at pointer | Mouse wheel |
| Pan | Space + drag, middle drag, or Pan mode |
| Add to selection | Shift-click |
| Nudge | Arrow keys; Shift for five grid steps |
| Rotate selection | R |
| Focus selection / fit board | F / Home |
| Undo / redo | Ctrl/Cmd+Z / Ctrl/Cmd+Shift+Z |
| Navigate inspector tabs | Left/Right, Home/End |

## Boundaries and implementation

- Imports are limited to 20 MiB and 1,500 parts. Local footprint replacement is limited to 1 MiB.
- Parse, analysis, optimization, resize, exact spacing, replacement and export run in cancellable workers. Each job times out after 30 seconds. Improvement search has a 1.5-second search budget.
- Push on drop is limited to boards with at most 200 parts. Larger boards can use background overlap cleanup.
- Undo keeps at most 20 snapshots, with a target budget of roughly 16 MiB of serialized past snapshots (at least one snapshot is retained). Drafts and the current board also use memory.
- The UI loads lazily and uses the app's theme variables, a canvas viewport, keyboard controls, and a compact inspector layout.
- Engine provenance and local adaptations are recorded in `packages/client-core/src/placement/UPSTREAM.md`. The illustrative USB timer board is a test fixture, not an automatically created user project or a bundled footprint catalog.

## Validation

Client tests cover native board round trips, unchanged source geometry, footprint identity and net preservation, incompatible replacements, locks/anchors/groups, undo/redo, session migration, advisory guidelines, resizing and isolated drafts. Live desktop checks additionally exercise pointer drag, wheel zoom, pan, failed-save recovery, reload persistence, preview apply/cancel/undo, replacement and export. Placement findings are geometric checks; they do not replace KiCad DRC.
