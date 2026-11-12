# Board workflow edit stage: parity with the Python toolkit (ECO on a routed board)

Date 2026-11-12. Oracle: toolkit branch `cmp/held-out-fixes` (`flow/edit.py`, `flow/edit_ops.py`, `flow/edit_move.py`, and the
rule-based task generator of `flow/editbench.py tasks`). Port: `packages/board-workflow/src/edit/`, tool `board_edit`.
Harness: `packages/board-workflow/test/parity-edit.ts` (not part of `bun run test`; needs the toolkit and kicad-cli).

Method. One project copy is onboarded by the TypeScript onboarder; the oracle gets a spec built from it (same requirements,
same fixed parts). Plans are the toolkit's own `editbench tasks` output for that board (remove a decoupling cap, change a
resistor value, re-seat a passive `near` its signal partner, swap a capacitor onto another footprint, add a decoupling cap
on an IC supply pin, move a pull resistor's pin to another rail), plus a position swap of two connectors with `carry_auto`
(`J502`/`J601`, the old harness's edit task), a move onto a fixed connector (a STOP) and a removal that leaves a pin alone
(a STOP). Per plan the oracle runs `edit.py impact`, `apply --no-score`, `diff --ledger`, and `check_acceptance.py` (its own
DRC with schematic parity) on its own candidate; the port runs `runEdit` (impact -> apply -> proof -> diff) on the same
project and the same plan, with its own DRC on its own candidate. Compared:

- the impact lines (what `edit.py impact` prints), also under `PYTHONHASHSEED` 0, 1 and 2 (the oracle prints some sets in hash order);
- the apply ledgers (moved, carried, near, displaced, nets cut, copper removed/moved/pruned, landing, footprints/symbols removed, net changes, swaps, adds);
- the candidate files: the board and every schematic sheet, text-identical with uuids masked;
- the edited requirements (acceptance, circuit, mechanical, heights) field by field;
- the planned-versus-collateral diff and churn;
- A1-A9: the summary, every check's figures, and the edit verdict (`PASS all A1-A9 with parity` / `PASS (no regression)` / `FAIL ...`).
Numbers within 1e-6, everything else exact. Free-text `note` fields are compared apart.

## Result

| board | run | rows | agree |
|---|---|---|---|
| cm5_minima (112 parts, 8 sheets) | full: impact, apply, proof (live DRC each side), diff; 9 plans: 7 applied and proven (remove, value, move, swap, add, position swap, net) and 2 STOPs (a move onto a fixed connector; a removal that leaves a pin alone); impact also under 3 hash seeds | 176 | 176 |
| vme-wren (1508 parts, 37 sheets, 68 MB board) | apply only (ledger, candidate files, requirements, diff, churn); the unedited project scored from the recorded DRC `drc-ref.json` on both sides | 61 | 61 |
| vme-wren | impact only: remove, value, move, swap, add, two net plans, and both STOPs | 9 | 9 |

Every row agrees. Where a row's text is not identical by construction the harness says so (below); nothing is listed as agreeing
that differs.

## What differs from the oracle by design (the port's own decisions)

These do not show as differing rows because the harness compares them in the form the decision makes comparable.

1. **Hash-order ordering.** The oracle iterates Python sets of reference strings in `PYTHONHASHSEED` order in a few places: the
   order of `why` entries and of parts in the way (and so the order displaced parts are re-seated in), the order of moved parts in
   `diff`, and some impact lines. The port sorts. On both boards every plan gave the same candidate board and sheets in the oracle
   (seed 0, the harness seed) and in the port; impact lines agree as sets under seeds 0, 1 and 2, and in order under seeds 1 and 2
   but not 0 for the position swap (row "same lines in another order"). A plan whose re-seat order matters could give a different
   candidate under another seed in the oracle; the port gives one answer.
2. **Fixed parts.** The oracle reads a `fixed` regex from the flow spec; the port uses the onboarded fixed list plus every mechanical
   anchor in the requirements (so a part an earlier edit made an anchor stays fixed). On both boards the two sets are equal (46 parts on cm5_minima, 44 on vme-wren).
3. **Owner-excluded DRC violations.** `kicad-cli pcb drc --severity-all` (what `board_check` runs) also reports violations the board's
   owner marked excluded ("Intentional Overlap"), as ordinary errors. On cm5_minima that is 4 courtyard errors instead of the 3
   the oracle's default flags give (7 parity warnings in both). The edit stage reads the DRC JSON without excluded items
   (`drcInputFromFile`), which reproduces the oracle's counts. `board_check` itself does not do this (stage 1; not changed here).
4. **Anchor text.** Moved anchors are written at micron precision; the oracle writes `%g` (6 significant digits). The harness compares them as numbers.
5. **Tab-indented sheets.** The oracle inserts a new symbol field before `"\n    (pin "` (4 spaces); KiCad 10 sheets, including every cm5_minima and
   vme-wren sheet, indent with tabs, where the oracle would stop with "no place to add property". The port finds the anchor
   whatever the indentation. Not exercised against the oracle on these boards (no plan adds a field to an existing symbol); covered by a unit test.
6. **Before-score cache.** The oracle caches the unedited project's score under `work/.edit-before-cache`; the port caches it under
   `.fabdesk/board/edits/.before/<design hash + scoring basis>`.
7. **Failure wording.** A stop reads the same; the port's `STOP the source project fails [...]` text also says how to fix it.

## Not ported

- `editbench run` (the repair chain finish / rip / blockers / pairs / taps / a7 / leg through `bench.py`) and its churn guard loop: repair is the route stage's. The hook is `EditRunners.repair`; `revertNets` (the guard's copper swap) is ported and unit-tested but not wired.
- `apply_netclasses.py` for bare boards (`native_project_rules` false): routed boards keep their own rules, which is all edit supports.
- `editbench table` and the run records through `pcb_iteration`.
- Sheets in sub-folders (the adopt path writes top-level sheets only): a symbol there is "not found".

## Not covered by this comparison

- Strict mode (a project that passes every check before the edit): neither board passes; cm5_minima and vme-wren fail A2, A3 and A8 on their own. The strict verdict rule is unit-tested only.
- A1-A9 of the edited candidate on vme-wren (a live DRC with refilled zones per candidate on a 68 MB board); the candidate files there are identical, so the oracle's figures would follow from the DRC.
- `make_room`, `fixed_allowed`, `dnp`, `side` flips and `symbol` adds are unit-tested, not compared with the oracle.

## cm5_minima: full pipeline

Board `/home/shane/pcb-cmp/cm5_minima/proj2`. Oracle: /home/shane/pcb-worktrees/heldout (`flow/edit.py`, `flow/editbench.py tasks`). kicad-cli: /usr/bin/kicad-cli-nightly. Baseline A1-A9 before any edit: A1 pass, A2 FAIL, A3 FAIL, A4 pass, A5 pass, A6 pass, A7 pass, A8 FAIL, A9 pass.

| task | item | agrees | detail |
|---|---|---|---|
| remove | impact lines: 9 lines | yes |  |
| remove | impact lines (PYTHONHASHSEED=1): 9 lines | yes |  |
| remove | impact lines (PYTHONHASHSEED=2): 9 lines | yes |  |
| remove | ledger moves: none | yes |  |
| remove | ledger landing: none | yes |  |
| remove | ledger counts (removed footprints/copper/pruned/symbols/net changes/swaps/adds) | yes |  |
| remove | candidate files (board + 8 sheets, uuids masked) identical | yes |  |
| remove | requirements/acceptance.json | yes |  |
| remove | requirements/circuit.json | yes |  |
| remove | requirements/mechanical.json | yes |  |
| remove | requirements/heights.json | yes |  |
| remove | diff: removed 1, added 0, moved 0, pin-net changes 0, copper-changed nets 0 | yes |  |
| remove | churn: planned parts moved 0, unplanned 0, collateral 0 nets / 0 mm | yes |  |
| remove | A1-A9 summary of the edited candidate: 6/9 pass | yes |  |
| remove | A1-A9 A1_connectivity | yes |  |
| remove | A1-A9 A2_drc | yes |  |
| remove | A1-A9 A3_parity | yes |  |
| remove | A1-A9 A4_circuit | yes |  |
| remove | A1-A9 A5_anchors | yes |  |
| remove | A1-A9 A6_stack | yes |  |
| remove | A1-A9 A7_widths | yes |  |
| remove | A1-A9 A8_pairs | yes |  |
| remove | A1-A9 A9_heights | yes |  |
| remove | verdict: py "FAIL regress ['A3 items 7->15']" vs ts "FAIL regress ['A3 items 7->15']" | yes |  |
| value | impact lines: 2 lines | yes |  |
| value | impact lines (PYTHONHASHSEED=1): 2 lines | yes |  |
| value | impact lines (PYTHONHASHSEED=2): 2 lines | yes |  |
| value | ledger moves: none | yes |  |
| value | ledger landing: none | yes |  |
| value | ledger counts (removed footprints/copper/pruned/symbols/net changes/swaps/adds) | yes |  |
| value | candidate files (board + 8 sheets, uuids masked) identical | yes |  |
| value | requirements/acceptance.json | yes |  |
| value | requirements/circuit.json | yes |  |
| value | requirements/mechanical.json | yes |  |
| value | requirements/heights.json | yes |  |
| value | diff: removed 0, added 0, moved 0, pin-net changes 0, copper-changed nets 0 | yes |  |
| value | churn: planned parts moved 0, unplanned 0, collateral 0 nets / 0 mm | yes |  |
| value | A1-A9 summary of the edited candidate: 6/9 pass | yes |  |
| value | A1-A9 A1_connectivity | yes |  |
| value | A1-A9 A2_drc | yes |  |
| value | A1-A9 A3_parity | yes |  |
| value | A1-A9 A4_circuit | yes |  |
| value | A1-A9 A5_anchors | yes |  |
| value | A1-A9 A6_stack | yes |  |
| value | A1-A9 A7_widths | yes |  |
| value | A1-A9 A8_pairs | yes |  |
| value | A1-A9 A9_heights | yes |  |
| value | verdict: py "PASS (no regression)" vs ts "PASS (no regression)" | yes |  |
| move | impact lines: 6 lines | yes |  |
| move | impact lines (PYTHONHASHSEED=1): 6 lines | yes |  |
| move | impact lines (PYTHONHASHSEED=2): 6 lines | yes |  |
| move | ledger moves: 0 moved, 0 carried, 0 displaced, 1 near, cut nets 3, copper removed 6 | yes |  |
| move | ledger landing: none | yes |  |
| move | ledger counts (removed footprints/copper/pruned/symbols/net changes/swaps/adds) | yes |  |
| move | candidate files (board + 8 sheets, uuids masked) identical | yes |  |
| move | requirements/acceptance.json | yes |  |
| move | requirements/circuit.json | yes |  |
| move | requirements/mechanical.json | yes |  |
| move | requirements/heights.json | yes |  |
| move | diff: removed 0, added 0, moved 1, pin-net changes 0, copper-changed nets 2 | yes |  |
| move | churn: planned parts moved 1, unplanned 0, collateral 0 nets / 0 mm | yes |  |
| move | A1-A9 summary of the edited candidate: 5/9 pass | yes |  |
| move | A1-A9 A1_connectivity | yes |  |
| move | A1-A9 A2_drc | yes |  |
| move | A1-A9 A3_parity | yes |  |
| move | A1-A9 A4_circuit | yes |  |
| move | A1-A9 A5_anchors | yes |  |
| move | A1-A9 A6_stack | yes |  |
| move | A1-A9 A7_widths | yes |  |
| move | A1-A9 A8_pairs | yes |  |
| move | A1-A9 A9_heights | yes |  |
| move | verdict: py "FAIL regress ['A1_connectivity']" vs ts "FAIL regress ['A1_connectivity']" | yes |  |
| swap | impact lines: 4 lines | yes |  |
| swap | impact lines (PYTHONHASHSEED=1): 4 lines | yes |  |
| swap | impact lines (PYTHONHASHSEED=2): 4 lines | yes |  |
| swap | ledger moves: none | yes |  |
| swap | ledger landing: 1 moved, 0 carried, 0 displaced, 0 near, cut nets 1, copper removed 2 | yes |  |
| swap | ledger counts (removed footprints/copper/pruned/symbols/net changes/swaps/adds) | yes |  |
| swap | candidate files (board + 8 sheets, uuids masked) identical | yes |  |
| swap | requirements/acceptance.json | yes |  |
| swap | requirements/circuit.json | yes |  |
| swap | requirements/mechanical.json | yes |  |
| swap | requirements/heights.json | yes |  |
| swap | diff: removed 0, added 0, moved 0, pin-net changes 0, copper-changed nets 1 | yes |  |
| swap | churn: planned parts moved 0, unplanned 0, collateral 0 nets / 0 mm | yes |  |
| swap | A1-A9 summary of the edited candidate: 5/9 pass | yes |  |
| swap | A1-A9 A1_connectivity | yes |  |
| swap | A1-A9 A2_drc | yes |  |
| swap | A1-A9 A3_parity | yes |  |
| swap | A1-A9 A4_circuit | yes |  |
| swap | A1-A9 A5_anchors | yes |  |
| swap | A1-A9 A6_stack | yes |  |
| swap | A1-A9 A7_widths | yes |  |
| swap | A1-A9 A8_pairs | yes |  |
| swap | A1-A9 A9_heights | yes |  |
| swap | verdict: py "FAIL regress ['A1_connectivity', 'A2 errors 3->10']" vs ts "FAIL regress ['A1_connectivity', 'A2 errors 3->10']" | yes |  |
| add | impact lines: 2 lines | yes |  |
| add | impact lines (PYTHONHASHSEED=1): 2 lines | yes |  |
| add | impact lines (PYTHONHASHSEED=2): 2 lines | yes |  |
| add | ledger moves: none | yes |  |
| add | ledger landing: 0 moved, 0 carried, 0 displaced, 1 near, cut nets 0, copper removed 0 | yes |  |
| add | ledger counts (removed footprints/copper/pruned/symbols/net changes/swaps/adds) | yes |  |
| add | candidate files (board + 8 sheets, uuids masked) identical | yes |  |
| add | requirements/acceptance.json | yes |  |
| add | requirements/circuit.json | yes |  |
| add | requirements/mechanical.json | yes |  |
| add | requirements/heights.json | yes |  |
| add | diff: removed 0, added 1, moved 0, pin-net changes 0, copper-changed nets 0 | yes |  |
| add | churn: planned parts moved 0, unplanned 0, collateral 0 nets / 0 mm | yes |  |
| add | A1-A9 summary of the edited candidate: 5/9 pass | yes |  |
| add | A1-A9 A1_connectivity | yes |  |
| add | A1-A9 A2_drc | yes |  |
| add | A1-A9 A3_parity | yes |  |
| add | A1-A9 A4_circuit | yes |  |
| add | A1-A9 A5_anchors | yes |  |
| add | A1-A9 A6_stack | yes |  |
| add | A1-A9 A7_widths | yes |  |
| add | A1-A9 A8_pairs | yes |  |
| add | A1-A9 A9_heights | yes |  |
| add | verdict: py "FAIL regress ['A1_connectivity']" vs ts "FAIL regress ['A1_connectivity']" | yes |  |
| posswap | impact lines: 8 lines, same lines in another order | yes | `{"order_differs_only":true}` |
| posswap | impact lines (PYTHONHASHSEED=1): 8 lines | yes |  |
| posswap | impact lines (PYTHONHASHSEED=2): 8 lines | yes |  |
| posswap | ledger moves: 2 moved, 0 carried, 0 displaced, 0 near, cut nets 8, copper removed 26 | yes |  |
| posswap | ledger landing: none | yes |  |
| posswap | ledger counts (removed footprints/copper/pruned/symbols/net changes/swaps/adds) | yes |  |
| posswap | candidate files (board + 8 sheets, uuids masked) identical | yes |  |
| posswap | requirements/acceptance.json | yes |  |
| posswap | requirements/circuit.json | yes |  |
| posswap | requirements/mechanical.json | yes |  |
| posswap | requirements/heights.json | yes |  |
| posswap | diff: removed 0, added 0, moved 2, pin-net changes 0, copper-changed nets 6 | yes |  |
| posswap | churn: planned parts moved 2, unplanned 0, collateral 0 nets / 0 mm | yes |  |
| posswap | A1-A9 summary of the edited candidate: 5/9 pass | yes |  |
| posswap | A1-A9 A1_connectivity | yes |  |
| posswap | A1-A9 A2_drc | yes |  |
| posswap | A1-A9 A3_parity | yes |  |
| posswap | A1-A9 A4_circuit | yes |  |
| posswap | A1-A9 A5_anchors | yes |  |
| posswap | A1-A9 A6_stack | yes |  |
| posswap | A1-A9 A7_widths | yes |  |
| posswap | A1-A9 A8_pairs | yes |  |
| posswap | A1-A9 A9_heights | yes |  |
| posswap | verdict: py "FAIL regress ['A1_connectivity', 'A2 errors 3->4']" vs ts "FAIL regress ['A1_connectivity', 'A2 errors 3->4']" | yes |  |
| net:R101 | impact lines: 2 lines | yes |  |
| net:R101 | impact lines (PYTHONHASHSEED=1): 2 lines | yes |  |
| net:R101 | impact lines (PYTHONHASHSEED=2): 2 lines | yes |  |
| net:R101 | ledger moves: none | yes |  |
| net:R101 | ledger landing: none | yes |  |
| net:R101 | ledger counts (removed footprints/copper/pruned/symbols/net changes/swaps/adds) | yes |  |
| net:R101 | candidate files (board + 8 sheets, uuids masked) identical | yes |  |
| net:R101 | requirements/acceptance.json | yes |  |
| net:R101 | requirements/circuit.json | yes |  |
| net:R101 | requirements/mechanical.json | yes |  |
| net:R101 | requirements/heights.json | yes |  |
| net:R101 | diff: removed 0, added 0, moved 0, pin-net changes 1, copper-changed nets 1 | yes |  |
| net:R101 | churn: planned parts moved 0, unplanned 0, collateral 0 nets / 0 mm | yes |  |
| net:R101 | A1-A9 summary of the edited candidate: 5/9 pass | yes |  |
| net:R101 | A1-A9 A1_connectivity | yes |  |
| net:R101 | A1-A9 A2_drc | yes |  |
| net:R101 | A1-A9 A3_parity | yes |  |
| net:R101 | A1-A9 A4_circuit | yes |  |
| net:R101 | A1-A9 A5_anchors | yes |  |
| net:R101 | A1-A9 A6_stack | yes |  |
| net:R101 | A1-A9 A7_widths | yes |  |
| net:R101 | A1-A9 A8_pairs | yes |  |
| net:R101 | A1-A9 A9_heights | yes |  |
| net:R101 | verdict: py "FAIL regress ['A1_connectivity']" vs ts "FAIL regress ['A1_connectivity']" | yes |  |
| stopfixed | impact lines: 2 lines | yes |  |
| stopfixed | impact lines (PYTHONHASHSEED=1): 2 lines | yes |  |
| stopfixed | impact lines (PYTHONHASHSEED=2): 2 lines | yes |  |
| stopfixed | apply stops the same way (py: STOP fixed parts in the way of the new pose(s): J1 (R704: courtyard); ts: STOP fixed parts in the way of the new pose(s): J1 (R704: courtyard)) | yes |  |
| stopunconn | impact lines: 10 lines | yes |  |
| stopunconn | impact lines (PYTHONHASHSEED=1): 10 lines | yes |  |
| stopunconn | impact lines (PYTHONHASHSEED=2): 10 lines | yes |  |
| stopunconn | apply stops the same way (py: STOP review: unconnected pins not accepted in the plan: Module301.21 (/CM5/nLED_ACTIVITY), D606.1 (Net-(D606-K)); ts: STOP review: unconnected pins not accepted in the plan: Module301.21 (/CM5/nLED_ACTIVITY), D606.1 (Net-(D606-K))) | yes |  |

Free-text fields that differ (wording only, compared apart): A8_pairs.note.

Seconds, apply (oracle without scoring) / full TS pipeline (impact, apply, proof incl. two DRC runs when the before-score is not cached, diff): remove 4.4 / 6.0, value 1.6 / 3.3, move 5.7 / 4.5, swap 4.8 / 3.6, add 3.7 / 3.8, posswap 10.4 / 5.1, net:R101 3.9 / 3.5

## vme-wren: apply only

Board `/home/shane/pcb-cmp/vme-wren/proj2`. Oracle: /home/shane/pcb-worktrees/heldout (`flow/edit.py`, `flow/editbench.py tasks`). kicad-cli: /usr/bin/kicad-cli-nightly. Baseline A1-A9 before any edit: A1 pass, A2 FAIL, A3 FAIL, A4 pass, A5 pass, A6 pass, A7 pass, A8 FAIL, A9 pass.

| task | item | agrees | detail |
|---|---|---|---|
| remove | impact lines: 8 lines | yes |  |
| remove | ledger moves: none | yes |  |
| remove | ledger landing: none | yes |  |
| remove | ledger counts (removed footprints/copper/pruned/symbols/net changes/swaps/adds) | yes |  |
| remove | candidate files (board + 37 sheets, uuids masked) identical | yes |  |
| remove | requirements/acceptance.json | yes |  |
| remove | requirements/circuit.json | yes |  |
| remove | requirements/mechanical.json | yes |  |
| remove | requirements/heights.json | yes |  |
| remove | diff: removed 1, added 0, moved 0, pin-net changes 0, copper-changed nets 0 | yes |  |
| remove | churn: planned parts moved 0, unplanned 0, collateral 0 nets / 0 mm | yes |  |
| value | impact lines: 2 lines | yes |  |
| value | ledger moves: none | yes |  |
| value | ledger landing: none | yes |  |
| value | ledger counts (removed footprints/copper/pruned/symbols/net changes/swaps/adds) | yes |  |
| value | candidate files (board + 37 sheets, uuids masked) identical | yes |  |
| value | requirements/acceptance.json | yes |  |
| value | requirements/circuit.json | yes |  |
| value | requirements/mechanical.json | yes |  |
| value | requirements/heights.json | yes |  |
| value | diff: removed 0, added 0, moved 0, pin-net changes 0, copper-changed nets 0 | yes |  |
| value | churn: planned parts moved 0, unplanned 0, collateral 0 nets / 0 mm | yes |  |
| move | impact lines: 5 lines | yes |  |
| move | ledger moves: 0 moved, 0 carried, 0 displaced, 1 near, cut nets 2, copper removed 3 | yes |  |
| move | ledger landing: none | yes |  |
| move | ledger counts (removed footprints/copper/pruned/symbols/net changes/swaps/adds) | yes |  |
| move | candidate files (board + 37 sheets, uuids masked) identical | yes |  |
| move | requirements/acceptance.json | yes |  |
| move | requirements/circuit.json | yes |  |
| move | requirements/mechanical.json | yes |  |
| move | requirements/heights.json | yes |  |
| move | diff: removed 0, added 0, moved 1, pin-net changes 0, copper-changed nets 2 | yes |  |
| move | churn: planned parts moved 1, unplanned 0, collateral 0 nets / 0 mm | yes |  |
| swap | impact lines: 4 lines | yes |  |
| swap | ledger moves: none | yes |  |
| swap | ledger landing: 1 moved, 0 carried, 0 displaced, 0 near, cut nets 3, copper removed 4 | yes |  |
| swap | ledger counts (removed footprints/copper/pruned/symbols/net changes/swaps/adds) | yes |  |
| swap | candidate files (board + 37 sheets, uuids masked) identical | yes |  |
| swap | requirements/acceptance.json | yes |  |
| swap | requirements/circuit.json | yes |  |
| swap | requirements/mechanical.json | yes |  |
| swap | requirements/heights.json | yes |  |
| swap | diff: removed 0, added 0, moved 0, pin-net changes 0, copper-changed nets 3 | yes |  |
| swap | churn: planned parts moved 0, unplanned 0, collateral 0 nets / 0 mm | yes |  |
| add | impact lines: 2 lines | yes |  |
| add | apply stops the same way (py: STOP part C908 has no legal pose within 10.0 mm of its target 151.13,218.27 (near [151.12782, 218.274395]: added part near IC14): move it in the plan or raise t; ts: STOP part C908 has no legal pose within 10 mm of its target 151.13,218.27 (near [151.12782, 218.274395]: added part near IC14): move it in the plan or raise the) | yes |  |
| net:R214 | impact lines: 2 lines | yes |  |
| net:R214 | ledger moves: none | yes |  |
| net:R214 | ledger landing: none | yes |  |
| net:R214 | ledger counts (removed footprints/copper/pruned/symbols/net changes/swaps/adds) | yes |  |
| net:R214 | candidate files (board + 37 sheets, uuids masked) identical | yes |  |
| net:R214 | requirements/acceptance.json | yes |  |
| net:R214 | requirements/circuit.json | yes |  |
| net:R214 | requirements/mechanical.json | yes |  |
| net:R214 | requirements/heights.json | yes |  |
| net:R214 | diff: removed 0, added 0, moved 0, pin-net changes 1, copper-changed nets 1 | yes |  |
| net:R214 | churn: planned parts moved 0, unplanned 0, collateral 0 nets / 0 mm | yes |  |
| stopfixed | impact lines: 2 lines | yes |  |
| stopfixed | apply stops the same way (py: STOP fixed parts in the way of the new pose(s): J1 (R212: courtyard); Cage1 (R212: courtyard); ts: STOP fixed parts in the way of the new pose(s): J1 (R212: courtyard); Cage1 (R212: courtyard)) | yes |  |
| stopunconn | impact lines: 8 lines | yes |  |
| stopunconn | apply stops the same way (py: STOP review: unconnected pins not accepted in the plan: IC124.3 (Net-(IC124-1Y)); ts: STOP review: unconnected pins not accepted in the plan: IC124.3 (Net-(IC124-1Y))) | yes |  |

Free-text fields that differ (wording only, compared apart): none.

Seconds, apply (oracle without scoring) / full TS pipeline (impact, apply, proof incl. two DRC runs when the before-score is not cached, diff): remove 31.9 / 7.6, value 33.9 / 7.3, move 162.4 / 32.3, swap 154.3 / 21.8, net:R214 76.0 / 11.0

## vme-wren: impact only

Board `/home/shane/pcb-cmp/vme-wren/proj2`. Oracle: /home/shane/pcb-worktrees/heldout (`flow/edit.py`, `flow/editbench.py tasks`). kicad-cli: /usr/bin/kicad-cli-nightly. Impact only: apply and proof were not run on this board.

| task | item | agrees | detail |
|---|---|---|---|
| remove | impact lines: 8 lines | yes |  |
| value | impact lines: 2 lines | yes |  |
| move | impact lines: 5 lines | yes |  |
| swap | impact lines: 4 lines | yes |  |
| add | impact lines: 2 lines | yes |  |
| net:R214 | impact lines: 2 lines | yes |  |
| net:R222 | impact lines: 2 lines | yes |  |
| stopfixed | impact lines: 2 lines | yes |  |
| stopunconn | impact lines: 8 lines | yes |  |

Free-text fields that differ (wording only, compared apart): none.

Seconds, apply (oracle without scoring) / full TS pipeline (impact, apply, proof incl. two DRC runs when the before-score is not cached, diff):
