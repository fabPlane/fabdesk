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
