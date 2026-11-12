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

## Not measured
`rank` and `route` (KRT/TraceMaker routing) were not run: they wait for the orchestrator's go for heavy jobs. They are covered by unit tests
with fake engines (`layout.test.ts`: ranking order, hedge, TraceMaker one-at-a-time admission, STOP above `lastmile_max_open`, skip when TraceMaker is not installed).
