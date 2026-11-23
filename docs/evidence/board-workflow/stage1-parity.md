# Board workflow stage 1: parity with the Python toolkit (onboard, A1-A9)

Date 2026-11-12. Oracle: toolkit branch `cmp/held-out-fixes` (`flow/onboard.py`, `tools/check_acceptance.py`). Port:
`packages/board-workflow`. Harness: `packages/board-workflow/test/parity-stage1.ts` (not part of `bun run test`; needs the
toolkit and kicad-cli). Both sides read the same board files and the same KiCad DRC JSON, so A1-A3 compare the DRC
interpretation, not KiCad. A4-A9 and onboarding are computed independently by each side and compared field by field
(numbers within 1e-9, strings and lists exactly; free-text `basis`/`note` fields compared apart).

Summary: every onboarded requirements file and every A1-A9 verdict and figure agrees on cm5_minima and vme-wren, in two
variants on cm5_minima (as onboarded, and a stressed variant that makes A4-A9 fail). One deliberate difference: anchor
coordinates (below).

Not compared: vme-wren stressed variant (the Python tap-branch search did not finish in 10 minutes on that board);
C6 (legacy profile not ported).

---

## cm5_minima (112 parts)

Board: `/home/shane/pcb-cmp/cm5_minima/proj2` (112 footprints, 1884 segments, 444 vias). Oracle: /home/shane/pcb-worktrees/heldout. kicad-cli: /usr/bin/kicad-cli-nightly.
One DRC run (2.8 s) feeds both sides; the live TypeScript DRC path took 2.6 s end to end.

| item | agrees | detail |
|---|---|---|
| onboard acceptance.json | yes |  |
| onboard circuit.json | yes |  |
| onboard mechanical.json | yes |  |
| onboard heights.json | yes |  |
| onboard anchor coordinates: max |oracle %g - TS| (mm), tolerance 1e-4 | yes |  |
| onboard fixed parts | yes |  |
| as-onboarded: summary | yes |  |
| as-onboarded: A1_connectivity | yes |  |
| as-onboarded: A2_drc | yes |  |
| as-onboarded: A3_parity | yes |  |
| as-onboarded: A4_circuit | yes |  |
| as-onboarded: A5_anchors | yes |  |
| as-onboarded: A6_stack | yes |  |
| as-onboarded: A7_widths | yes |  |
| as-onboarded: A8_pairs | yes |  |
| as-onboarded: A9_heights | yes |  |
| stressed: summary | yes |  |
| stressed: A1_connectivity | yes |  |
| stressed: A2_drc | yes |  |
| stressed: A3_parity | yes |  |
| stressed: A4_circuit | yes |  |
| stressed: A5_anchors | yes |  |
| stressed: A6_stack | yes |  |
| stressed: A7_widths | yes |  |
| stressed: A8_pairs | yes |  |
| stressed: A9_heights | yes |  |
| live TS DRC path: summary equals oracle-DRC summary | yes |  |
| history: second run compares with baseline | yes |  |

Free-text fields that differ (wording only, compared apart): acceptance.manufacturing_rules.native_project_rules_basis, mechanical.basis, A8_pairs.note, A8_pairs.note.

## as-onboarded
the board against requirements onboarded from it

```json
{"verdicts":{"A1_connectivity":true,"A2_drc":false,"A3_parity":false,"A4_circuit":true,"A5_anchors":true,"A6_stack":true,"A7_widths":true,"A8_pairs":false,"A9_heights":true},"figures":{"A1":0,"A2":3,"A3":7,"A4":0,"A5":0,"A6":0,"A7":0,"A8":1,"A9":0}}
```

## stressed
edited requirements: power class + tap + currents + neck scaling, pair width, planes/no-track layers, via span, heights, exceptions, moved anchor, changed value/pins, missing part

```json
{"verdicts":{"A1_connectivity":true,"A2_drc":false,"A3_parity":false,"A4_circuit":false,"A5_anchors":false,"A6_stack":false,"A7_widths":false,"A8_pairs":false,"A9_heights":false},"figures":{"A1":0,"A2":3,"A3":7,"A4":3,"A5":1,"A6":140,"A7":4,"A8":27,"A9":14}}
```

---

## vme-wren (1508 parts, 24858 segments; recorded DRC, as-onboarded variant only)

Board: `/home/shane/pcb-cmp/vme-wren/proj2` (1508 footprints, 24858 segments, 4374 vias). Oracle: /home/shane/pcb-worktrees/heldout. kicad-cli: /usr/bin/kicad-cli-nightly.
One DRC run (0.0 s) feeds both sides; the live TypeScript DRC path took 0.7 s end to end.

| item | agrees | detail |
|---|---|---|
| onboard acceptance.json | yes |  |
| onboard circuit.json | yes |  |
| onboard mechanical.json | yes |  |
| onboard heights.json | yes |  |
| onboard anchor coordinates: max |oracle %g - TS| (mm), tolerance 1e-4 | NO | `0.0003999999999848569` |
| onboard fixed parts | yes |  |
| as-onboarded: summary | yes |  |
| as-onboarded: A1_connectivity | yes |  |
| as-onboarded: A2_drc | yes |  |
| as-onboarded: A3_parity | yes |  |
| as-onboarded: A4_circuit | yes |  |
| as-onboarded: A5_anchors | yes |  |
| as-onboarded: A6_stack | yes |  |
| as-onboarded: A7_widths | yes |  |
| as-onboarded: A8_pairs | yes |  |
| as-onboarded: A9_heights | yes |  |
| recorded TS DRC path: summary equals oracle-DRC summary | yes |  |
| history: second run compares with baseline | yes |  |

Free-text fields that differ (wording only, compared apart): acceptance.manufacturing_rules.native_project_rules_basis, mechanical.basis, A8_pairs.note.

## as-onboarded
the board against requirements onboarded from it

```json
{"verdicts":{"A1_connectivity":true,"A2_drc":false,"A3_parity":false,"A4_circuit":true,"A5_anchors":true,"A6_stack":true,"A7_widths":true,"A8_pairs":false,"A9_heights":true},"figures":{"A1":0,"A2":41,"A3":21,"A4":0,"A5":0,"A6":0,"A7":0,"A8":10,"A9":0}}
```

## Differences, exactly

1. Anchor coordinates. The oracle writes `mechanical.json` anchors with Python `%g` (6 significant digits), and A5 then
   requires the board to match within 1e-4 mm. For coordinates of 100 mm or more with sub-0.01 resolution the rounded text is off by up
   to 4e-4 mm on vme-wren, so the oracle's own A5 would fail on an untouched board. The port writes micron precision
   (`Number(x.toFixed(6))`). Every other requirements field is identical; A5 verdicts agree.
2. Free text (wording): `native_project_rules_basis`, `mechanical.basis` (the oracle names the source folder, the port the
   file), A8 `note`; the port does not name Python tools.
3. Design hash: the port hashes project-relative paths (portable); the oracle hashes absolute paths. Not comparable and not
   used for parity.

## Not ported in stage 1

`onboard.py` also builds a placer base (routed copper removed, fixed parts locked, courtyards added), `groups.json`,
router `spec.json`, escape keep-outs and pair pass-through templates. Those belong to the layout stage. The C6 legacy
acceptance profile (`C6_ACCEPTANCE_V1`) is dropped: acceptance without a stack policy is read as a plain two-layer board.
Boards in the pre-10 file format are refused with an upgrade hint (the oracle upgrades a copy with kicad-cli).
