# Board workflow, last mile: pair ops `vias`, `mirror`, `mirror-force`, `retune`, `skew` — parity with pairfix.py

Date 2026-11-12. Oracle: `tools/pairfix.py` of the toolkit, `cmp/held-out-fixes` (`~/pcb-worktrees/heldout`, the harness default) and
`main` (`~/pcb`); the two `pairfix.py` files are identical (sha256 `f9bcfa1eba78e154…`), their `check_acceptance.py` differ. Port:
`packages/board-workflow/src/lastmile/pairops.ts` (the five ops as passes), `src/lastmile/tighten.ts` (`runTighten`: the op order of
`cmd_run`, default `--ops vias,mirror,retune,width,tighten,skew`, `UNPORTED` empty). Harness: `packages/board-workflow/test/parity-pairops.ts`
(not part of `bun run test`; needs the toolkit and kicad-cli `/usr/bin/kicad-cli-nightly`). Unit tests on synthetic boards:
`test/pairops.test.ts` (each op, its DRC-refusal path, the six ops through `runTighten`).

## Acceptance result: R1N, the bench `tighten` action (all six ops)

The R1N carrier in the state of pairs97/pairs98 (A8 24): `io-c6/release/R1N-bom` (board sha256 `a659e179…`, untouched since) with the
work-copy acceptance of pairs97/98 (`io-c6/review/pairs98/r1n-acceptance-work.json`: pair layers F/B, `router_rules`), spec = the release
spec pointing at that copy. The work folder `io-c6/work/pairs97/R1N` that `pairbench-v4` used no longer exists; this reconstruction
reproduces its start figures exactly (open 0, DRC 0, A7 0, A8 24, pairs-todo 13, the same per-pair figures).

| | A8 nets | worst ΔL mm | DRC | collateral | pairfix wall s |
|---|---|---|---|---|---|
| pairs98 (`pairbench-v4.md`, 2026-11-11) | 24 → 6 | 4.27 → 1.57 | 0 | 0 | 24 (bench try) |
| oracle today (heldout, and `~/pcb`) | 24 → **6** | 4.27 → **1.57** | 0 | 0 | 20.6 – 23.0 |
| TypeScript `runTighten` | 24 → **6** | 4.27 → **1.57** | 0 | 0 | 21.6 – 25.0 |

With the oracle at `PYTHONHASHSEED=37` (see "retune walk direction" below) the two edited boards are **byte-identical** (`cmp`),
segment uuids included. Per round (identical on both sides):

| pass | rounds (active → new DRC items) | result |
|---|---|---|
| vias | 25 → 7, 25 → 0 | 25 transitions: 10 `both`, 15 `N only` (which moves nothing: quirk 1), 0 refused |
| mirror | 5 → 0 | 5 chain pairs applied (PCIE RX, TX, USB3-0-RX, HDMI CK, D0; N follows P), 69 skip reasons |
| retune | 6 → 7, 3 → 0 | 3 wiggles rebuilt (HDMI D1_N, D2_N, RECOVERY_CONN_DM; L_old = L_new), 3 refused (PCIE CLK_N, USB2P.D_P, USB3-1-D_N) |
| width/tighten | 115 groups, 59 widths, 118 jogs → 3 clearance; 115 groups, 110 jogs → 0 | 115/115 applied (both 96, N only 10, P only 9), 4 groups reverted, 15 invalid geometry, widths 0.14 ×53 / 0.147 ×6 |
| skew | 3 segments → 0 | RECOVERY_CONN 4.27 → 0.10 mm (3.674 mm placed on 3 segments, 1 coupled) |

Per pair, coupled share and |P − N| mm, before → after (both sides):

| pair | coupled | ΔL mm |
|---|---|---|
| /CM5/PCIE_PI.CLK_P / CLK_N | 0.0 → 0.74 | 0.01 → 0.24 |
| /CM5/PCIE_PI.RX_P / RX_N | 0.16 → 0.97 | 0.03 → 0.11 |
| /CM5/PCIE_PI.TX_P / TX_N | 0.16 → 0.97 | 0.0 → 0.59 |
| /USB/USB3_C_RX1_P / RX1_N | 0.29 → 0.42 | 0.0 → 0.13 |
| /USB/USB3_C_RX2_P / RX2_N | 0.0 → 0.11 | 0.0 → 0.02 |
| /USB/USB3_C_TX1_P / TX1_N | 0.0 → 0.0 | 0.0 → 0.0 |
| /USB/USB3_C_TX2_P / TX2_N | 0.24 → 0.26 | 0.02 → 0.57 |
| USB3-0-RX_P / RX_N | 0.01 → 0.91 | 0.0 → 0.06 |
| USB3-0-TX_P / TX_N | 0.68 → 0.84 | 0.0 → 0.09 |
| /CM5/USB2P.D_P / D_N | 0.52 → 0.59 | 0.1 → 0.37 |
| RD_UP_DP / DM | 0.92 → 0.93 | 0.0 → 0.28 |
| USB3-1-D_P / D_N | 0.89 → 0.89 | 0.0 → 0.44 |
| /CM5/HDMI_PI.CK_P / CK_N | 0.03 → 0.51 | 0.0 → 1.57 |
| /CM5/HDMI_PI.D0_P / D0_N | 0.22 → 0.61 | 0.01 → 1.18 |
| /CM5/HDMI_PI.D1_P / D1_N | 0.17 → 0.58 | 0.01 → 0.88 |
| /CM5/HDMI_PI.D2_P / D2_N | 0.23 → 0.62 | 0.05 → 1.19 |
| RECOVERY_CONN_DP / DM | 0.69 → 0.69 | 4.27 → 0.1 |
| RECOVERY_DP / DM | 0.94 → 0.95 | 0.01 → 0.0 |

## What the harness compares

Both sides start from the same scored board (oracle `lastmile new`, TypeScript `Bench.create`) and read the same requirements (the
spec's folder). Per run `pairfix.py run S0 OUT --ops X --score` against `runTighten({ step: { args: ["--ops", X] } })`:

- each pass's report, key by key, timing removed: vias (transitions, rounds, applied with mode, refused), mirror (chain pairs, rounds,
  every skip reason string, applied, refused, `vias_moved`, `displaced`), retune (chains, rounds, applied with bumps/h/L_old/L_new,
  refused), skew (pairs over limit, rounds, per pair extra/placed/segments/on_coupled/banned);
- the width/tighten rounds (active groups, width changes, jogs, new DRC items by type), final new DRC, groups planned/applied/reverted/
  invalid, group modes, widths planned/applied, collateral items (non-pair segments and non-pair vias, byte compare);
- per-pair coupled share and length difference before and after;
- the edited boards scored, the oracle's by its own `lastmile.figures` on `OUT/score`, ours by the TypeScript scorer: open, DRC classes,
  A7, A8, pairs-todo, per-pair figures;
- the edited boards' segments (net, layer, both ends to 1 µm, width; ends in either order) and vias (net, position to 1 µm, size,
  layers), plus a count of segments written with start and end swapped;
- with `--toolkit2`, the six-op chain of the second oracle against the first.

DRC rounds are real kicad-cli runs on both sides; routers are not run.

## Results

Runs, one board at a time, after the last code change: R1N every op alone and the chain (`p2`), R1N chain at seed 37 (`p4`; and an
earlier `p3`, retune alone plus the chain at seed 37: 69 of 69, retune alone byte-identical), cm5_minima as it is (`p1`), and
cm5_minima with every pair class at `diff_pair_gap` 0.20 on both sides (`p2`: the stress variant of `lastmile-parity.md`, 437 tighten
groups, mirror applied). The cm5 boards exercise mirror, mirror-force, skew planning and the large width/tighten path; vias and retune
find nothing there (no P/N via transitions apart, no one-sided wiggles). R1N exercises every op including DRC refusals of vias and
retune. Not exercised by either board, unit-tested only: mirror-force moving a plane-only ground via (0 moved on both boards) and
skew banning a segment DRC named (skew rounds were clean).

#### R1N, every op alone and the six-op chain (oracle default hash seed; --toolkit2 ~/pcb)

Start: figures.open yes, figures.drc yes, figures.a7 yes, figures.a8 yes, figures.pairs_todo yes, figures.pairs yes, A8 at start: oracle 24, TypeScript 24 yes

| ops | A8 start | A8 oracle | A8 TS | DRC oracle / TS | worst ΔL oracle / TS mm | oracle s (incl. score) | TS s |
|---|---|---|---|---|---|---|---|
| `vias` | 24 | 24 | 24 | {} | 4.27 / 4.27 | 13.9 | 10.3 |
| `mirror` | 24 | 20 | 20 | {} | 4.27 / 4.27 | 14.5 | 10.6 |
| `mirror-force` | 24 | 20 | 20 | {} | 4.27 / 4.27 | 16.2 | 12.5 |
| `retune` | 24 | 24 | 24 | {} | 4.27 / 4.27 | 14.3 | 9.9 |
| `width,tighten` | 24 | 14 | 14 | {} | 3.78 / 3.78 | 11.7 | 7.7 |
| `skew` | 24 | 24 | 24 | {} | 0.1 / 0.1 | 11.4 | 7.4 |
| `vias,mirror,retune,width,tighten,skew` | 24 | 6 | 6 | {} | 1.57 / 1.57 | 28.3 | 21.6 |

| item | `vias` | `mirror` | `mirror-force` | `retune` | `width,tighten` | `skew` | `six-op chain` |
|---|---|---|---|---|---|---|---|
| vias.transitions | yes | — | — | — | — | — | yes |
| vias.rounds | yes | — | — | — | — | — | yes |
| vias.applied | yes | — | — | — | — | — | yes |
| vias.refused | yes | — | — | — | — | — | yes |
| width/tighten rounds (groups, widths, jogs, new DRC by type) | yes | yes | yes | yes | yes | yes | yes |
| final_new_drc | yes | yes | yes | yes | yes | yes | yes |
| groups_planned | yes | yes | yes | yes | yes | yes | yes |
| groups_applied | yes | yes | yes | yes | yes | yes | yes |
| group_modes | yes | yes | yes | yes | yes | yes | yes |
| groups_reverted | yes | yes | yes | yes | yes | yes | yes |
| groups_invalid_geometry | yes | yes | yes | yes | yes | yes | yes |
| width_planned | yes | yes | yes | yes | yes | yes | yes |
| width_applied | yes | yes | yes | yes | yes | yes | yes |
| collateral_items | yes | yes | yes | yes | yes | yes | yes |
| per-pair coupled share and length difference, before and after | yes | yes | yes | yes | yes | yes | yes |
| edited board figures.open | yes | yes | yes | yes | yes | yes | yes |
| edited board figures.drc | yes | yes | yes | yes | yes | yes | yes |
| edited board figures.a7 | yes | yes | yes | yes | yes | yes | yes |
| edited board figures.a8 | yes | yes | yes | yes | yes | yes | yes |
| edited board figures.pairs_todo | yes | yes | yes | yes | yes | yes | yes |
| edited board figures.pairs | yes | yes | yes | yes | yes | yes | yes |
| edited boards' segments (net, layer, ends to 1 um, width) | yes | yes | yes | yes | yes | yes | yes |
| segments written start/end swapped (count) | 0 | 0 | 0 | 37 | 0 | 0 | 22 |
| edited boards' vias (net, at to 1 um, size, layers) | yes | yes | yes | yes | yes | yes | yes |
| mirror.chain_pairs | — | yes | yes | — | — | — | yes |
| mirror.rounds | — | yes | yes | — | — | — | yes |
| mirror.skipped | — | yes | yes | — | — | — | yes |
| mirror.applied | — | yes | yes | — | — | — | yes |
| mirror.refused | — | yes | yes | — | — | — | yes |
| mirror.vias_moved | — | — | yes | — | — | — | — |
| mirror.displaced | — | — | yes | — | — | — | — |
| retune.chains | — | — | — | yes | — | — | yes |
| retune.rounds | — | — | — | **NO** | — | — | yes |
| retune.applied | — | — | — | yes | — | — | yes |
| retune.refused | — | — | — | yes | — | — | yes |
| skew.pairs_over_limit | — | — | — | — | — | yes | yes |
| skew.rounds | — | — | — | — | — | yes | yes |
| skew.pairs | — | — | — | — | — | yes | yes |
| oracles agree: pairfix.json | — | — | — | — | — | — | **NO** |
| oracles agree: edited segments | — | — | — | — | — | — | yes |

193 of 195 rows agree.

#### R1N, six-op chain with the oracle at PYTHONHASHSEED 37

Start: figures.open yes, figures.drc yes, figures.a7 yes, figures.a8 yes, figures.pairs_todo yes, figures.pairs yes, A8 at start: oracle 24, TypeScript 24 yes

| ops | A8 start | A8 oracle | A8 TS | DRC oracle / TS | worst ΔL oracle / TS mm | oracle s (incl. score) | TS s |
|---|---|---|---|---|---|---|---|
| `vias,mirror,retune,width,tighten,skew` | 24 | 6 | 6 | {} | 1.57 / 1.57 | 26.1 | 21.7 |

| item | `six-op chain` |
|---|---|
| vias.transitions | yes |
| vias.rounds | yes |
| vias.applied | yes |
| vias.refused | yes |
| mirror.chain_pairs | yes |
| mirror.rounds | yes |
| mirror.skipped | yes |
| mirror.applied | yes |
| mirror.refused | yes |
| retune.chains | yes |
| retune.rounds | yes |
| retune.applied | yes |
| retune.refused | yes |
| skew.pairs_over_limit | yes |
| skew.rounds | yes |
| skew.pairs | yes |
| width/tighten rounds (groups, widths, jogs, new DRC by type) | yes |
| final_new_drc | yes |
| groups_planned | yes |
| groups_applied | yes |
| group_modes | yes |
| groups_reverted | yes |
| groups_invalid_geometry | yes |
| width_planned | yes |
| width_applied | yes |
| collateral_items | yes |
| per-pair coupled share and length difference, before and after | yes |
| edited board figures.open | yes |
| edited board figures.drc | yes |
| edited board figures.a7 | yes |
| edited board figures.a8 | yes |
| edited board figures.pairs_todo | yes |
| edited board figures.pairs | yes |
| edited boards' segments (net, layer, ends to 1 um, width) | yes |
| segments written start/end swapped (count) | 0 |
| edited boards' vias (net, at to 1 um, size, layers) | yes |

44 of 44 rows agree.

#### cm5_minima as it is (--toolkit2 ~/pcb)

Start: figures.open yes, figures.drc yes, figures.a7 yes, figures.a8 yes, figures.pairs_todo yes, figures.pairs yes, A8 at start: oracle 1, TypeScript 1 yes

| ops | A8 start | A8 oracle | A8 TS | DRC oracle / TS | worst ΔL oracle / TS mm | oracle s (incl. score) | TS s |
|---|---|---|---|---|---|---|---|
| `vias` | 1 | 1 | 1 | {"courtyards_overlap": 1, "copper_edge_clearance": 2} | 4.75 / 4.75 | 6.4 | 4.7 |
| `mirror` | 1 | 1 | 1 | {"courtyards_overlap": 1, "copper_edge_clearance": 2} | 4.75 / 4.75 | 8.7 | 7.0 |
| `mirror-force` | 1 | 1 | 1 | {"courtyards_overlap": 1, "copper_edge_clearance": 2} | 4.75 / 4.75 | 11.3 | 9.2 |
| `retune` | 1 | 1 | 1 | {"courtyards_overlap": 1, "copper_edge_clearance": 2} | 4.75 / 4.75 | 6.2 | 4.6 |
| `width,tighten` | 1 | 0 | 0 | {"courtyards_overlap": 1, "copper_edge_clearance": 2} | 4.75 / 4.75 | 10.5 | 9.3 |
| `skew` | 1 | 1 | 1 | {"courtyards_overlap": 1, "copper_edge_clearance": 2} | 4.75 / 4.75 | 6.2 | 4.7 |
| `vias,mirror,retune,width,tighten,skew` | 1 | 0 | 0 | {"courtyards_overlap": 1, "copper_edge_clearance": 2} | 4.75 / 4.75 | 14.0 | 11.2 |

| item | `vias` | `mirror` | `mirror-force` | `retune` | `width,tighten` | `skew` | `six-op chain` |
|---|---|---|---|---|---|---|---|
| vias.transitions | yes | — | — | — | — | — | yes |
| vias.rounds | yes | — | — | — | — | — | yes |
| vias.applied | yes | — | — | — | — | — | yes |
| vias.refused | yes | — | — | — | — | — | yes |
| width/tighten rounds (groups, widths, jogs, new DRC by type) | yes | yes | yes | yes | yes | yes | yes |
| final_new_drc | yes | yes | yes | yes | yes | yes | yes |
| groups_planned | yes | yes | yes | yes | yes | yes | yes |
| groups_applied | yes | yes | yes | yes | yes | yes | yes |
| group_modes | yes | yes | yes | yes | yes | yes | yes |
| groups_reverted | yes | yes | yes | yes | yes | yes | yes |
| groups_invalid_geometry | yes | yes | yes | yes | yes | yes | yes |
| width_planned | yes | yes | yes | yes | yes | yes | yes |
| width_applied | yes | yes | yes | yes | yes | yes | yes |
| collateral_items | yes | yes | yes | yes | yes | yes | yes |
| per-pair coupled share and length difference, before and after | yes | yes | yes | yes | yes | yes | yes |
| edited board figures.open | yes | yes | yes | yes | yes | yes | yes |
| edited board figures.drc | yes | yes | yes | yes | yes | yes | yes |
| edited board figures.a7 | yes | yes | yes | yes | yes | yes | yes |
| edited board figures.a8 | yes | yes | yes | yes | yes | yes | yes |
| edited board figures.pairs_todo | yes | yes | yes | yes | yes | yes | yes |
| edited board figures.pairs | yes | yes | yes | yes | yes | yes | yes |
| edited boards' segments (net, layer, ends to 1 um, width) | yes | yes | yes | yes | yes | yes | yes |
| segments written start/end swapped (count) | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| edited boards' vias (net, at to 1 um, size, layers) | yes | yes | yes | yes | yes | yes | yes |
| mirror.chain_pairs | — | yes | yes | — | — | — | yes |
| mirror.rounds | — | yes | yes | — | — | — | yes |
| mirror.skipped | — | yes | yes | — | — | — | yes |
| mirror.applied | — | yes | yes | — | — | — | yes |
| mirror.refused | — | yes | yes | — | — | — | yes |
| mirror.vias_moved | — | — | yes | — | — | — | — |
| mirror.displaced | — | — | yes | — | — | — | — |
| retune.chains | — | — | — | yes | — | — | yes |
| retune.rounds | — | — | — | yes | — | — | yes |
| retune.applied | — | — | — | yes | — | — | yes |
| retune.refused | — | — | — | yes | — | — | yes |
| skew.pairs_over_limit | — | — | — | — | — | yes | yes |
| skew.rounds | — | — | — | — | — | yes | yes |
| skew.pairs | — | — | — | — | — | yes | yes |
| oracles agree: pairfix.json | — | — | — | — | — | — | yes |
| oracles agree: edited segments | — | — | — | — | — | — | yes |

195 of 195 rows agree.

#### cm5_minima, every pair class at diff_pair_gap 0.20 (both sides)

Start: figures.open yes, figures.drc yes, figures.a7 yes, figures.a8 yes, figures.pairs_todo yes, figures.pairs yes, A8 at start: oracle 1, TypeScript 1 yes

| ops | A8 start | A8 oracle | A8 TS | DRC oracle / TS | worst ΔL oracle / TS mm | oracle s (incl. score) | TS s |
|---|---|---|---|---|---|---|---|
| `vias` | 1 | 1 | 1 | {"courtyards_overlap": 1, "copper_edge_clearance": 2} | 4.75 / 4.75 | 6.2 | 4.5 |
| `mirror` | 1 | 1 | 1 | {"courtyards_overlap": 1, "copper_edge_clearance": 2} | 4.75 / 4.75 | 8.4 | 6.8 |
| `mirror-force` | 1 | 1 | 1 | {"courtyards_overlap": 1, "copper_edge_clearance": 2} | 4.75 / 4.75 | 10.6 | 8.8 |
| `retune` | 1 | 1 | 1 | {"courtyards_overlap": 1, "copper_edge_clearance": 2} | 4.75 / 4.75 | 6.1 | 4.5 |
| `width,tighten` | 1 | 0 | 0 | {"courtyards_overlap": 1, "copper_edge_clearance": 2} | 4.75 / 4.75 | 6.2 | 4.5 |
| `skew` | 1 | 1 | 1 | {"courtyards_overlap": 1, "copper_edge_clearance": 2} | 4.75 / 4.75 | 6.1 | 4.5 |
| `vias,mirror,retune,width,tighten,skew` | 1 | 0 | 0 | {"courtyards_overlap": 1, "copper_edge_clearance": 2} | 4.75 / 4.75 | 9.4 | 7.0 |

| item | `vias` | `mirror` | `mirror-force` | `retune` | `width,tighten` | `skew` | `six-op chain` |
|---|---|---|---|---|---|---|---|
| vias.transitions | yes | — | — | — | — | — | yes |
| vias.rounds | yes | — | — | — | — | — | yes |
| vias.applied | yes | — | — | — | — | — | yes |
| vias.refused | yes | — | — | — | — | — | yes |
| width/tighten rounds (groups, widths, jogs, new DRC by type) | yes | yes | yes | yes | yes | yes | yes |
| final_new_drc | yes | yes | yes | yes | yes | yes | yes |
| groups_planned | yes | yes | yes | yes | yes | yes | yes |
| groups_applied | yes | yes | yes | yes | yes | yes | yes |
| group_modes | yes | yes | yes | yes | yes | yes | yes |
| groups_reverted | yes | yes | yes | yes | yes | yes | yes |
| groups_invalid_geometry | yes | yes | yes | yes | yes | yes | yes |
| width_planned | yes | yes | yes | yes | yes | yes | yes |
| width_applied | yes | yes | yes | yes | yes | yes | yes |
| collateral_items | yes | yes | yes | yes | yes | yes | yes |
| per-pair coupled share and length difference, before and after | yes | yes | yes | yes | yes | yes | yes |
| edited board figures.open | yes | yes | yes | yes | yes | yes | yes |
| edited board figures.drc | yes | yes | yes | yes | yes | yes | yes |
| edited board figures.a7 | yes | yes | yes | yes | yes | yes | yes |
| edited board figures.a8 | yes | yes | yes | yes | yes | yes | yes |
| edited board figures.pairs_todo | yes | yes | yes | yes | yes | yes | yes |
| edited board figures.pairs | yes | yes | yes | yes | yes | yes | yes |
| edited boards' segments (net, layer, ends to 1 um, width) | yes | yes | yes | yes | yes | yes | yes |
| segments written start/end swapped (count) | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| edited boards' vias (net, at to 1 um, size, layers) | yes | yes | yes | yes | yes | yes | yes |
| mirror.chain_pairs | — | yes | yes | — | — | — | yes |
| mirror.rounds | — | yes | yes | — | — | — | yes |
| mirror.skipped | — | yes | yes | — | — | — | yes |
| mirror.applied | — | yes | yes | — | — | — | yes |
| mirror.refused | — | yes | yes | — | — | — | yes |
| mirror.vias_moved | — | — | yes | — | — | — | — |
| mirror.displaced | — | — | yes | — | — | — | — |
| retune.chains | — | — | — | yes | — | — | yes |
| retune.rounds | — | — | — | yes | — | — | yes |
| retune.applied | — | — | — | yes | — | — | yes |
| retune.refused | — | — | — | yes | — | — | yes |
| skew.pairs_over_limit | — | — | — | — | — | yes | yes |
| skew.rounds | — | — | — | — | — | yes | yes |
| skew.pairs | — | — | — | — | — | yes | yes |

193 of 193 rows agree.

## Every difference and its cause

1. **R1N `retune` alone, `retune.rounds`: round 1 new DRC items oracle 10, TypeScript 7** (round 2, the applied and refused chains,
   the edited board's copper and every figure agree). Cause: the retune walk direction (below). Three chains were written from the
   other end, so the new segments of the refused USB2P.D_P and USB3-1-D_N chains come in a different order and kicad-cli reports a
   different number of items for the same clearance conflicts (6 vs 3 items for USB2P.D_P). Proof: with the oracle at
   `PYTHONHASHSEED=37`, whose walk directions equal ours on all 9 chains of this board, the row agrees and the edited board is
   byte-identical (`p3`). The oracle disagrees with itself the same way: in `p2` the heldout and `~/pcb` runs of the chain differ only
   in `retune.rounds` round 1 (7 vs 6 items) — the row "oracles agree: pairfix.json".
2. **R1N chain, "oracles agree: pairfix.json"**: as in 1, oracle against oracle (two Python processes, two hash seeds); the edited
   boards' segments of the two oracles agree.
3. **"segments written start/end swapped" (R1N: 37 with retune alone, 22 in the chain; 0 at seed 37)**: same cause; same copper, so
   the segment row (ends in either order) agrees.

### Retune walk direction (the only nondeterminism, the oracle's)

`tune_chains` walks a wiggle from `ends[0]`, the first of a list built from a Python **set** of `(x, y, layer)` tuples; with string
hashing randomised per process, which end comes first changes from run to run (seeds 0–40 on R1N gave 2–9 of 9 chains in our
direction). `retune_path` is symmetric in its two ends (the bumps sit centred in the run), so the copper is the same either way; the
vertex order, the uuids (`pairfix-retune:{first segment}:{i}`), the chain key and, when the chain's segments differ in width, the width
of the new segments (the first segment's) follow the start end. The port starts at the end met first in segment order, which is
deterministic.

## Oracle quirks ported as they are (my decisions: faithful port, flagged here)

1. **`vias`: N never moves.** `via_options` keeps a move only when its signed distance `k > 1e-6`, and N's is `-mn`, so: `both` moves P
   half the gap, `N only` moves nothing, `P only` moves P the whole gap. On R1N 15 of 25 transitions end "applied, N only" with no
   change (their `both` failed the spot check or was refused by DRC in round 1). Likely meant `abs(k)`; changing it changes results, so not done here.
2. **`vias`: via layers in write order.** A via written `(layers "B.Cu" "F.Cu")` gets an empty layer slice, so its new spot is not
   checked against other copper (the DRC round still judges).
3. **`retune_pass`: when every chain is refused** the loop leaves the board file as the last round wrote it (the next pass overwrites
   it; the returned text is the source's).
4. **`shove_vias`: moved-via obstacles** take the size, net and layers of the via being placed, and vias already moved still count at
   their old spot.
5. **`mirror_options`: the leader's vias** count as obstacles whatever their span (pads only on the chain's layer).

## Differences of the port that are not in the rows

- **Failing pairs for `vias` and `mirror`.** The oracle reads `SRC/acceptance.json` (every bench step's source is a scored folder). The
  port reads the scorer's `.lastmile/acceptance.json` (or `acceptance.json`) in `cur`; the TypeScript bench does not score the
  intermediate steps of a chain (`pairs-fix` = `tighten+reroute+shorts+tighten`), so when neither file exists the port computes A8 from
  the base DRC with `checkAcceptance` (the same function the scorer runs). Only if that throws (a synthetic board) are all pairs taken.
- **Base DRC.** The oracle reuses `SRC/acceptance.drc.json`; the port runs one kicad-cli DRC on `cur` (as the width/tighten port
  already did): about 2.5 s more per step on R1N.
- **DRC reports of the passes** go to `OUT/.lastmile/pairfix/{vias,mirror,retune,skew}N.drc.json` (the oracle: `OUT/`), so a later
  step's folder copy skips them.
- **Jog uuids** (tighten.ts, width/tighten): uuid5 of `pairfix:{uuid}:{a}:{b}` now formats the points as Python's `str(tuple)`
  (`(15.3, 2.0)`); before, they were formatted `15.3,2`, so jog uuids differed from the oracle's (the copper did not).
- **Report extras:** `pass_s` (seconds per pass), `pairs`; the rounds rows gained `drc_s`, `width_changes`, `new_types`, `unattributed`,
  and `width_applied` was added, as in `pairfix.json`. `spacing_before/after` per pair are not reported.
- **Output lines** (`vias round 1: …`) go to an optional `log` callback in the pass context; `runTighten` does not print.

## Timing

DRC dominates both (2.3–2.6 s per kicad-cli run on R1N). R1N six-op chain: oracle `pairfix run` 20.6–23.0 s, TypeScript 21.6–25.0 s
(vias 4.7–5.4, mirror 2.5–2.6, retune 4.7–5.5, width/tighten 4.7–5.9, skew 2.4–2.9; plus the base DRC). Ops alone on R1N, harness wall
(oracle incl. `--score` / TypeScript): vias 13.9 / 10.3, mirror 14.5 / 10.6, mirror-force 16.2 / 12.5, retune 14.3 / 9.9, width+tighten
11.7 / 7.7, skew 11.4 / 7.4. cm5_minima chain: 14.0 / 11.2 s (stress variant 9.4 / 7.0).
