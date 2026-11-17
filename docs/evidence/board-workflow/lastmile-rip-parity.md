# Board workflow, last mile: connection-level rip-up, parity with the Python toolkit

Date 2026-11-12. Oracle: `~/pcb-worktrees/heldout` (toolkit `cmp/held-out-fixes`, e0ca89a; `tools/rip_items.py` is identical to
`~/pcb` main), with what it uses from `block_pass.top_level`, `check_acceptance.board_model` / `undersize` and
`route_region.prune_dangling`. Port: `packages/board-workflow/src/lastmile/rip.ts` (`ripStep`, plus pure `parseRipArgs`,
`ripItems`, `selectRip`, `ripBoard`, `pruneDanglingExact`, `ripJson`). Harness: `packages/board-workflow/test/parity-rip.ts`
(not part of `bun run test`; needs the toolkit and kicad-cli). Unit tests: `packages/board-workflow/test/rip.test.ts`
(15 tests, synthetic board). kicad-cli `/usr/bin/kicad-cli-nightly` 10.99.0. No router was run.

## Method

For each board the harness builds one scored folder, `start`: one kicad-cli DRC run with refilled zones (project severities)
written as the oracle's `acceptance.drc.json`, and the oracle's `check_acceptance.py --drc` result as `acceptance.json`. The
port reads the same data under its own names (`.lastmile/drc-run.json` is the parsed report, `.lastmile/acceptance.json` a copy
of the oracle's file), so a difference can only come from the rip itself. A row also checks that the port's own
`checkAcceptance` names the same failing A8 nets.

The boards in hand have few DRC shorts, so the harness also builds `cur`: `start` plus 8 new tracks. Each one starts on its own
net's copper and ends on the nearest track of another net on the same layer. Even-numbered tracks carry a net that is open on
`start` when the board has opens, for `--spare-open-nets START`. Odd-numbered tracks end on pair copper, for `--spare-pairs`.
A copy of a track that touches only its source copper does not work: KiCad gives it the source net on load and reports
nothing, so each new track has to bridge two nets. `cur` is scored the same way.

Every mode runs `rip_items.py SRC OUT ARGS` and `ripStep({cur: SRC, out, pcb, args, req})` from the same folder. Compared:
`removed`, `pruned`, `nets`, `open_before`, `by_reason` (keys, counts and key order), `windows`, the bytes of `rip.json` (the
`src` line aside, since it names each side's own folder), the set of removed items (by uuid, rip and prune together) and the
bytes of the ripped board.

Requirements: the port reads `req.acceptance`. The ground net (never cut by a window; boardctx `GND`) and the copper stack
(boardctx `COPPER`, for via anchoring in `--a8-uncoupled` and the A7 tap test) come from `profile(req.acceptance)`. The pair
nets, coupling thresholds, pair width and gap, and the A7 classes come from `net_classes`. The board file name comes from
`pcb` (boardctx `STEM`). C6's acceptance file uses the old schema (`C6_ACCEPTANCE_V1`): its stack facts are not written in the
file, and the toolkit's boardctx fills them in (`IO_GND`, 8 copper layers, In1/In6 planes, C6 via spans). The harness writes
those values into the port's copy of the acceptance, the way a fabdesk-onboarded board states them. Nothing C6-specific is in
`rip.ts`.

## Results: 40 of 40 rows agree (2 boards x 20 rows)

Each row lists oracle / port counts. In every mode row the ripped board is byte-identical, `rip.json` is byte-identical, and
the sets of removed items are equal.

### C6 (`~/vaio_p_modding/io-c6/work/c6-rerun91/final`, 318 footprints, 4109 segments, 788 vias; spec C6-eco95)

`start`: 3 opens, 4 A8 nets failing, 1 A7 net. `cur`: plus 2 `tracks_crossing` and 5 `shorting_items`. The port's
`checkAcceptance` gives the same A8 nets on both folders.

| mode (args) | removed | pruned | nets | items gone | open_before | by_reason | time oracle / port |
|---|---|---|---|---|---|---|---|
| `--around-opens 1.0 --spare-pairs` (blockers) | 80/80 | 105/105 | 22 | 185 | 3 | window 80 | 5.8 s / 1.1 s |
| `--around-opens 2.0` | 300/300 | 207/207 | 48 | 507 | 3 | window 300 | 6.6 s / 0.9 s |
| `--a7` | 15/15 | 13/13 | 1 | 28 | 3 | a7 15 | 3.5 s / 0.6 s |
| `--a8` (all) | 74/74 | 0/0 | 4 | 74 | 7 | a8 74 | 1.4 s / 0.3 s |
| `--a8 short --around-ripped 1.0 --spare-pairs` (legs) | 79/79 | 48/48 | 11 | 127 | 5 | a8 38, window 41 | 4.4 s / 0.7 s |
| `--a8 long --around-ripped 0.5` | 57/57 | 53/53 | 10 | 110 | 5 | a8 36, window 25 | 6.9 s / 0.9 s |
| `--a8-uncoupled ""` (reroute) | 63/63 | 0/0 | 4 | 63 | 7 | a8-uncoupled 63 | 1.6 s / 0.2 s |
| `--a8-uncoupled "" --rip-pad-stubs` (reroute!) | 72/72 | 0/0 | 4 | 72 | 7 | a8-uncoupled 72 | 1.6 s / 0.3 s |
| `--a8-uncoupled '^Net-\(C18_U101-USB_DP\)$'` | 32/32 | 0/0 | 2 | 32 | 5 | a8-uncoupled 32 | 1.4 s / 0.2 s |
| `--window 29.96 26.16 44.94 39.24 --spare-pairs` | 245/245 | 131/131 | 34 | 376 | 3 | window 245 | 5.8 s / 0.8 s |
| `--window ... --nets '*,!*GND*,!*5V*' --no-prune` | 270/270 | 0/0 | 37 | 270 | 3 | window 270 | 0.7 s / 0.1 s |
| `--drc track_width,via_dangling,track_dangling,silk_edge_clearance` | 19/19 | 63/63 | 13 | 82 | 3 | track_width 3, via_dangling 7, track_dangling 9 | 5.6 s / 0.9 s |
| `--drc SHORTS --spare-pairs` on start (no shorts) | 0/0 | 0/0 | 0 | 0 | 3 | {} | 1.2 s / 0.2 s |
| cur: `--drc SHORTS` | 28/28 | 44/44 | 12 | 72 | 3 | tracks_crossing 9, shorting_items 19 | 6.6 s / 1.1 s |
| cur: `--drc SHORTS --spare-pairs` (shorts) | 24/24 | 36/36 | 9 | 60 | 3 | tracks_crossing 9, shorting_items 15 | 6.6 s / 1.0 s |
| cur: `--drc SHORTS --spare-open-nets START` (leg repair) | 20/20 | 43/43 | 9 | 63 | 3 | tracks_crossing 4, shorting_items 16 | 6.9 s / 1.0 s |
| cur: `--drc SHORTS --around-opens 1.0 --a7` (union) | 115/115 | 155/155 | 31 | 270 | 3 | tracks_crossing 9, shorting_items 19, a7 15, window 80 | 6.9 s / 1.1 s |

The other three rows (context: ground `IO_GND`, 8 layers; A8 nets on `start` and on `cur`) agree.

### cm5_minima (`~/pcb-cmp/cm5_minima/proj2`, 112 footprints, 1884 segments, 444 vias; spec `onboard/spec.json`)

`start`: 0 opens, 1 A8 net failing, 0 A7. `cur`: plus 6 `tracks_crossing`, 1 `clearance` and 1 `shorting_items`. With no opens,
`--around-opens`, `--a7` and `--spare-open-nets` take nothing here. C6 covers those modes.

| mode (args) | removed | pruned | nets | items gone | open_before | by_reason |
|---|---|---|---|---|---|---|
| `--around-opens 1.0 --spare-pairs` | 0/0 | 0/0 | 0 | 0 | 0 | {} |
| `--around-opens 2.0` | 0/0 | 0/0 | 0 | 0 | 0 | {} |
| `--a7` | 0/0 | 0/0 | 0 | 0 | 0 | {} |
| `--a8` | 44/44 | 0/0 | 1 | 44 | 1 | a8 44 |
| `--a8 short --around-ripped 1.0 --spare-pairs` | 0/0 | 0/0 | 0 | 0 | 0 | {} |
| `--a8 long --around-ripped 0.5` | 45/45 | 7/7 | 2 | 52 | 1 | a8 44, window 7 |
| `--a8-uncoupled ""` | 20/20 | 0/0 | 2 | 20 | 2 | a8-uncoupled 20 |
| `--a8-uncoupled "" --rip-pad-stubs` | 68/68 | 0/0 | 2 | 68 | 2 | a8-uncoupled 68 |
| `--a8-uncoupled '^/USB_C\.D_P$'` | 20/20 | 0/0 | 2 | 20 | 2 | a8-uncoupled 20 |
| `--window 99.71 45.95 111.61 58.49 --spare-pairs` | 36/36 | 23/23 | 9 | 59 | 0 | window 36 |
| `--window ... --nets '*,!*GND*,!*5V*' --no-prune` | 94/94 | 0/0 | 19 | 94 | 0 | window 94 |
| `--drc copper_edge_clearance,silk_edge_clearance` | 0/0 | 0/0 | 0 | 0 | 0 | {} |
| `--drc SHORTS --spare-pairs` on start | 0/0 | 0/0 | 0 | 0 | 0 | {} |
| cur: `--drc SHORTS` | 35/35 | 50/50 | 16 | 85 | 0 | tracks_crossing 26, clearance 4, shorting_items 5 |
| cur: `--drc SHORTS --spare-pairs` | 29/29 | 22/22 | 12 | 51 | 0 | tracks_crossing 22, clearance 2, shorting_items 5 |
| cur: `--drc SHORTS --spare-open-nets START` | 35/35 | 50/50 | 16 | 85 | 0 | as `--drc SHORTS` (no opens on start) |
| cur: `--drc SHORTS --around-opens 1.0 --a7` | 35/35 | 50/50 | 16 | 85 | 0 | as `--drc SHORTS` |

The other three rows (context: ground `GND`, 6 layers; A8 nets on `start` and on `cur`) agree.

## Differences found, with cause

- **`windows` order with `--a8 ... --around-ripped` (rip.json only; the ripped board is the same).** The oracle adds the boxes round
  the failing nets' pads while iterating a Python `set`, so the order depends on the string hash seed. The port uses sorted net
  order. In one C6 run, `--a8 long --around-ripped 0.5` gave the same boxes in another order, so `rip.json` bytes differed. In
  the final run the two orders happened to match. The harness compares boxes as a multiset and names this case when it occurs.
  The KRT plan runner does not read `windows`.
- **Prune end keys (no difference seen on these boards).** The toolkit keys track ends by Python's `round(x, 3)`. The
  existing `edit/prune.ts` uses `Math.round(x * 1000) / 1000`, which rounds exact halves differently (0.0625 gives 0.063 there and
  0.062 in Python; 63.9875 gives 63.988 and 63.987). Both boards gave identical prunes either way: 1905 and 956 items, after
  cutting every fifth item. `rip.ts` keeps its own `pruneDanglingExact`, which uses an exact `round(x, 3)` and one-pass span
  removal and is otherwise the same as prune.ts.

## Not ported, or ported differently (my own decisions)

- `--a8 ... --around-ripped` box order: sorted, not hash order (see above).
- The CLI's stdout summary line is not printed. `ripStep` returns the record instead.
- The `OUT exists` check: `ripStep` refuses an `out` that exists and is not empty. An empty folder the engine made beforehand
  is accepted.
- The `out/` copy uses `copyBoardFolder` (fabdesk's skip list: no `.lastmile`, score files, 3D models or plots), not the
  toolkit's `copytree` ignore list.
- `parseRipArgs` follows argparse for these options: choices, optional values, `--opt=value`, negative numbers in `--window`.
  It does not accept argparse's unique-prefix abbreviations (`--a8-u`).
- `--a7` uses a copy of `accept.ts`'s private `undersize` / `tapBranch`. Exporting `undersize` from `accept.ts` would let
  `rip.ts` drop the copy.
