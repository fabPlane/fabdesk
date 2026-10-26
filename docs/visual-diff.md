# Visual board revision diff

The board panel's **Diff** tab compares two git revisions (or the worktree) of
the current project. It writes `reports/board-diff.json` plus SVG overlays under
`renders/diff/`. Unchanged copper stays muted; added geometry is green and
removed geometry is red. Structured mode lists part, net, and track changes.
Overlay and side-by-side modes draw the generated SVGs.

This replaces the earlier checkpoint-based prototype (fabdesk #239). Versions
are git refs, not `.fabdesk/revisions/` snapshots. The worktree is a valid
`from`/`to` ref, so unsaved files still compare.

## Pieces

| Layer | Where | What |
| --- | --- | --- |
| Parse | `packages/board-diff` | Snapshots from `board.kicad_pcb`, schematic, and netlist. Copper geometry from the #239 parser lives in `kicad-pcb.ts`. |
| Tool | `packages/tools/src/tools/board-diff.ts` | `board_diff` lists revisions and compares two refs. |
| View | `packages/ui/src/board/DiffTab.tsx` | Picks revisions, runs the tool, and shows structured / overlay / side-by-side SVGs. |
