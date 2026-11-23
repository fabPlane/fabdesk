# Board workflow, last mile: placement nudge and `fit` parity with the Python toolkit

Date 2026-11-12. Oracle: `~/pcb` main working tree, `tools/nudge_place.py` with the uncommitted keepout change
(`check_acceptance.keepout_blocks`: a keepout rule area only blocks when it disallows footprints or tracks), plus what it calls
(`tp_legalise.local_box/world_box/overlap`, `block_pass.set_pose`, `route_region.prune_dangling`,
`floorplan_run.native_courtyard`, `boardctx` GND / FIXED / ACC_PATH) and `tools/bench.py cmd_fit`. The held-out checkout
(`~/pcb-worktrees/heldout`, no keepout change) was run on the R1N rule-area rows only, to show what the change does.
Port: `packages/board-workflow/src/lastmile/nudge.ts`. Unit tests: `packages/board-workflow/test/nudge.test.ts` (synthetic
boards). Harness: `packages/board-workflow/test/parity-nudge.ts` (not part of `bun run test`; needs the toolkit and
`/usr/bin/kicad-cli-nightly`; no router is run).

Boards (each copied to a scratch folder: `.kicad_pcb`, `.kicad_pro`, `.kicad_dru`; both sides read the same copy and the same
MOVES.json; the oracle runs with `FLOW_SPEC` = the board's spec):

- cm5_minima, `/home/shane/pcb-cmp/cm5_minima/proj2`, spec `/home/shane/pcb-cmp/cm5_minima/onboard/spec.json` (112 parts,
  one tracks-not-allowed keepout). The board as given has one courtyard overlap, so every placed row there fails the
  courtyard gate on both sides (the toolkit's exit code and message, record written).
- C6-eco95, `/home/shane/vaio_p_modding/io-c6/release/C6-eco95` (318 parts, legacy `C6_ACCEPTANCE_V1` acceptance: ground
  `IO_GND` by the schema default; nine tracks-not-allowed keepouts at the FIT_ holes).
- R1N-bom, `/home/shane/vaio_p_modding/io-c6/release/R1N-bom` (127 parts; 38 allow-all rule areas, among them
  "BENCH ... landing").

MOVES.json is written for the oracle the way the bench writes it (every number a float), so a refusal prints the radius as
`2.5` / `1.0` on both sides. Compared per case: exit status and message, `nudge.json` (deep equality: poses, mate distance,
removed, pruned, native courtyard, cut nets), the written board (byte equality; the harness falls back to poses plus the
copper item set if bytes differ, which no row needed), and for `fit` rows the bench printout (the oracle's `cmd_fit` format
strings applied to its own nudge.json) and the window box.

Result of the last run (after the last code change): **132 of 134 rows agree.** The two that do not are the fixed-part set on
C6 (below), not the port. Every placed case wrote a byte-identical board.

## Differences and decisions

1. **Fixed parts (C6).** The oracle's FIXED is the spec's pattern `_(J|SW)\d|^FIT_` (22 parts on C6); the port's default is the
   requirements' mechanical anchors (16 parts): `A74_SW1`, `A74_SW2`, `C18_J102`, `C18_J103`, `C18_J105`, `C18_J106` are fixed
   for the oracle and not anchors. cm5_minima (46/46) and R1N (14/14) agree. `nudgeStep`/`fitStep` take an optional
   `fixed(ref)`; given the spec's set, the C6 `C18_J102` row agrees (row "with the spec's fixed set given to TS"). The engine
   should pass the edit env's fixed set (onboard record plus anchors, `edit/env.ts`) where it has one.
2. **`pruneDangling` (`src/edit/prune.ts`) is not exactly `route_region.prune_dangling`.** Its end key rounds with
   `Math.round(x * 1000) / 1000`; Python's `round(x, 3)` rounds the exact binary value. On R1N with every 7th segment
   removed and all nets pruned, TypeScript dropped 1147 items, Python 1145 (a via at y 7.0224 and a 0.1 um segment ending at
   7.0225: Python keys both 7.022, TypeScript 7.022 and 7.023). With `pyRound(x, 3).toFixed(3)` in the key (tried on a
   scratch copy) all six prune comparisons (cm5, R1N, C6; all nets and a five-net subset) are byte-identical. No nudge row
   hit the case. Needs the one-line change in `prune.ts` (not edited here).
3. **Refusals write nothing.** The oracle copies the folder first and exits afterwards, leaving a partial OUT_DIR; the port
   computes the move first and throws `NudgeError` before writing. A failed courtyard gate writes everything (board,
   moves.json, placement-drc.json, nudge.json) and then throws with the record attached, as the oracle exits after writing.
4. **Crashes become messages.** An unknown `REF.PAD` / `near` part was a Python traceback; the port says `X.1: no such pad
   (with a net) on the board` / `X: not on the board`. A board with no Edge.Cuts lines/rectangles: likewise.
5. **Pose writing** uses `layout/text.ts setPose`: on transform boards (all three) it writes what `block_pass.set_pose` writes;
   it also moves `(at x y r)` boards (the toolkit only turned them), leaves an unchanged pose byte-identical (the toolkit
   rewrote the translate as `%.4f`), and prints turned child angles with 12 significant digits (`%g`: 6). None of these
   occurred in the rows.
6. **Radius in the refusal message**: integer-valued radii print as `N.0` (the bench writes floats); a hand-written MOVES.json
   with an integer radius printed `N` in Python. An absent radius prints `6` on both sides.
7. **`fit` picture**: the window is drawn as SVG by `view.ts renderBoardSvg` (labels, side, window, title) to `fit.svg`, and to
   `fit.png` through an optional `render(svg)` callback (the host's rasteriser); the oracle drew a matplotlib PNG with
   `board_view.py`. Pictures are not compared. The fit title is a caller option (`fit ACTION` in the toolkit).
8. **Rule areas**: the R1N "BENCH CM5 landing F.Cu" rows place CSEQ1 at the found point on both sides; the held-out (pre-change)
   toolkit refuses the same moves with "it hits: keepout".

## Rows

| item | agrees | detail |
|---|---|---|
| cm5: fixed parts, spec pattern (oracle) vs requirements anchors (TypeScript): 46 / 46 | yes |  |
| cm5: ground net GND | yes |  |
| cm5 near point R704: exit 1 / 1: courtyard gate failed: {'courtyards_overlap': 1} | yes |  |
| cm5 near point R704: nudge.json equal | yes |  |
| cm5 near point R704: poses [["R704",[117,70.5,270],10.35]] | yes |  |
| cm5 near point R704: removed 1, pruned 0, cut nets 1, courtyard {"courtyards_overlap":1} | yes |  |
| cm5 near point R704: written board byte-identical | yes |  |
| cm5 near point R704: timing oracle 3.2 s, TypeScript 1.7 s | yes |  |
| cm5 near point R704: fit printout ["NO FIT: courtyard gate failed: {'courtyards_overlap': 1}"] | yes |  |
| cm5 near REF C705->C704, four rotations: exit 1 / 1: courtyard gate failed: {'courtyards_overlap': 1} | yes |  |
| cm5 near REF C705->C704, four rotations: nudge.json equal | yes |  |
| cm5 near REF C705->C704, four rotations: poses [["C705",[126.891,64.393,180],1.7]] | yes |  |
| cm5 near REF C705->C704, four rotations: removed 26, pruned 13, cut nets 6, courtyard {"courtyards_overlap":1} | yes |  |
| cm5 near REF C705->C704, four rotations: written board byte-identical | yes |  |
| cm5 near REF C705->C704, four rotations: timing oracle 6.2 s, TypeScript 2.3 s | yes |  |
| cm5 near REF.PAD R606->D606.1: exit 1 / 1: courtyard gate failed: {'courtyards_overlap': 1} | yes |  |
| cm5 near REF.PAD R606->D606.1: nudge.json equal | yes |  |
| cm5 near REF.PAD R606->D606.1: poses [["R606",[130.649,56.322,270],7.96]] | yes |  |
| cm5 near REF.PAD R606->D606.1: removed 3, pruned 1, cut nets 2, courtyard {"courtyards_overlap":1} | yes |  |
| cm5 near REF.PAD R606->D606.1: written board byte-identical | yes |  |
| cm5 near REF.PAD R606->D606.1: timing oracle 3.5 s, TypeScript 1.9 s | yes |  |
| cm5 pair part D101 (USB_C pair cut whole): exit 1 / 1: D101: no legal pose within 2.5 mm of the target; at the target (courtyard 2.30 x 2.40 mm, gap 0.2) it hits: C101, C102, J101 | yes |  |
| cm5 pair part D101 (USB_C pair cut whole): timing oracle 0.2 s, TypeScript 0.0 s | yes |  |
| cm5 keepout blocks R704 (radius 1): exit 1 / 1: R704: no legal pose within 1.0 mm of the target; at the target (courtyard 0.94 x 1.86 mm, gap 0.2) it hits: REF**, keepout | yes |  |
| cm5 keepout blocks R704 (radius 1): timing oracle 0.2 s, TypeScript 0.0 s | yes |  |
| cm5 keepout pushes R704 out (radius 4): exit 1 / 1: courtyard gate failed: {'courtyards_overlap': 1} | yes |  |
| cm5 keepout pushes R704 out (radius 4): nudge.json equal | yes |  |
| cm5 keepout pushes R704 out (radius 4): poses [["R704",[117.225,73.814,270],9.59]] | yes |  |
| cm5 keepout pushes R704 out (radius 4): removed 1, pruned 0, cut nets 1, courtyard {"courtyards_overlap":1} | yes |  |
| cm5 keepout pushes R704 out (radius 4): written board byte-identical | yes |  |
| cm5 keepout pushes R704 out (radius 4): timing oracle 3.2 s, TypeScript 1.8 s | yes |  |
| cm5 fixed part J1: exit 1 / 1: J1: fixed part, not movable | yes |  |
| cm5 fixed part J1: timing oracle 0.2 s, TypeScript 0.0 s | yes |  |
| cm5 fixed part J1: fit printout ["NO FIT: J1: fixed part, not movable"] | yes |  |
| cm5 two moves R402 & R401->R402: exit 1 / 1: R402: no legal pose within 2.5 mm of the target; at the target (courtyard 1.86 x 0.94 mm, gap 0.2) it hits: J1 | yes |  |
| cm5 two moves R402 & R401->R402: timing oracle 0.2 s, TypeScript 0.0 s | yes |  |
| cm5 turn R606 @90: exit 1 / 1: courtyard gate failed: {'courtyards_overlap': 1} | yes |  |
| cm5 turn R606 @90: nudge.json equal | yes |  |
| cm5 turn R606 @90: poses [["R606",[130.44,56.7,90],8.07]] | yes |  |
| cm5 turn R606 @90: removed 3, pruned 1, cut nets 2, courtyard {"courtyards_overlap":1} | yes |  |
| cm5 turn R606 @90: written board byte-identical | yes |  |
| cm5 turn R606 @90: timing oracle 4.0 s, TypeScript 2.3 s | yes |  |
| cm5 MOVES.json defaults (no clearance/edge/radius): exit 1 / 1: courtyard gate failed: {'courtyards_overlap': 1} | yes |  |
| cm5 MOVES.json defaults (no clearance/edge/radius): nudge.json equal | yes |  |
| cm5 MOVES.json defaults (no clearance/edge/radius): poses [["C708",[122.742,66.903,0],2]] | yes |  |
| cm5 MOVES.json defaults (no clearance/edge/radius): removed 8, pruned 13, cut nets 3, courtyard {"courtyards_overlap":1} | yes |  |
| cm5 MOVES.json defaults (no clearance/edge/radius): written board byte-identical | yes |  |
| cm5 MOVES.json defaults (no clearance/edge/radius): timing oracle 6.0 s, TypeScript 2.5 s | yes |  |
| c6: fixed parts, spec pattern (oracle) vs requirements anchors (TypeScript): 22 / 16 | **no** | {"onlyPy": ["A74_SW1", "A74_SW2", "C18_J102", "C18_J103", "C18_J105", "C18_J106"], "onlyTs": []} |
| c6: ground net IO_GND | yes |  |
| c6 pair part C18_R105 (USB pair cut whole): exit 0 / 0: ok | yes |  |
| c6 pair part C18_R105 (USB pair cut whole): nudge.json equal | yes |  |
| c6 pair part C18_R105 (USB pair cut whole): poses [["C18_R105",[62.424,57.074,0],47.32]] | yes |  |
| c6 pair part C18_R105 (USB pair cut whole): removed 152, pruned 0, cut nets 4, courtyard {} | yes |  |
| c6 pair part C18_R105 (USB pair cut whole): written board byte-identical | yes |  |
| c6 pair part C18_R105 (USB pair cut whole): timing oracle 4.0 s, TypeScript 3.3 s | yes |  |
| c6 keepout and FIT_HA block C18_R306 (radius 0.5): exit 1 / 1: C18_R306: no legal pose within 0.5 mm of the target; at the target (courtyard 0.94 x 1.86 mm, gap 0.2) it hits: FIT_HA, drilled pad, keepout | yes |  |
| c6 keepout and FIT_HA block C18_R306 (radius 0.5): timing oracle 0.3 s, TypeScript 0.1 s | yes |  |
| c6 C18_R306 near FIT_HA keepout (radius 4): exit 0 / 0: ok | yes |  |
| c6 C18_R306 near FIT_HA keepout (radius 4): nudge.json equal | yes |  |
| c6 C18_R306 near FIT_HA keepout (radius 4): poses [["C18_R306",[4.483,5.501,90],31.79]] | yes |  |
| c6 C18_R306 near FIT_HA keepout (radius 4): removed 2, pruned 11, cut nets 2, courtyard {} | yes |  |
| c6 C18_R306 near FIT_HA keepout (radius 4): written board byte-identical | yes |  |
| c6 C18_R306 near FIT_HA keepout (radius 4): timing oracle 7.8 s, TypeScript 2.8 s | yes |  |
| c6 fixed part A74_J1: exit 1 / 1: A74_J1: fixed part, not movable | yes |  |
| c6 fixed part A74_J1: timing oracle 0.2 s, TypeScript 0.0 s | yes |  |
| c6 fixed part FIT_HA: exit 1 / 1: FIT_HA: fixed part, not movable | yes |  |
| c6 fixed part FIT_HA: timing oracle 0.2 s, TypeScript 0.0 s | yes |  |
| c6 turn B-side C18_C210 @0/180: exit 0 / 0: ok | yes |  |
| c6 turn B-side C18_C210 @0/180: nudge.json equal | yes |  |
| c6 turn B-side C18_C210 @0/180: poses [["C18_C210",[38.579,15.329,180],3.29]] | yes |  |
| c6 turn B-side C18_C210 @0/180: removed 62, pruned 6, cut nets 5, courtyard {} | yes |  |
| c6 turn B-side C18_C210 @0/180: written board byte-identical | yes |  |
| c6 turn B-side C18_C210 @0/180: timing oracle 5.6 s, TypeScript 2.9 s | yes |  |
| c6 turn B-side C18_C210 @0/180: fit printout ["  C18_C210       39.19   14.99   270  ->    38.58   15.33   180   mate 3.29 mm","  copper removed 62, cut pairs/nets 5, native courtyard clean"] | yes |  |
| c6 turn B-side C18_C210 @0/180: fit window picture written (the oracle draws a matplotlib PNG; pictures not compared) | yes |  |
| c6 near REF.PAD C18_R303->C18_R306.1: exit 0 / 0: ok | yes |  |
| c6 near REF.PAD C18_R303->C18_R306.1: nudge.json equal | yes |  |
| c6 near REF.PAD C18_R303->C18_R306.1: poses [["C18_R303",[20.256,9.16,0],6.54]] | yes |  |
| c6 near REF.PAD C18_R303->C18_R306.1: removed 4, pruned 2, cut nets 2, courtyard {} | yes |  |
| c6 near REF.PAD C18_R303->C18_R306.1: written board byte-identical | yes |  |
| c6 near REF.PAD C18_R303->C18_R306.1: timing oracle 5.7 s, TypeScript 2.5 s | yes |  |
| c6 unknown part: exit 1 / 1: NOPE1: not on the board | yes |  |
| c6 unknown part: timing oracle 0.2 s, TypeScript 0.0 s | yes |  |
| c6 C18_J102: fixed by the spec pattern, not a mechanical anchor (TS default: anchors): exit 1 / 1: C18_J102: fixed part, not movable | **no** | {"py": [1, "C18_J102: fixed part, not movable"], "ts": [1, "C18_J102: no legal pose within 2.5 mm of the target; at the target (courtyard 3.60 x 6.15 mm, gap 0.2) it hits: C18_J103, drilled pad"]} |
| c6 C18_J102: fixed by the spec pattern, not a mechanical anchor (TS default: anchors): timing oracle 0.3 s, TypeScript 0.1 s | yes |  |
| c6 C18_J102 with the spec's fixed set given to TS: exit 1 / 1: C18_J102: fixed part, not movable | yes |  |
| c6 C18_J102 with the spec's fixed set given to TS: timing oracle 0.2 s, TypeScript 0.0 s | yes |  |
| r1n: fixed parts, spec pattern (oracle) vs requirements anchors (TypeScript): 14 / 14 | yes |  |
| r1n: ground net GND | yes |  |
| r1n allow-all rule area 'BENCH CM5 landing F.Cu' does not block CSEQ1 at 18.3,15.6: exit 0 / 0: ok | yes |  |
| r1n allow-all rule area 'BENCH CM5 landing F.Cu' does not block CSEQ1 at 18.3,15.6: nudge.json equal | yes |  |
| r1n allow-all rule area 'BENCH CM5 landing F.Cu' does not block CSEQ1 at 18.3,15.6: poses [["CSEQ1",[18.3,15.6,90],5.21]] | yes |  |
| r1n allow-all rule area 'BENCH CM5 landing F.Cu' does not block CSEQ1 at 18.3,15.6: removed 49, pruned 0, cut nets 4, courtyard {} | yes |  |
| r1n allow-all rule area 'BENCH CM5 landing F.Cu' does not block CSEQ1 at 18.3,15.6: written board byte-identical | yes |  |
| r1n allow-all rule area 'BENCH CM5 landing F.Cu' does not block CSEQ1 at 18.3,15.6: timing oracle 4.5 s, TypeScript 2.5 s | yes |  |
| r1n allow-all rule area 'BENCH CM5 landing F.Cu' does not block CSEQ1 at 18.3,15.6: pre-change toolkit (every keepout zone blocks): CSEQ1: no legal pose within 0.05 mm of the target; at the target (courtyard 0.92 x 1.82 mm, gap 0.2) it hits: keepout | yes |  |
| r1n CSEQ1 into 'BENCH CM5 landing F.Cu' (radius 2.5): exit 0 / 0: ok | yes |  |
| r1n CSEQ1 into 'BENCH CM5 landing F.Cu' (radius 2.5): nudge.json equal | yes |  |
| r1n CSEQ1 into 'BENCH CM5 landing F.Cu' (radius 2.5): poses [["CSEQ1",[18.3,15.6,90],5.21]] | yes |  |
| r1n CSEQ1 into 'BENCH CM5 landing F.Cu' (radius 2.5): removed 49, pruned 0, cut nets 4, courtyard {} | yes |  |
| r1n CSEQ1 into 'BENCH CM5 landing F.Cu' (radius 2.5): written board byte-identical | yes |  |
| r1n CSEQ1 into 'BENCH CM5 landing F.Cu' (radius 2.5): timing oracle 4.6 s, TypeScript 2.8 s | yes |  |
| r1n CSEQ1 into 'BENCH CM5 landing F.Cu' (radius 2.5): pre-change toolkit (every keepout zone blocks): CSEQ1: no legal pose within 2.5 mm of the target; at the target (courtyard 0.92 x 1.82 mm, gap 0.2) it hits: keepout | yes |  |
| r1n pair part D704 (USB3 RX1 cut whole): exit 0 / 0: ok | yes |  |
| r1n pair part D704 (USB3 RX1 cut whole): nudge.json equal | yes |  |
| r1n pair part D704 (USB3 RX1 cut whole): poses [["D704",[14.097,38.635,270],3.46]] | yes |  |
| r1n pair part D704 (USB3 RX1 cut whole): removed 27, pruned 0, cut nets 3, courtyard {} | yes |  |
| r1n pair part D704 (USB3 RX1 cut whole): written board byte-identical | yes |  |
| r1n pair part D704 (USB3 RX1 cut whole): timing oracle 5.0 s, TypeScript 2.6 s | yes |  |
| r1n pair part D704 (USB3 RX1 cut whole): fit printout ["  D704           12.45   38.55   270  ->    14.10   38.63   270   mate 3.46 mm","  copper removed 27, cut pairs/nets 3, native courtyard clean"] | yes |  |
| r1n pair part D704 (USB3 RX1 cut whole): fit window picture written (the oracle draws a matplotlib PNG; pictures not compared) | yes |  |
| r1n fixed part J101: exit 1 / 1: J101: fixed part, not movable | yes |  |
| r1n fixed part J101: timing oracle 0.3 s, TypeScript 0.0 s | yes |  |
| r1n near REF R716->R702, four rotations: exit 0 / 0: ok | yes |  |
| r1n near REF R716->R702, four rotations: nudge.json equal | yes |  |
| r1n near REF R716->R702, four rotations: poses [["R716",[18.183,46.38,90],83.85]] | yes |  |
| r1n near REF R716->R702, four rotations: removed 10, pruned 3, cut nets 3, courtyard {} | yes |  |
| r1n near REF R716->R702, four rotations: written board byte-identical | yes |  |
| r1n near REF R716->R702, four rotations: timing oracle 5.5 s, TypeScript 2.3 s | yes |  |
| r1n two moves D706 & D707 (two pairs, second sees the first's new box): exit 0 / 0: ok | yes |  |
| r1n two moves D706 & D707 (two pairs, second sees the first's new box): nudge.json equal | yes |  |
| r1n two moves D706 & D707 (two pairs, second sees the first's new box): poses [["D706",[12.706,44.25,270],5.48],["D707",[12.675,46.136,270],7.53]] | yes |  |
| r1n two moves D706 & D707 (two pairs, second sees the first's new box): removed 60, pruned 2, cut nets 6, courtyard {} | yes |  |
| r1n two moves D706 & D707 (two pairs, second sees the first's new box): written board byte-identical | yes |  |
| r1n two moves D706 & D707 (two pairs, second sees the first's new box): timing oracle 5.0 s, TypeScript 2.4 s | yes |  |
| r1n two moves D706 & D707 (two pairs, second sees the first's new box): fit printout ["  D706           12.45   44.35   270  ->    12.71   44.25   270   mate 5.48 mm","  D707           12.45   46.15   270  ->    12.68   46.14   270   mate 7.53 mm","  copper removed 60, cut pairs/nets 6, native courtyard clean"] | yes |  |
| r1n two moves D706 & D707 (two pairs, second sees the first's new box): fit window picture written (the oracle draws a matplotlib PNG; pictures not compared) | yes |  |
| r1n near REF.PAD RUSB2->RUSB1.1: exit 0 / 0: ok | yes |  |
| r1n near REF.PAD RUSB2->RUSB1.1: nudge.json equal | yes |  |
| r1n near REF.PAD RUSB2->RUSB1.1: poses [["RUSB2",[2.361,49.259,0],22.14]] | yes |  |
| r1n near REF.PAD RUSB2->RUSB1.1: removed 7, pruned 4, cut nets 3, courtyard {} | yes |  |
| r1n near REF.PAD RUSB2->RUSB1.1: written board byte-identical | yes |  |
| r1n near REF.PAD RUSB2->RUSB1.1: timing oracle 4.8 s, TypeScript 2.3 s | yes |  |
