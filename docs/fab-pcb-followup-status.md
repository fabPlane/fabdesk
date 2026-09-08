# FabPlane PCB handoff follow-up status

This addendum audits every row of `handoff-fab-pcb.md` §6 against the follow-up feature branches.
It distinguishes implemented code from native-platform release proof.

| §6 item | Status | Evidence / remaining work |
| --- | --- | --- |
| 1. Bundle fork CLI + bridge | Partial | fab_pcb builds a standalone bridge bundle manifest for Linux/macOS/Windows; FabPlane desktop resolves, starts, health-checks and stops it. A Windows fork build script and native WebSocket transport exist. A Linux bundle was assembled and used for a real compile. Release CI still needs signed, dependency-complete runtime artifacts for all targets; no Windows/macOS runner was available here. |
| 1. Doctor `<10.99` warning | Complete | Doctor compares numeric KiCad versions and warns on unsupported stock builds; regression tests cover old, new and missing versions. |
| 2. Footprint libraries | Complete in bundle format | Bundle creation refuses missing/empty footprint or symbol trees. The bridge registers discovered libraries as enabled project rows. A Linux bundled-library compile resolved `Resistor_SMD:R_0402_1005Metric` and `Device:R`. Signed native release artifacts remain part of item 1. |
| 3. Route save | Complete | A successful route is saved after apply; save failure makes the job failed. Unit and live route tests cover it. |
| 3. Session path refresh | Complete | Bare-session project creation updates authoritative session metadata; bridge discovery and Fabdesk adoption see the new `.kicad_pro`. |
| 3. Footprint translation | Complete | `Footprint.translate` moves the anchor and absolute pads, fields, text and graphics while preserving unrelated state; unit and live round-trip coverage exists. |
| 3. ImportNetlist event | Complete | The KiCad fork publishes `DocumentChanged` after successful real import with document, revision and requesting client identity; native QA and Fabdesk integration cover it. |
| 4. Placement input | Complete | Optional `board.placements[{ref,position:{x,y}}]` is validated and applied after import through full footprint translation. Unlisted existing components retain manual positions; prefab geometry is fixed. Compiler, bridge and live tests cover it. |
| 5. Agent authoring quality | Partial | Agent docs and MCP prompt now require searched footprint/symbol ids, explain `libSource`, placement, rebuild preservation, warning review and Viagrid clear areas. `circuit_search_parts` searches either footprint or symbol libraries. A real interactive LLM/app run remains environment-dependent and must not be represented as performed by unit tests. |
| 6. Schematics | Complete for netlist-first generation | Compile loads `libSource` definitions, creates searchable symbols and labelled connected wire stubs, saves the schematic, diagnoses missing symbols/pins, and replaces only owned generated items on rebuild. Unit and live KiCad tests cover generation and manual-item preservation. Layout is deterministic, not human-authored functional grouping. |
| 7. Route Cinema | Complete for final applied geometry | Route jobs return actual newly applied/claimed trace, arc and via geometry. Fabdesk records pads/vias as static context and always emits final copper, including routes too fast to stream intermediate steps. The chosen JS solver still cannot expose intermediate geometry beyond its progress callbacks. |
| 8. Case-sensitive desktop test | Complete | The test detects filesystem case semantics instead of assuming either behavior. |
| 8. Freerouting tool exposure | Complete / unchanged decision | Freerouting remains an internal router implementation and is not exposed as a separate agent-level workflow. |
| 8. Historical benchmarks | Complete / documentation only | Existing benchmark results remain explicitly historical; no behavior depends on them. |

## tscircuit dependency audit

Fabdesk has no live tscircuit dependency. fab_pcb still directly imports
`@tscircuit/capacity-autorouter`; therefore “tscircuit completely removed” is false across the
three repositories. `js_autorouter` is not yet a safe replacement: it lacks incremental
progress/cancellation, fixed-via eligibility and claiming for laser-prefab routing, proven
existing-copper compatibility, and a redistribution decision for its private GPL-derived code.
The exact minimum migration work is documented in fab_pcb `packages/router/README.md`.

## Platform verification boundary

Linux: native KiCad was built; qa_api and live fab_pcb tests were run; a bundle containing 142
footprint and 221 symbol libraries started the bridge and compiled/saved a PCB and schematic.

Windows/macOS: target selection, path resolution, manifests, desktop resource wiring and the
Windows WebSocket path have automated/static coverage. No native runtime or installer execution
was performed on those operating systems. Signed, dependency-complete release artifacts are still
required before the distribution row is complete.
