> **Note:** this stage first shipped as a separate `board_lastmile` tool. It is now the last-mile `action`s of `board_route` (see [integration.md](integration.md) §3); the library, the harness and the figures below are unchanged.

# Board workflow, last-mile stage: parity with the Python toolkit

Date 2026-11-12. Oracle: toolkit branch `cmp/held-out-fixes` (`tools/lastmile.py`, `tools/bench.py`, `tools/pairfix.py`,
`tools/crossing_check.py`). Port: `packages/board-workflow/src/lastmile/`, tool `board_lastmile`
(`packages/tools/src/tools/board-lastmile.ts`, to be folded into `board_route`). Harness:
`packages/board-workflow/test/parity-lastmile.ts` (not part of `bun run test`; needs the toolkit and kicad-cli).

Board: cm5_minima (`/home/shane/pcb-cmp/cm5_minima/proj2`, 112 footprints, 1884 segments, 18 differential pairs), spec
`/home/shane/pcb-cmp/cm5_minima/onboard/spec.json`. Both sides read the same files; the TypeScript side onboards the copy itself
(requirements equal to the oracle's, stage 1). One kicad-cli run per score (about 2.5 s). Run four times after the last code change: as the board is
(`--tighten .`) and with every pair class's `diff_pair_gap` set to 0.30 and to 0.20 in the requirements
of both sides (a board "laid out to other rules"; 0.20 makes all 18 pairs tighten: 439 groups planned, 2318 segments; run twice, the
second with the bench row). All four runs: 22 of 22 rows agree (the last has a 23rd, TypeScript-only row). An earlier run, before the
fix of the failing flag of a pair (the oracle also counts the N net), had 21 of 22 and is not counted. Run output: `lastmile-parity.md` of that run, last variant below.

| item | agrees | detail |
|---|---|---|
| new: one-line figures | yes |  |
| new: figures.open | yes |  |
| new: figures.drc | yes |  |
| new: figures.a7 | yes |  |
| new: figures.a7_mm | yes |  |
| new: figures.a8 | yes |  |
| new: figures.pairs_todo | yes |  |
| new: figures.pairs (coupled share, length difference, skew limit, failing per pair) | yes |  |
| timing: oracle 2.8 s, TypeScript 2.3 s | yes |  |
| pairs measure --why: 18 pair lines identical | yes |  |
| pairs measure (no --why): lines identical | yes |  |
| crossings: 3 rows identical (ref, neighbour, counts, rotations) | yes |  |
| gate: 400 random figure pairs give identical reasons | yes |  |
| tighten .: per-pair coupled share and length difference, before and after (18 pairs) | yes |  |
| tighten: groups_planned | yes |  |
| tighten: groups_applied | yes |  |
| tighten: collateral_items | yes |  |
| tighten: width_planned | yes |  |
| tighten: group modes | yes |  |
| tighten: reverted groups | yes |  |
| tighten: edited boards' segments identical (net, layer, ends to 1 um, width); 2318 vs 2318 | yes |  |
| tighten timing: oracle 3.2 s, TypeScript 4.8 s | yes |  |
| bench try tighten:. (TypeScript only): accepted | yes |  |

## What the rows compare

- **new**: `lastmile new WS SRC` against `Bench.create`: open connections, DRC error classes (without the 8 inherited `hole_clearance`),
  A7 nets and mm, A8 nets, pairs to re-route, and per pair coupled share / length difference / skew limit / failing.
- **pairs measure**: `pairfix.py measure --why` against `measurePairs`: the printed line of each pair (share, target, P and N length,
  spacing histogram, widths, uncoupled mm by cause) is character-identical.
- **crossings**: `crossing_check.py --json` against `findCrossings` (the oracle's `fixed` set from the spec is given to both).
- **gate**: `lastmile.gate` against `gate` on 400 seeded random figure pairs (random slack): identical reason lists.
- **tighten**: `pairfix.py run --ops width,tighten` against `runTighten`: per-pair share and length difference before and after, groups
  planned / applied / reverted, group modes, collateral items, and the edited boards' segment sets (net, layer, ends to 1 um, width)
  identical. DRC rounds are real kicad-cli runs on both sides.

## Differences and what is not ported (my own decisions)

> **Superseded (2026-11-12, `feat/board-workflow-lastmile-repair`).** The router, rip, nudge and pair gaps this section
> listed are closed: the step engine (`lastmile/engine.ts`) runs each KRT step's own plan through `routeKrt`, `repair` steps rip
> with `lastmile/rip.ts` ([rip parity](lastmile-rip-parity.md)), `nudge` / `turn` / `fit` place with `lastmile/nudge.ts`
> ([nudge parity](lastmile-nudge-parity.md)), and `tighten` runs all six pair ops ([pair-op parity](lastmile-pairops-parity.md):
> R1N A8 24 -> 6, worst length difference 4.27 -> 1.57 mm, as the toolkit). `why` runs KRT's `net_forensics` and TraceMaker's
> `causes` when installed; `validate` adds TraceMaker's pair and return-path audits. The original text follows as history.

- **`try finish` and the other router steps are not compared.** (history) The toolkit runs KRT (`route_krt.py`); at the time the
  TypeScript bench ran the host's routers through a `StepEngine`. The bench logic around a router step is tested with fake engines
  (`test/lastmile.test.ts`), and a real tighten step goes through it on cm5_minima (last row above: A8 1 to 0, accepted).
- (history) `rip_items.py`, `nudge_place.py` and the pair ops `vias`, `mirror`, `mirror-force`, `retune`, `skew` were not ported, so
  the toolkit's "R1N A8 24 to 6" result was not reproduced; `why` read only the board model and `validate` ran no TraceMaker audits.
- **`view`** draws the board model as SVG (outline box, pads as circles, tracks, vias, opens, references) and rasterises it with the
  host's SVG rasteriser; the toolkit drew PNG with matplotlib including courtyards. `info` omits the courtyard size (not in the board model).
- **`crossings`** in the tool treats anchors, locked parts and the default pattern `_(J|SW)\d|^FIT_` as fixed; the toolkit used the flow
  spec's `fixed` regex (the harness gives both the spec's, so the rows agree).
- **`block_eval.py`, `block_inventory.py`, `block_pass.py`**: not ported. `bench.py` does not call them (they belong to the layout flow).
- **`pairbench.py`** (the several-boards table) is not ported as a tool; the harness above is the equivalent comparison for one board.
- **Scoring flags.** The bench scores with `kicad-cli pcb drc` **without** `--severity-all`, as the toolkit does. With `--severity-all` the
  same board gives different counts (`courtyards_overlap` 2 instead of 1, 24 `hole_clearance`, 3 `via_dangling`): `--severity-all` also
  reports violations the project marks ignored or excluded. `KicadService.runDrc` therefore gained `severity: "project"` (no severity flag).
  **`board_check` calls it with `severity: "all"`**; on this board that reads 2 courtyard overlaps where the toolkit reads 1. The edit stage
  found the same through the `excluded` flag and filters it when reading the JSON.
- **Score caching.** A candidate folder's score is written beside it (`lastmile.score.json`) and read back, where the toolkit recomputed
  figures from `acceptance.json` on every call. The figures are a function of the board file, so the numbers are the same.
- **Memory and budget** follow the toolkit's rules: 0.06 GiB per board MB per parallel candidate, 2 GiB kept, budget
  `max(180 s, 6 s per open)` up to 1800 s (`sizeLimits`, unit-tested including the 85 MB / 141-open case).
- Timing on this board (oracle then TypeScript): `new` 2.8 s / 2.3 s; `tighten` over all 18 pairs at gap 0.20 3.2 s / 4.8 s (439 groups).
