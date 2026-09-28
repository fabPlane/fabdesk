# Native blinker diagnostic — 2026-09-15

This is a local product diagnostic, not an official Stage 1 score. The completed project and trace
remain at `/home/shane/fabdesk-native-agent-test/projects/native-agent-test`.

## Outcome

- 21m02s, 103 agent tool calls, 9,388,909 reported input tokens, 28,583 output tokens.
- Native schematic and PCB, 0 ERC errors, 0 DRC errors, 0 unconnected items, 0 parity conflicts,
  and 39/39 release outputs.
- `release.json` correctly recorded `pass: false`: its warning gate found eight unapproved
  `lib_footprint_mismatch` warnings. The old release summary omitted the gate reasons and the
  separate library-mismatch check failed to recognize KiCad's rule name, making the result easier
  for the agent to misreport.
- The initial schematic had 46 long Manhattan wire segments. Independently generated routes
  crossed/shared coordinates and merged unrelated nets into +5V. The agent deleted those wires
  and recovered correct connectivity with 33 pin-attached labels, leaving the final schematic
  electrically correct but visually weak and wire-free.
- Twelve copper edit results returned about 3.23 MB of repeated full-board geometry. Together with
  broad part-search results and repeated inspections, this drove extreme cumulative input usage.
- Board inspection rounded exact pad positions (for example 3.0875 mm to 3.088 mm), allowing
  hand-authored copper to miss pads by 0.0005 mm. Preview wording also implied more validation than
  it performed.

## Stock Codex + KiCad comparison

The preserved reference is
`/home/shane/fabdesk-projects/external-references/codex-cli-kicad/03-usbc-555-blinker`.
It took about 24m29s and used deterministic Python generators. Its schematic is materially better:
clear left-to-right functional blocks, visible wiring, readable annotations, and design notes. Its
50x40 mm PCB has readable reference text and a title, though it is larger and its component use of
space is sparse. The native Fabdesk run was about 3m27s faster and produced a more compact 40x25 mm
board plus a complete release bundle, but its schematic labels and PCB silkscreen overlap badly.

The useful Python advantage was not Python syntax or legacy `pcbnew` itself. It was deterministic
bulk geometry, exact transformed endpoints, compact programmable loops, and easy regeneration.
The local `fabpcb tool` JSON/JSONL interface remains the preferred way to provide those properties
without rebuilding deprecated SWIG bindings.

## Changes made after the run

- Compact native edit responses; previews now state that ERC/DRC/connectivity/presentation did not
  run.
- Exact coordinate preservation and semantic `{reference, pad}` copper endpoints.
- Safe, visible labelled pin stubs instead of automatic long Manhattan net chains.
- Native capability discovery excludes legacy compiler operations.
- Compact part-search hits and explicit `fabpcb tool` discovery in `pcb_environment`.
- `schematic_review` is visible and detects label collisions/label-only connectivity.
- The unsupported router layer override was removed; no-progress results retain endpoints and
  obstacle guidance.
- Release output includes gate state, failure reasons, warning signatures, and correctly detects
  KiCad library mismatch rules.
- Packaged KiCad receives `KICAD10_FOOTPRINT_DIR`/`KICAD10_SYMBOL_DIR`; placement reloads changed
  instances from those exact libraries before routing. An isolated probe reproduced all eight
  mismatches, then normalized exactly eight changed instances with zero missing libraries.
- Legacy netlist/libSource wording was removed from visible UI empty states.

## Next clean-run acceptance checks

Hard gates remain primary: release pass, zero ERC/DRC/parity/unconnected, complete outputs. Also
record elapsed time, tool calls, failed calls, input/output tokens, maximum tool-result bytes,
schematic-review findings, and human visual comparison with the preserved stock reference. A clean
run should not need manual copper repair caused by rounded endpoints, should never discover
`circuit_build`, and should not claim success after a release error.

## Second clean-project run

The follow-up project and trace remain unchanged at
`/home/shane/fabdesk-native-agent-test/projects/native-agent-test-2`. This was another local
diagnostic, not an official Stage 1 score.

- 12m33s, 63 agent tool calls (52 MCP, eight shell and three file changes), nine error-marked
  results, 4,230,636 reported input tokens and 13,818 output tokens.
- One `route_run` connected 29/29 items in 407 ms with 124 tracks and six vias. Final ERC and DRC
  reported zero errors, with zero unconnected items and parity conflicts, and 39/39 outputs existed.
- Overall release still correctly failed. Twelve newly created schematic symbols were marked as
  library mismatches: five resistors, four capacitors, one LED and two power flags. The two power
  flags also carried a fake `N/A` footprint.
- The agent changed `min_hole_clearance` from 0.25 mm to 0.18 mm to accept the USB-C footprint's
  locator-hole geometry. A green DRC obtained by globally weakening the project rule is not a clean
  benchmark pass.
- The first connection attempt again created crossing labelled stubs near J1. Review caught the
  collisions, but recovery required deleting 70 items and rebuilding nine nets.
- The final board was compact and electrically routed, but the schematic remained sparse and
  label-heavy, while PCB references overlapped components. It remains visually behind the stock
  Codex reference.

Relative to the first run, elapsed time fell 40%, tool calls fell 39%, reported input tokens fell
55%, and repeated routing disappeared. That is strong directional evidence that compact results,
exact endpoints and the smaller native surface improved execution efficiency. It is not evidence
of a clean product pass because integrity and presentation still failed.

## Corrections after the second run

Local commit `6e3fc09` fixes the newly exposed interface defects:

- native symbol instances preserve the library's pin-display properties, and the KiCad API session
  reloads saved files after symbol creation so ERC cannot retain transient mismatch markers;
- power-only symbols may omit a footprint, and one-pin labelled power nets are supported;
- schematic edits reject duplicate pin/net assignments and labelled stubs that cross other pins or
  planned nets before committing;
- default schematic inspection is compact, while full deletion IDs remain explicitly available;
- schematic review detects excessive label density and stub-only connectivity;
- release fails if project safety-rule floors were relaxed or if a nontrivial schematic is
  label-dense and contains only short stubs;
- `circuit_describe_part` is initially visible, avoiding host-library shell searches for exact part
  data; and
- PCB placement can position, resize or hide reference fields after library normalization.

Focused tests, the monorepo typecheck, the core build and the real packaged-KiCad native integration
test pass. No AppImage, push, PR or official evaluation was created.

## Third clean-project run

The post-correction run is preserved at
`/home/shane/fabdesk-native-agent-test/projects/native-agent-test-3`, with trace
`run_mu2dkmpt27be712b99`. It is the first genuine final-output hard-gate pass from this local
prototype:

- 28m50s, 122 agent tool calls (107 MCP, 11 shell and four file changes), 19 error-marked results,
  12,698,480 reported input tokens and 29,683 output tokens;
- final release `pass: true`, 39/39 outputs, zero ERC/DRC warnings or errors, zero unconnected or
  parity items, zero library mismatches, and unchanged 0.25/0.5/0.2 mm design-rule floors;
- 17 schematic symbols, 54 wires, no labels, 37 wires longer than 5.08 mm, and no automated
  schematic-presentation findings; and
- a complete second router pass connected 31/31 items in 261 ms with 129 tracks and seven vias.

The output pass was expensive. The agent initially selected a generic 16-pin USB-C symbol and
footprint, routed it partially, then discovered its locator-hole incompatibility and replaced it
with the correct six-contact power-only pair. This forced connector deletion, unroute, forward
annotation, replacement placement and a second route. Part compatibility should have been checked
before schematic construction.

The native authoring defect is also not fully resolved. Rotated Device:R instances and power
symbols still produced seven `lib_symbol_mismatch` warnings. The agent used 11 shell inspections
and four direct `board.kicad_sch` edits to repair the symbol cache before the second release. That
workaround produced a clean persisted artifact, but should not be necessary through the native
interface. Three zone attempts also failed because the tool accepts unexplained numeric layer IDs.

Visual composition improved substantially: the final schematic has actual functional wiring and
left-to-right structure. It still wastes most of the A4 sheet, overlaps several values and a long
note at the bottom, and remains behind the stock Codex reference. The 60x35 mm PCB is routed and
manufacturable, but sparse; the agent explicitly hid all 13 reference fields, so the assembly
silkscreen has no component identifiers. The existing release presentation check does not yet
cover PCB reference visibility.

Conclusion: the prototype can now deliver a valid release without weakened rules, and the
schematic-direction changes worked. The next iteration should prioritize early role-aware part
selection/compatibility, rotation-safe and power-symbol-safe native serialization, named PCB
layers, and PCB presentation checks before another blinker run.
