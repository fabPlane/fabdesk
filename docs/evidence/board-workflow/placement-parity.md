# Board workflow, placement methodology: parity with the Python toolkit

Date 2026-11-13. Oracle: `~/pcb-worktrees/heldout/tools` (`placement_check.py`, `block_inventory.py`, `floorplan_run.py`,
`block_pass.py`, `route_region.py`, `block_eval.py`, with what they use from `check_acceptance`, `tp_legalise` and
`convert_tracemaker`). Port: `packages/board-workflow/src/layout/placement.ts`, `blocks.ts`, `floorplan.ts`, `blockeval.ts`,
`blockstage.ts`, `src/lastmile/replace.ts`. Harnesses (not part of `bun run test`; Python toolkit with numpy, no router, no
kicad-cli): `test/parity-placement.ts`, `test/parity-floorplan.ts`, `test/parity-region.ts`. Unit tests: `test/placement.test.ts`,
`test/floorplan.test.ts`. The owner built C6 with these tools (`~/vaio_p_modding/io-c6/docs/placement-routing-workflow.md` §2-3);
the real inputs are its floorplans and blocks (`review/c6-route85`, `review/c6-see87`) and recorded runs (`~/vaio-io-fresh/work`).

## placement_check and block_inventory (parity-placement.ts)

The toolkit hard-codes C6: outline 74.9 x 65.4 mm at the origin for the via-site grid, ground `IO_GND`, fixed parts
`_(J|SW)\d|^FIT_`, anchors `.*_(U|IC)\d`, the C6 height screen. C6 runs the toolkit files unchanged. For cm5 and vme a copy of the
script gets that board's outline, ground net, fixed pattern (its layout spec) and heights file in their place, which is the
substitution the TypeScript takes as options; nothing else changes. Compared: the whole output JSON after parse.

| Board | placement_check | block_inventory |
| --- | --- | --- |
| C6 placed-E2 (route85), blocks route85 | agree (274 nets, 24 rotation candidates) | agree, split C18-io, A7.4, C6-integration: 25 blocks |
| C6 release board, blocks floorplan84 | agree | agree, split A7.4 and C6-integration (the owner's split): blocks equal |
| C6 placed-E2 with A74_U9 +180, A74_U10 +90, C18_IC201 +270, A74_U1 +90 | agree, C18_IC201 flagged (turn 90 saves 21.2 %) | - |
| cm5_minima | agree (94 nets) | agree, split USB, IO, CM5_MINIMA_3, PCIe-M2: 12 blocks |
| cm5_minima with U405, U702, U401 turned | agree | - |
| vme-wren | agree (1304 nets, 108 candidates; Python 13 s, TS 0.8 s) | agree, split power-supply-1, clocks, io_driver, ddr4-ps: 89 blocks |

Rotation ties. When a turn changes nothing (a resistor network on wide nets), the four costs are equal and differ only in the last
bit: the toolkit sums a part's nets over a Python set and keeps `min()`'s first minimum, so it names 0 or 90 by float noise
(C18_FL202 on the turned C6: 77.780004 at 0, 77.78000399999999 at 90). The port names the first turn within 1e-9 mm. The harness
compares such a row as a tie only when both sides report saving 0.000 and equal HPWL (one row on the turned C6); a tie never flags.

Arithmetic follows the Python: radians as `deg * (pi / 180)`, float floor division as CPython does it (`1 // 0.1 == 9`), round half
even, numpy's pairwise mean. Also found: C6's C18_IC201 is written `(transform (translate ..) (scale 1 1))` without `(rotate)`;
the toolkit's `block_pass.pose` finds no pose there (a transfer would crash). The port reads 0 degrees and writes the rotation on a
turn.

deriveGroups against block_inventory (the inventory said deriveGroups replaces it). They are different partitions: on C6 the
release board's 12 deriveGroups groups hold 295 parts, of which 221 share their group's majority block (165/295 against the
25-block split); cm5 29/66, vme 782/1464. deriveGroups groups by anchor IC over the whole board for the KRT placer; a floorplan
is written in blocks (a sheet, or an anchor IC inside a split sheet). So block_inventory is ported, not replaced.

## floorplan_run and block_pass (parity-floorplan.ts)

Both sides run the same stand-in for tracemaker-place (a script the harness writes); native courtyard DRC is a stand-in that
reports nothing; the final test-point step is left out of both (the edit stage's `legalise` has its own parity). The toolkit
runs from a copy of its tools folder whose `config.json` points TraceMaker at the stand-in.

- **H2 replay**: the owner's `floorplan-H2.json` on `base88` with `blocks.json` (route85), seed 2: the stand-in copies the placer
  output TraceMaker wrote in the recorded run `work/c6-see87/placed-H2/tm` for each pass, so the poses that come back are real
  TraceMaker poses (10 passes, 275 parts, 17 test points left to the legalise step).
- **disp-V6 grid**: `floorplan-disp-V6.json` (two sub-groups with `of: display` and explicit parts, C18_IC201 pinned, a per-group
  clearance of 0.25 mm): the stand-in moves every unlocked footprint of the pass input onto a grid from where it stands, turning
  each by 90 degrees.

| Case | Exit | Placer arguments | Pass records | Pass inputs (`-in`, `-pass`) as data | Final board |
| --- | --- | --- | --- | --- | --- |
| H2 replay (10 passes, 275 parts) | both ok | equal | equal | 20/20 equal (locked set, every pose, keep-out rectangles) | byte for byte (2 847 426 bytes) |
| disp-V6 grid (12 passes, 274 parts) | both ok | equal | equal | 24/24 equal | byte for byte (2 847 602 bytes) |

The pass inputs differ as text only: the toolkit's `convert_tracemaker` re-dumps the board on one line and inserts
`(locked yes)` inline; the port keeps KiCad's layout (`convertTransforms`, `lockFootprints`). The placer reads the same data.
Unit tests (`floorplan.test.ts`) cover the failure paths with a stand-in placer: a part outside the group that moves fails the
pass, native courtyard findings stop the run, unknown refs, and the floorplan validation messages.

## route_region --replace and block_eval (parity-region.ts)

Region rip: route_region's rip (every segment, via and arc with a point in a region, all nets) and its `prune_dangling`, the
toolkit's own functions with the 10-line selection loop of its `main()` copied verbatim, against `regionRip`.

| Board | Regions | Removed (segment / via / arc, pruned) | Ripped board |
| --- | --- | --- | --- |
| C6 release/C6-eco95 | display + charger regions of floorplan-H2 | 1963 / 302 / 0, 360 | byte for byte |
| C6 release/C6-eco95 | usbc_out region | 630 / 103 / 0, 428 | byte for byte |
| cm5_minima | two boxes | 308 / 82 / 8, 182 | byte for byte |
| vme-wren | two boxes | 153 / 40 / 0, 118 (Python 204 s, TS 26 s) | byte for byte |

The re-place half of `--replace` is the floorplan pass above (same `place_group`). The route half is not compared: Fabdesk's last
mile routes the opens with its KRT `after-cut` plan (cut pairs as pairs first), as a nudge does, where route_region ran TraceMaker's
CLI on the whole board.

block_eval plan: `block_eval.py` writes its isolation plan before routing (the stand-in TraceMaker then makes the route step fail),
against `blockPlan` with the same base plan (`plan-r6.json`) on C6 placed-H2, groups of floorplan-disp-V6:

| Groups | Nets | Stages | Plan |
| --- | --- | --- | --- |
| display (with disp_filters, disp_rn) | 93 | connector-small 11, pairs 18, rest 60 + 4 | equal |
| charger, buck_5v | 33 | rest 33 | equal |
| keyboard, `--gnd-first` | 70 | gnd-drops 1, pairs 4, rest 60 + 6 | equal |

`escape` is left out of the comparison: the toolkit sets it (power_escape stubs), the TypeScript route pipeline does not run
power_escape and the port does not set it. The base plan is the layout spec's TraceMaker plan in Fabdesk, not C6's file.

## Not compared

- No real tracemaker-place run: an eval held the machine (KRT on cm5) the whole session. The passes replay recorded TraceMaker
  outputs instead, which checks the transfer, locking and verification logic on real placer poses.
- Fabdesk's TraceMaker build packages `tracemaker` only; the floorplan path needs `tracemaker-place` from an upstream release or
  `TRACEMAKER_PLACE_BIN`.
- block_eval's TraceMaker session and render; last-mile `replace:` end to end (fails naming KRT when KRT is missing, tested).
