# Last-mile tools: parity with the Python toolkit (connected path, return-path audit, view, region, edit bench run)

Date 2026-11-13. Oracle: the toolkit at `~/pcb` main `f107799`. Harness: `packages/board-workflow/test/parity-lastmile-tools.ts`
(not part of `bun run test`; needs the toolkit and the owner's boards). No router ran for any row (an eval held the machine).

| Toolkit | Port | Boards / cases | Result |
|---|---|---|---|
| `tools/net_path_measure.py` | `lastmile/netpath.ts` `measureNetPath`, reported by `board_route pairs` | every net with copper on C6 kb-fix112 (`f1a1d256`, sha256 c70c5380..., the board kb-fix112's RESULT.txt names), the kb-fix112 `before` board, C6 courtyard113 (`32fac8bb`), cm5_minima and vme-wren (`--slow`): 272 + 272 + 272 + 96 + 1305 nets, 149 / 149 / 149 / 58 / 785 two-pad nets measured, the rest compared on their error | agree: pads, connected / not, both lengths within 6e-14 mm (73 % bit-identical; the rest differ in the last bits of `math.dist` vs `Math.hypot`); kb-fix112 USB connected paths 27.571174 / 26.730600 mm equal the owner's `usb-paths.json`, mismatch 0.841 mm (the segment sums say 0.11) |
| `bench.py validate` pair audit | `lastmile/forensics.ts` `declaredPairNets` + `tmPairAudit(..., pairNets)` | declared pair nets on the five boards' requirements (26, 26, 26, 36, 10 nets); `tracemaker return-paths --nets` (TraceMaker 0.12.1) on kb-fix112's board | agree: same net lists; the TypeScript audit's text equals the oracle's command and is byte-identical to the owner's recorded `review/kb-fix112/tm-return-paths.txt` (4 warnings) |
| `tools/board_view.py --drc --layers` | `lastmile/view.ts` `renderBoardSvg` (`drc`, `layers`), `board_route view` (`drc`, `layers`, `candidate`) | the owner's calls from `review/c6-lastmile89` (krt-tmf2's scored board and its `acceptance.drc.json`: windows 48,46,75,65.4 and 32,24,74,46 on B), and the whole board with `--layers F.Cu,In2.Cu` and `In5.Cu,B.Cu,In1.Cu`; matplotlib's `plot` / `scatter` / `text` recorded and compared as sets with the SVG's elements | agree: DRC open lines (12), their end dots (23), net labels (11) in every window; tracks per layer (1670 and 1060) |
| `tools/route_region.py --around-opens M [--region ...] --escape` up to its router | last-mile `region:...;opens~M!escape` = `cut` + `escape` + `after-cut`, run by the step engine without the router | krt-tmf2's scored board with its DRC report: `opens~1.0`, `opens~2.5`, a box plus `opens~1.5` | agree: rip counts, the ripped board byte for byte, the escape counts (33 bridges, 47 stubs, 14 blocked) and the escaped board as a multiset of lines (uuids aside); the routing after it is KRT's `after-cut` plan (the toolkit routed with TraceMaker / fastroute), exercised on a stubbed KRT in `test/lastmile-engine.test.ts` |
| `flow/editbench.py run PLAN OUT [--heldout]` | `bench/editrun.ts` `runEditBench`, `scripts/bench.ts edit-run` | see below | see below |

Edit bench run. Two tasks, each side's own kicad-cli DRC (nightly) in turn:

- cm5_minima `value` (rule-picked resistor value change): both sides stop at apply with the same verdict (`FAIL apply: STOP the source
  project fails ['A3_parity'] before the edit`: cm5's unedited project has 7 parity items); keys, phases (impact, apply), coordinates
  and churn equal, and `edit-table` reads both results.
- C6-eco95 release `value` (onboarded by Fabdesk; the oracle given the same requirements): keys in the toolkit's order, phases
  (impact, apply, repair, proof, guard, diff), verdict `FAIL A2_drc,A7_widths`, final A1-A9, coordinates, interventions and churn
  equal, 8/10 rows. Two differ: `final_detail.drc` (Fabdesk's A2 also counts one `track_width` item: the toolkit's PWR-proxy rule
  for named power classes, inventory item 2, not ported here) and `repair_steps` (the toolkit opened its bench and tried finish, a7,
  rip + blockers:1.0 on the unedited board's inherited A7 failures, keeping nothing; the edit stage repairs only nets the edit cut,
  and a value change cuts none). Note: that oracle repair ran the toolkit's configured KRT on C6 for about two minutes; the harness's
  editrun section should be pointed at a board whose unedited copy passes A1 and A7, or run when the machine is free.

Deviations, by design:

- `view`: Fabdesk also marks each DRC violation's items (an orange cross titled with its type); the toolkit's `--drc` draws only
  unconnected items. Tracks are still filtered by `side` (the toolkit draws every side's tracks and filters only parts).
- `region` / `cut`: the routing after the cut is the last mile's KRT `after-cut` plan, as `replace:` already does; `--plan`,
  `--router fastroute` and the TraceMaker CLI pass are not reused. Like `route_region`, the cut prunes dangling copper on the whole
  board even when its boxes hold no copper.
- `edit-run`: the run works on a copy of the plan's project (`OUT/project`); the edit stage opens the repair bench only when the edit
  cut nets, so an edit that cuts nothing records no `bench_new` / `after_edit` (the toolkit opened one on every edited board).
- `netpath`: a segment on a layer outside the stack is skipped (the script raises).
