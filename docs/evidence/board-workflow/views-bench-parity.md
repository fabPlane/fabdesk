# Board workflow: cable reach, board page, change picture and bench tools, parity with the Python toolkit

Date 2026-11-13. Oracle: `~/pcb-worktrees/heldout` (`flow/cablepath.py`, `tools/board_page.py`, `review/diff.py`,
`flow/editbench.py` `tasks` / `table`, `tools/pairbench.py`, `review/review.py` `cmd_bench`). The review bench ran on a scratch
copy of the toolkit (it writes its runs into the kit) with the replay board configs pointed at the copy's boards. kicad-cli
`/usr/bin/kicad-cli-nightly` 10.99.0 on both sides, one job at a time. No router was run.

| Tool | Port | Harness | Inputs | Result |
| --- | --- | --- | --- | --- |
| `pcb cable` | `review/cable.ts`, `board_review cable` | `test/parity-cable.ts` | vaio `io-c6/review/eco95/chassis.json` (3 frames incl. face-down mirror), `chassis-owner.json`, `chassis-sens.json` (9 frames); again with `--pcb C6=io-c6/release/C6-eco95/C6.kicad_pcb`; sweeps C6:C18_J401 right and front, C6:A74_J2 right | 31 frame x cable results identical (verdict, required, slack, turns, run, dz, flags, mouths, normals) and every printed line, both runs; 141 sweep rows identical (pose, slack per frame) |
| `board_page.py` | `review/page.ts`, `board_review page` | `test/parity-page.ts` | C6 release (8 copper layers: the toolkit's own table), full page with `--no-3d`; cm5_minima and vme-wren per layer through the toolkit's own `plot` and `drc_items`; DRC report from one kicad-cli run per board | C6: view box, 13 layers (names, colours, defaults, opacity, SVG bodies), 707 DRC errors, opens, score identical; cm5 11 layers / 27 errors, vme 17 layers / 41 errors identical |
| `pcb diff` | `review/diff.ts`, `board_review diff` | `test/parity-diff.ts` | C6 -> C6-eco95 (+4781/-3541 tracks, 302 parts moved), b2245 -> b22451 (USB-C fix), b81 -> b83, cm5 vs itself; with and without `--layers F.Cu,B.Cu` | summary lines and page text identical; SVG elements identical as a multiset (the toolkit draws from Python sets, so its order changes run to run); standalone SVG identical the same way |
| `editbench tasks` | `bench/editbench.ts` `writeEditTasks` | `test/parity-bench.ts` | cm5_minima and vme-wren, onboarded by the TypeScript side, same spec for both | 6 plans each (remove, value, move, swap, add, net), field for field identical |
| `editbench table` | `bench/editbench.ts` `editTable` | `test/parity-bench.ts` | the toolkit's C6-eco95 `tries/` and `fixes/` editbench results (11, and 22 with `runs/`) | markdown and JSON identical |
| `pairbench` | `bench/pairbench.ts` | `test/parity-bench.ts` | `board_metrics`, `nonpair_items` collateral and `table` on C6 -> C6-eco95 (C6 requirements, 13 pairs), cm5 (18 pairs) and vme (5 pairs) | metrics, item counts, collateral and the table identical |
| `pcb review bench` | `bench/review-bench.ts`, `scripts/bench.ts review` | `test/parity-bench.ts` | the 7 replay boards (a387, b2245, b22451, b81, b82, b83, c6silk), the same LCSC cache on both sides | 12/12 caught on both sides, the same finding ids per escape; clean boards: b83 1 (`L3:DECAP:U2:-`), b22451 0 on both |

## Fixes the comparison found

- `review/diff.ts`: `.3f` / `.2f` ties rounded up (`87.3125` -> `87.313`, Python `87.312`); the page CSS was a rewrite of the toolkit's
  text; moved distances printed `3` where Python prints `3.0`. All three fixed; the page is now the toolkit's.
- `accept.ts` `pyRound(x, 0)`: every exact `.5` rounded away from zero (the last-digit index read the decimal point). Half-even now.
- `review/geometry.ts` `mouthOf`: the pose rotation is taken `% 360` as the toolkit's board model does (`cos(-90)` and `cos(270)` differ in
  the last bit); `pose` overrides it for the cable sweep.
- `editbench table`: result files are sorted part by part as Python sorts paths (`a/x` before `a-b/x`), and numbers the toolkit wrote as
  floats (`75.0`) keep their `.0` (read with the JSON source text).

## Differences on purpose

- Board page: the toolkit's layer list is its 8-layer board's (In1..In6); kicad-cli writes nothing for a layer the board lacks, so the
  toolkit fails on any other board. The port plots the board's own copper (the toolkit's colours for the names it lists). A failed 3D
  render is a note, not an error. Owner-excluded DRC items are left out. Net names and labels are escaped in the page script; the
  presets "All signal" and "Inner" use the board's copper. A doctype and charset lead the page so a file opened from disk reads its UTF-8.
- Cable: board paths resolve against the tool's `root` (default the project), the toolkit's against its `PCB_REPO`. The tool reads only
  `.kicad_pcb` files for the chassis.
- Escape replay: the replay boards are not shipped (21 MB of other projects' boards); the board list is (`data/review/bench-boards.json`).

## Not compared

- 3D renders (images); pairbench's runner (a last-mile `try` of pair actions per board): it runs pair actions through the step engine and
  scorer, and no router or KRT run was made for this comparison; its metrics and table are compared, the runner is unit-tested.
