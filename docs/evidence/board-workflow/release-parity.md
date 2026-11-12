# Board workflow, release stage and silkscreen: parity with the Python toolkit

Date 2026-11-12. Oracle: toolkit branch `cmp/held-out-fixes` (`flow/bomcheck.py`, `jlcsim.py`, `gerbcheck.py`, `viaproc.py`,
`fab.py`, `silk.py`), read-only. Port: `packages/board-workflow/src/release/` and `src/silk/`; tools `board_release` and
`board_silk`. Harness: `packages/board-workflow/test/parity-release.ts` (not in `bun run test`; needs the toolkit, its
gerbonara venv, inkscape, kicad-cli and the network). Board: cm5_minima (112 parts) for BOM, CPL, gerbcheck, vias, fab;
silk also on R1N (75 parts), the TF battery board (49) and C6 (318).

Both BOM runs read the same evidence cache (Python fetches, TypeScript replays it) so the rows compare interpretation, not
the suppliers' answers on the day. The generated table is at the end; the rows below are what it does not say.

## What is ported, and how it differs

| Python | TypeScript | Difference (my decisions) |
|---|---|---|
| bomcheck.py | `release/bomcheck.ts`, `lookup.ts`, `footprint-fit.ts` | Same records. Cache keeps URL + fetch time per raw response; shared cache env is `FABDESK_BOARD_FETCH_CACHE` / `FABDESK_BOARD_FETCH_MAX_DAYS` (was `PCB_FETCH_*`). `(dnp no)` is not a DNP flag (Python treated any `(dnp ...)` child as one). Reason text says "edit swap fields" instead of naming `edit.py`. No JLC/LCSC lookup existed in Fabdesk to reuse (shopping goes through fabplane.com), so the three public lookups are ported. |
| jlcsim.py | `release/jlcsim.ts` | Field for field. `--proxies` is `board_release check {package, proxies}`; proxies are saved in the project. Gerber layers are found by layer name (Python needed `<stem>-F_Cu.gbr`; KiCad writes `.gtl` with Protel extensions). |
| gerbcheck.py | `release/gerber.ts`, `gerbcheck.ts` | Python: gerbonara -> inkscape PNG, FFT alignment. TS: own RS-274X reader -> SVG -> resvg (`rasterizeSvgPixels`, new export of `@fabdesk/kicad`) on the exact Edge.Cuts frame; best whole-pixel shift within 4 px replaces the FFT (it found 0, 0 on every layer: both renders share a frame). Same rule (share of the union beyond a 1-pixel band < 0.1 %), same drill count. Dropped: gerbonara as an independent implementation (my reader is independent of KiCad, not of my own parser bugs); step-and-repeat and block apertures are not read and are reported as limits. |
| viaproc.py | `release/viaproc.ts` | Field for field; `applyViaBindings` kept, but no tool writes the board: `fab` refuses and names the vias (the edit stage sets the attributes). |
| fab.py | `release/fab.ts`, `cam.ts`, `zip.ts` | Gate order as Python. Interconnect gate: hook (`setInterconnectGate`), none for a standalone project, recorded in the manifest. Review gate: `readReviewGate` of `board-state.ts` (none / stale / open / errors refuse). Acceptance: `runAcceptance` with parity, strict (not the no-regression done mode), exceptions only `CHECK=FILE#ID` with an owner decision (the old "decision in the intent file" has no Fabdesk equivalent yet). Via bindings. Then CAM twice with the same normalisation of date lines. Differences: the CAM layers are named explicitly (the cm5 board's saved plot settings write PDF, which Python's `--board-plot-params` + "layers present" test would have treated as present); the first export is the package (two exports, not three) and drill maps are Gerber X2, not PDF; nothing is written into the package folder until gates 1-4 pass (Python opened it before acceptance), and a later refusal leaves `REFUSED.json`; a BOM check of an earlier board refuses the JLC files (Python never compared); `apply_netclasses.py` is not ported (the project's `.kicad_pro` is the source of truth). |
| silk.py | `silk/*` | See below: pcbnew is not used. |

### Silkscreen without pcbnew

Source of each shape (measured against pcbnew on the same boards, below):

- pad mask openings (with expansion), untented vias, mask graphics, silk strokes: KiCad's own Gerber plot of `F/B.Mask` and
  `F/B.Silkscreen` from a copy of the board with every Reference hidden and the free silk texts removed; `%TO.C` gives the
  owning footprint. This is exact (the shapes are what KiCad plots), tessellated to 0.01 mm.
- courtyards, assembly outlines (body), board outline, label boxes, free text boxes: from the board file.
- text extent: a table measured from `PCB_TEXT::GetBoundingBox` (stable 10.0.6) for every printable ASCII glyph. The model
  (width = h * (sum of advances but the last + last ink width) + 3 t, height = 1.17 h + 3.51 t, pen = h/8 when none stated,
  at most h/4; keep-upright unless `(unlocked yes)`) reproduces pcbnew's label boxes within 0.02 mm on 100 % of the 318 + 112
  + 75 + 49 labels measured, except one footprint-less field box on cm5 (0.085 mm).
- Not exact: free texts are obstacles as their boxes (pcbnew used their strokes), so a text's box is a conservative stand-in
  (this is the one place the solver found no spot where Python did, TF board R21); a footprint's Value field on silk counts
  as that footprint's own silk (rare); footprints without a courtyard take their pad and graphics extent (matches to 0.02 mm).
- The solver rejects a spot within 1 um of the "nearer another part" threshold (its candidate gaps land exactly on it and a
  rounding in the written coordinates flips the check); written positions keep KiCad's 1 nm precision (Python wrote 6
  significant digits). The check itself is unchanged.

## Release run on cm5_minima, to the gates and past them

`fab` on a scratch copy of the board (onboarded, A1-A9 measured live, 2.8 s):

1. no review recorded: `STOP review gate`, package folder not created.
2. review gate recorded by hand in the scratch copy (`recordReviewGate`): `STOP acceptance: failing A2_drc, A3_parity, A8_pairs`
   (the board as received; the same three as stage 1).
3. with owner decisions for those three (`--accept` equivalent): `STOP via bindings: 1 via(s) in pads ... GND@87.5,69.4`;
   `viaproc` counts agree with Python (444 vias, 1 in a pad).
4. after setting `(filling yes) (capping yes)` on that via (review recorded again, since the board changed and the gate had gone
   stale): RELEASED in 20.5 s: 61 files, CAM 18 files identical after the date lines (0 byte-identical: the dates differ),
   Gerber render check passes 12/12 layers, STEP, zip, manifest with every hash. No JLC BOM/CPL (no BOM check made for this
   board; stated in the manifest).

## Not ported

- `export_dsn.py` (not mine). `fab.py --selftest` (the tool's `gerb` action covers its CAM + render steps on the project board).
- Python's PDF drill maps; pcbnew's exact silk stroke polygons for free texts; the "decision in the intent file" exception route.
- The interconnect contract gate itself (VAIO's `check_interconnect_release.py`): a hook only.

## Tests and verification

`bun run typecheck` passes. `bun run test`: board-workflow, tools, core all pass except 3 `finish-it HTTP` tests in apps/core
and 3 `packaged kicad-cli mechanical truth` tests in packages/kicad, which fail identically in the sibling worktree
`board-workflow` (not touched by this stage). New tests: `packages/board-workflow/test/{release,silk}.test.ts` (libraries, gates,
kicad-cli integration incl. a mutated Gerber and a full package), `packages/tools/test/board-{release,silk}.test.ts`
(tools, durable path, export_pos JLC file).

## Rows that differ, listed

- silk place, labels at the oracle's place: cm5 104/112, R1N 69/75, TF 41/49, C6 306/318. The solver is greedy and chaotic, so
  a sub-0.02 mm difference in an obstacle moves some labels; totals (placed / wanted / fit nowhere / problems after) are equal
  on cm5, R1N and C6, and the fit-nowhere sets are equal on R1N and C6 (cm5: R707 vs D702 swapped). TF: TS places 32 and hides
  17 against Python's 33 and 16 (R21 has no spot in TS: the free-text box obstacle). Every candidate judges 0 problems after.
- silk check, cm5: one more footprint-silk-over-copper hit in Python (8 vs 7).
- gerbcheck mutation "pad flash moved 0.3 mm" is invisible to both readers on a 112-part board (0.006 % of the drawn area, under
  the 0.1 % rule); the removed long track is caught by both (Python 891 px, TS 596 px beyond the band).

Timing (this machine, other agents running): silk place on C6 TS about 12 s against 37.6 s Python; silk check about 0.5 s each.

## Generated table (parity-release.ts)

| item | agrees | detail |
|---|---|---|
| bomcheck: bom-decisions.json (every record, field for field) | yes |  |
| bomcheck: CPL rows (26 Python, 26 TS: ref, LCSC, side, KiCad rotation, JLC offset, JLC rotation) | yes |  |
| bomcheck: swap-fields.json | yes |  |
| bomcheck: summary, lines, placements, rotation offsets, bottom placements | yes |  |
| gerbcheck: verdict per layer (12 layers) | yes |  |
| gerbcheck: drill files, tools and holes per file | yes |  |
| gerbcheck mutation (a pad flash moved 0.3 mm on F_Cu): both readers give the same verdict (Python pass, TS pass; beyond 1 px: 32 / 33) | yes |  |
| gerbcheck mutation (the first long track removed on B_Cu): both readers give the same verdict (Python FAIL, TS FAIL; beyond 1 px: 891 / 596) | yes |  |
| jlcsim on the board package (27 placements, 26 pass): summary and every part, field for field | yes |  |
| JLC package files: 14 BOM lines, 27 CPL rows, 3 rotations differ from KiCad, 2 positions moved to the pad centre | yes |  |
| jlcsim --proxies on the toolkit's C6 package (275 placements, 2 proxied, 2 fail): every part, field for field | yes |  |
| jlcsim --proxies on the toolkit's R1N package (110 placements, 4 proxied, 0 fail): every part, field for field | yes |  |
| viaproc: 444 vias, 1 in pads, 1 need fill+cap: counts and every binding | yes |  |
| silk check cm5_minima: labels 27, clean 0, bad 27, wanted 82, free texts 0 (0 bad): totals | yes |  |
| silk check cm5_minima: label issue counts (unlabelled 82, under-part 10, small 27, far 27, edge 3, over-copper 4, over-silk 1) | yes |  |
| silk check cm5_minima: footprint-silk-against-copper counts (outline-*: polygon sampling decides borderline touches), rows differing 3 of 109 | yes |  |
| silk place cm5_minima: placed / wanted / fit nowhere / after-check problems (TS 49/82/33/0, Python 49/82/33/0) | yes |  |
| silk place cm5_minima: every label at the oracle's place (within 0.02 mm) | **NO** | `{"same":104,"differ":["TP103","D702","U703","R707","J701","H102","TP106","CN1"]}` |
| silk check r1n: labels 4, clean 3, bad 1, wanted 73, free texts 6 (2 bad): totals | yes |  |
| silk check r1n: label issue counts (unlabelled 69, edge 1) | yes |  |
| silk check r1n: footprint-silk-against-copper counts (outline-*: polygon sampling decides borderline touches), rows differing 0 of 70 | yes |  |
| silk place r1n: placed / wanted / fit nowhere / after-check problems (TS 70/73/0/0, Python 70/73/0/0) | yes |  |
| silk place r1n: every label at the oracle's place (within 0.02 mm) | **NO** | `{"same":69,"differ":["H101","U702","M701","U706","R706","R705"]}` |
| silk check tf: labels 0, clean 0, bad 0, wanted 49, free texts 3 (3 bad): totals | yes |  |
| silk check tf: label issue counts (unlabelled 49) | yes |  |
| silk check tf: footprint-silk-against-copper counts (outline-*: polygon sampling decides borderline touches), rows differing 0 of 49 | yes |  |
| silk place tf: placed / wanted / fit nowhere / after-check problems (TS 32/49/17/0, Python 33/49/16/0) | **NO** | `{"differ":["C13","RV2","CV2","U1","RV1","R21","Q2","J1"],"nowhere":false}` |
| silk place tf: every label at the oracle's place (within 0.02 mm) | **NO** | `{"same":41,"differ":["C13","RV2","CV2","U1","RV1","R21","Q2","J1"]}` |
| silk check c6: labels 102, clean 0, bad 102, wanted 309, free texts 0 (0 bad): totals | yes |  |
| silk check c6: label issue counts (unlabelled 214, over-copper 90, under-part 87, small 66, over-silk 77, over-label 69, ambiguous 23, far 11, edge 7) | yes |  |
| silk check c6: footprint-silk-against-copper counts (outline-*: polygon sampling decides borderline touches), rows differing 0 of 316 | yes |  |
| silk place c6: placed / wanted / fit nowhere / after-check problems (TS 196/309/113/0, Python 196/309/113/0) | yes |  |
| silk place c6: every label at the oracle's place (within 0.02 mm) | **NO** | `{"same":306,"differ":["C18_C115","C18_U101","C18_C11","C18_R402","C18_U103","C18_IC201","C18_C107","A74_C38","A74_TP11","A74_R38"]}` |

Timing: BOM check Python 44.9 s (live lookups) / TS 0.06 s (replaying the cache); gerbcheck Python 19.2 s / TS 10.8 s.

## gerbcheck per layer (pixels beyond the 1-pixel band, 400 dpi)

| layer | Python | TS | Python pass | TS pass |
|---|---|---|---|---|
| B_Cu | 0 | 0 | true | true |
| B_Mask | 0 | 0 | true | true |
| B_Paste | 0 | 0 | true | true |
| B_Silkscreen | 14 | 17 | true | true |
| F_Cu | 0 | 0 | true | true |
| F_Mask | 0 | 0 | true | true |
| F_Paste | 0 | 0 | true | true |
| F_Silkscreen | 21 | 36 | true | true |
| In1_Cu | 0 | 0 | true | true |
| In2_Cu | 0 | 0 | true | true |
| In3_Cu | 0 | 0 | true | true |
| In4_Cu | 0 | 0 | true | true |

## packages (jlcsim)
- C6: 275 placements, 272 pass, 2 fail, 2 with a proxy footprint
- R1N: 110 placements, 109 pass, 0 fail, 4 with a proxy footprint

## silk
- cm5_minima: py {"unlabelled":82,"outline-overlap":11,"outline-over-copper":8,"under-part":10,"small":27,"far":27,"edge":3,"over-copper":4,"over-silk":1} | ts {"unlabelled":82,"outline-overlap":11,"outline-over-copper":7,"under-part":10,"small":27,"far":27,"edge":3,"over-copper":4,"over-silk":1} | rows differing 3/109
- cm5_minima place: TS 49/82 placed, 33 fit nowhere, after bad 0 (2.4 s) | Python 49/82, 33, bad 0 (8.0 s) | labels at the same place 104/112; fit-nowhere lists equal false; only labels changed true
- r1n: py {"unlabelled":69,"edge":1} | ts {"unlabelled":69,"edge":1} | rows differing 0/70
- r1n place: TS 70/73 placed, 0 fit nowhere, after bad 0 (1.9 s) | Python 70/73, 0, bad 0 (3.7 s) | labels at the same place 69/75; fit-nowhere lists equal true; only labels changed true
- tf: py {"unlabelled":49} | ts {"unlabelled":49} | rows differing 0/49
- tf place: TS 32/49 placed, 17 fit nowhere, after bad 0 (1.4 s) | Python 33/49, 16, bad 0 (1.8 s) | labels at the same place 41/49; fit-nowhere lists equal false; only labels changed true
- c6: py {"unlabelled":214,"outline-overlap":4,"over-copper":90,"under-part":87,"small":66,"over-silk":77,"over-label":69,"ambiguous":23,"far":11,"outline-over-copper":2,"edge":7} | ts {"unlabelled":214,"outline-overlap":4,"over-copper":90,"under-part":87,"small":66,"over-silk":77,"over-label":69,"ambiguous":23,"far":11,"outline-over-copper":2,"edge":7} | rows differing 0/316
- c6 place: TS 196/309 placed, 113 fit nowhere, after bad 0 (12.8 s) | Python 196/309, 113, bad 0 (34.7 s) | labels at the same place 306/318; fit-nowhere lists equal true; only labels changed true
