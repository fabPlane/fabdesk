# Edit keys `copper`, `hole`, `stack`: parity with the toolkit

Harness: `bun packages/board-workflow/test/parity-editkeys.ts --out DIR [--toolkit ~/pcb]` (toolkit main `f107799`; no router, no
kicad-cli). Run 2026-11-13: **44/44 agree**.

| Section | Cases | Result |
| --- | --- | --- |
| GEOS arithmetic | crossing point, project, interpolate and point-segment distance on 4000 random segment pairs (1121 intersecting) against shapely 2.0.3 / GEOS 3.12.1 | every double equal |
| `copper` (copper_plan.py) | kb-fix112 `copper.json`, `cleanup.json`, `tiny-tails.json` on kb-fix112/before, pin-fit115/before and the current C6 release; `tiny-tails` without its guard; `remove_items` (11 real uuids, real guard) with pruning; cm5_minima with its 12 busiest signal nets pruned; the unit fixture. uuid4 replaced by a counter on both sides | boards byte for byte (3.3-3.8 MB), ledgers equal; the same refusals (source mismatch, via already at C18_C104.2, uuid not found). Python 0.6-13 s per C6 run, fabdesk 0.1-0.6 s |
| `hole` (mechanical_hole.py) | pin-fit115 `plan.json` (FIT_P2 1.6 round to 2.0 x 1.8 oval) on its recorded source `8686d142`; FIT_P2 round 1.8; FIT_P1 oval | board and library footprint byte for byte; the candidate is the recorded `236d0a8f` |
| `stack` (stack_plan.py) | stack106 `plan`, `lvds-plan`, `final-plan`, `cleanup-plan`, `adoption-plan` chained (each from the previous output) from `release-fab104-source`; a `copper_source` + dielectric plan | boards byte for byte; acceptance.json equal in values and key order (an integral float is written `4`, Python wrote `4.0`) |
| pipeline | the three plans through `runEdit` (impact, apply, A1-A9 with a stub DRC, diff) on onboarded C6 projects | candidate boards equal the oracle's (copper: new uuids masked); 0 collateral nets; hole and copper PASS (no regression); stack FAIL A7, A8 (strict), as the owner's run before its bench repairs |

Native proof: the hole candidate through `runEdit` with kicad-cli DRC (refill, schematic parity): PASS (no regression). DRC before and
after are identical (8 hole_clearance, 4 courtyards_overlap; A7 7 nets): the board's inherited findings that the acceptance file's named
exceptions and allowances judge.

Not replayed: the kb-fix112 plans' own input boards (`compact2/C6.kicad_pcb` b97d01e2, `usb-skew2/edited` 258a551d, `clean3` 315ca270) and
stack106's `stack105` source and `copper_source` bench board were deleted by the owner's 2026-11-13 cleanup (hashes only in
`reports/cleanup-fab-20261113/removed-files.jsonl.gz`); the plans were replayed on the boards that remain.
