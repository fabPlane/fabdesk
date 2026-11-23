# Inner-power audit and impedance sections: parity with the toolkit

Toolkit main `f107799` (the C6 stack106 work, `440efe2`): `review/current_paths.py`, `review/power_stack.py`,
`tools/stack_audit.py` (`inspect`), `checks.py` `rise_ecss_2152_vac`, `review/atlc_section.py`, `review/short_section.py`,
`review/test_stack_resolution.py`. Port: `packages/board-workflow/src/review/{geos,current-paths,power-stack,atlc}.ts`,
`impedance.ts` `shortSection`; check `inner_power`; `board_review section` / `short_section`; engine `atlc`.

## Census and audit (`test/parity-power-stack.ts`)

The harness runs `inspect` + `audit` in the toolkit and `stackCensus` + `auditPower` on the same board, acceptance and
netlist, and compares every value (numbers bit for bit).

| Board | Acceptance | Nets | Numbers compared | Result |
| --- | --- | --- | --- | --- |
| C6-eco95 at fab116 (`236d0a8f`), the review run's `netlist.xml` | its own (supplier stack JLC08101H-3313) | 6, all PASS (KB_+3V3 19.04 C / 60.50 mV) | 7 972 | equal; the toolkit's audit also equals the run's `inner-power-complete.json` |
| C6-eco95 at stack106 adoption (`ca91e638`, git `e86b5369`) | its own at that commit | 6, all PASS (KB_+3V3 11.22 C / 48.89 mV) | 7 630 | equal; the toolkit's audit equals the owner's `stack106/power-adopted.json` |
| cm5_minima (`proj2`), kicad-cli netlist | onboard2 + 8 declared currents + a supplier stack (stress) | 8, all FAIL (missing terminals, 55 disconnected pairs, 1 or 0 terminals) | 8 769 | equal |
| vme-wren (`proj2`), kicad-cli netlist, `FLOW_SPEC` naming its 12-layer requirements | onboard2 + 20 declared currents + a supplier stack (stress) | 20, all FAIL (up to 5 705 nodes, 29 390 disconnected pairs) | 750 067 | equal (1.5 s in TypeScript) |

Without `FLOW_SPEC` the toolkit reads `*.Cu` pads on vme-wren as C6's 8 layers (its global board context), so 18 values
differ; Fabdesk takes the board's own copper layers (`stack_policy.copper_layers`, else the layer table).

What it took to be exact: pad outlines built as GEOS 3.12 buffers them (vertex formulas, start point, clockwise), GEOS's
distance / nearest-point / intersection / projection code paths (`geos.ts`), Python's `round(x, 6)` node keys, CPython 3.12's
`math.dist` (vector_norm) and `sum()` (Neumaier). The rotation matches shapely's numpy product without FMA (checked on 1 500
random points).

## Sections

- Bitmaps: all 9 stack106 sections (`usb-*`, `lvds-*`, `keyboard-escape-2um` with soldermask polygons; 4, 2 and 1 um)
  drawn by `sectionBitmap` have the sha256 the toolkit recorded.
- Solves (atlc 4.6.1): usb-class-4um, usb-class-2um, usb-target-2um, usb-tighter-2um, lvds-class-2um, lvds-edge-2um (RX1
  107.302 ohm), keyboard-escape-2um (107.198 ohm, 74 s): metrics equal to the records with Debian's `/usr/bin/atlc`, with a
  scratch source build, and with the engine the registry downloaded and built. The two 1 um solves (150 s each) were not
  rerun; their bitmaps are identical.
- `pairSection` equals `pair_section` on three parameter sets (stripline, masked microstrip, custom etch/margin) and
  reproduces the keyboard-escape spec.
- `shortSection` equals `section` on five cases and on the owner's `escape-input.json` (both rows of
  `escape-evaluation.json` identical).

## Tests

`test/power-stack.test.ts`: the toolkit's 6 regression cases, the check's gating and findings, the census's pin types, two
bitmap hashes; `packages/tools/test/atlc-engine.test.ts`: catalog, install + build (fakes), failure, ATLC_BIN / PATH,
`short_section`.
