# Integration notes

## 1. DRC severity

`kicad-cli pcb drc --severity-all` also reports violations the project marks ignored or excluded ("Intentional Overlap") as ordinary
errors. The Python oracle runs without that flag. Every board-workflow tool now runs `runLiveDrc` (`packages/tools/src/tools/common.ts`):
`severity: "project"` (no severity flag) and any `excluded` item dropped from the JSON, which is what `drcInputFromFile` does for
the edit stage. Used by `board_check`, the layout scoring and courtyard gate (`board_route`), `board_edit`, `board_release` and
`board_lastmile`.

Stage-1 parity, cm5_minima `proj2`, live DRC (harness `packages/board-workflow/test/parity-stage1.ts`, `--no-stress`):

| A2 errors | oracle DRC (no flag) | live, project severity + excluded dropped | live, `--severity-all` (old path) |
|---|---|---|---|
| courtyards_overlap | 1 | 1 | 2 |
| copper_edge_clearance | 2 | 2 | 2 |

19 of 19 rows agree (all of A1-A9 fields, onboard, and "live project-severity A2 equals oracle A2"). The layout stage's unexplained
"A2 courtyards_overlap 1 oracle vs 2 TS" is this same flag: `--severity-all` counted the owner-excluded overlap. (The earlier edit-stage
note of 4 vs 3 courtyard errors is the same effect on a different count basis; that count was not reproduced here.)
