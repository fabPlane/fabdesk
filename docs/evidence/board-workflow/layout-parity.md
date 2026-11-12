# Layout stage parity (cm5_minima, 112 parts)

Oracle: `flow/flow.py init/check/place` at `/home/shane/pcb-worktrees/heldout`. TypeScript: `@fabdesk/board-workflow` layout stage.
Harness: `packages/board-workflow/test/parity-layout.ts` (not in `bun run test`). Same spec file (the toolkit's onboard output), KRT build
`krt-c6-20261110`, seeds 0-3, kicad-cli-nightly. Raw rows: `parity.json` per run.

## check (run 1 and run-place)
| Row | Result |
|---|---|
| verdict (`PASS check`) | agree |
| info: footprints 112, nets 221, segments 0, fixed 46, groups 4, pairs 18 | agree |
| fails, warns | agree (both empty) |
| groups derived from the board (4 groups, refs) vs the toolkit's onboard `groups.json` | agree |
| escape keep-outs (4 rects) vs onboard spec | agree |
| fixed-part regex (46 parts) vs onboard spec | agree |

## place, seeds 0-3
| Row | Result |
|---|---|
| seeds count (4) | agree |
| placer crossings/cost/wire per seed (601/5075, 1076/11078, ..., identical to the digit) | agree |
| verdict text | DIFFERS in one word ("re-run place" vs "run place again") in the STOP line; otherwise same |
| gate results | **DIFFER** (see below) |

Oracle run: every seed gate false, courtyards_overlap 27/29/32/25, verdict `STOP no seed passed the gates`; 165 s wall.
First TypeScript run (a faithful port of `block_pass.set_pose`): same four overlap counts (27/29/32/25) and same STOP. The counts agree.

Cause (found by this comparison): `block_pass.set_pose` edits only `(transform (translate ..)(rotate ..))`. cm5_minima is written with
`(at x y rot)` poses, so the oracle's transfer turns the footprints but never moves them: the gated board is the base with rotations
changed, not the placer's board. My own decision: `setPose` also handles the `(at ..)` spelling. With that fix (second run,
`run-fixed`, 146 s wall) all four seeds gate true with 0 courtyard overlaps, verdict `PASS place 4/4 gated, 4 kept for rank`;
`away` lists differ from the oracle's because they are computed on the moved board (U402 TRD2_P for seed 0, etc.).
So `place` verdict and gate rows differ from the oracle on this board, and the oracle's are the wrong ones on this file format.
Not verified: that the oracle's flow on a transform-format board (the other format) agrees with the TS one; the unit tests cover both spellings.

## Oracle bug: `block_pass.set_pose` on `(at ...)` boards

`tools/block_pass.py set_pose` rewrites only `(transform (translate x y) (rotate r))`. On a board whose footprints carry
`(at x y rot)` (cm5_minima `onboard/base`), `transfer` turns each footprint (and its child angles) but never moves it, so the
gated board is the base with changed rotations, not the placer's board. Observed on cm5_minima, seeds 0-3, oracle and a
faithful TS port both: courtyards_overlap 27 / 29 / 32 / 25, every gate false, `STOP no seed passed the gates`.
With `setPose` handling `(at ...)` (my decision): 0 / 0 / 0 / 0 overlaps, all four gate true, `PASS place 4/4 gated`.
The oracle's `(at ...)` gate results are therefore wrong, not the TS ones; the rows above are listed as DIFFER.

## place on a `(transform ...)`-format board (checked)

Same board (cm5_minima `proj2/board.kicad_pcb`, 112 `(transform (translate)(rotate)(scale 1 1))` footprints), copper stripped, fixed
parts locked, 11 missing courtyards added with the oracle's `add_courtyards.py` (not ported) so check can pass. Seeds 0-3, harness
`--stages check,place` (`run-tf-b`): **8/8 rows agree** (check verdict/info/fails/warns; place verdict `PASS place 4/4 gated, 4 kept for
rank`, seeds count, gated seeds, per-seed gate/crossings/cost/why/away/kept). Wall 154 s (oracle) vs 124 s (TS).
Without the courtyards the check agrees too (both FAIL on the same 11 parts; only the fix hint text differs: the oracle names
`tools/add_courtyards.py`). Finding while doing this: TS `convertTransforms` first missed `(scale 1 1)` and newline-formatted transform nodes;
fixed and unit-tested.

## Not measured
`rank` and `route` (KRT/TraceMaker routing) were not run: they wait for the orchestrator's go for heavy jobs. They are covered by unit tests
with fake engines (`layout.test.ts`: ranking order, hedge, TraceMaker one-at-a-time admission, STOP above `lastmile_max_open`, skip when TraceMaker is not installed).
