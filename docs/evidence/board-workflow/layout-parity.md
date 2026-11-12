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

## rank and route on cm5_minima (measured, machine otherwise idle)

Workspace: the `(at ...)`-format base, seeds 0-3 all gated (see above). KRT `krt-c6-20261110`, TraceMaker 0.12.1.

**The oracle could not score this board at all.** `route_krt.py --score` ends with "is in the pre-10 file format (tracks name nets by
number)": this KRT build writes KiCad 9-style `(net 178)` on tracks (net table `(net 178 "NAME")`), and the oracle's check
(`LEGACY_ITEM_NET`) also trips on the zones' `(net 97)`. So there are no oracle `flow rank`/`flow route` figures for this board.
My own decision: `nameCopperNets` rewrites the numeric net reference of routed copper to the net name before merging, and `scoreRoute`
refuses a merged board that still has numeric copper nets. Measured effect: the first TS rank run, before this fix, scored A8 = 0 on every
seed (it measured nothing: copper named by number matched no pair net) while open counts were right (KiCad reads both spellings).
After the fix A8 is 20-30. Cross-check on the same merged board for seed 0: the oracle's `check_acceptance.py` (run on a copy whose zone
`(net N)` lines were joined to the previous line so its guard passes) gives A1 18, A7 0, A8 20 (7 pairs uncoupled, 6 over skew), the same as TS
(18 / 0 / 20, 7, 6). A2 courtyards_overlap: oracle 1, TS 2 (copper_edge_clearance 2 both); not explained.

rank (4 seeds, `jobs 2`, KRT, `rank.json` plan): wall 286 / 546 / 359 / 359 s per seed.
| seed | open | A8 nets | A7 nets |
|---|---|---|---|
| 0 | 18 | 20 | 0 |
| 1 | 31 | 21 | 0 |
| 2 | 22 | 21 | 0 |
| 3 | 27 | 30 | 0 |
Verdict `PASS rank best seed 0 open 18`. Oracle on seed 0 alone (`route_krt.py` same plan): routed (stage exit 0) in 4 m 31 s, then failed at scoring (above).

route (best seed 0), one run, `PASS route best open 16 A8 22 A7 0`, wall 1028 s, lowest available memory during the run 16.6 GiB
(start about 23-24 GiB, so roughly 7 GiB of system memory in use at peak by everything the run started; sampled every 2 s):
| branch | open | A8 | A7 | DRC types (A2) |
|---|---|---|---|---|
| rank-f (KRT finish of the rank route) | 18 | 20 | 0 | courtyards_overlap 2, copper_edge_clearance 2 |
| rank-f-g (fine finish) **winner** | 16 | 22 | 0 | same |
| tm (TraceMaker session + CLI) | 16 | 36 | 0 | same |
| tm-f / tm-f-g (KRT finish after TM) | 16 / 16 | 36 / 36 | 0 | same |
rank-f-g and tm tie on open; the key then prefers fewer A8 nets, so the KRT branch wins. Verdict is PASS (16 <= `lastmile_max_open` 25).
A1-A9 of the winner: A1 fail (16 open), A2 fail (the 4 DRC findings above), A3 not measured (parity off for scoring, so the 0 is "unchecked"),
A4 A5 A6 pass, A7 pass, A8 fail (22 nets), A9 pass. TraceMaker session (both): 76 connections routed, open_after 0, unconnected 142
after refill; CLI `routed 171/172 connections, 680 tracks, 154 vias`.

**Second oracle gap, found by this run:** the oracle's TraceMaker CLI step passes `--no-tracks-on ""` when the board has no plane layers
(`acceptance.stack_policy.no_track_layers` is `[]` here) and TraceMaker rejects it: `"" is not a copper layer`. Oracle `route_pipeline.py`
(8 m 48 s wall) ran the session stage and then died on the missing CLI board; its session responses are identical to TS (routed 76, open_after 0,
unconnected 142). The first TS route run failed the same way (`TraceMaker wrote no board`); my fix omits the flag when the list is empty.
The oracle also crashes when the placed base has no `.kicad_dru` and the acceptance keeps native project rules (it copies the file
unconditionally); I gave it an empty one for the comparison. TS skips a missing rules file.

Not measured: vme-wren, jetson (not allowed); rank with the 8-seed default; any repeat of route for run-to-run spread.

## Unit tests
`rank` and `route` are also covered by unit tests with fake engines (`layout.test.ts`: ranking order, hedge, TraceMaker one-at-a-time admission, STOP above `lastmile_max_open`, skip when TraceMaker is not installed).
