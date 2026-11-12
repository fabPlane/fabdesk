# Board workflow, last mile: KRT steps end to end against the toolkit's bench

Date 2026-11-12. Harness: `packages/board-workflow/test/e2e-lastmile-krt.ts` (not part of `bun run test`; needs KiCadRoutingTools,
the Python toolkit and kicad-cli). Oracle: `~/pcb-worktrees/heldout` `bin/pcb lastmile new` / `try --no-accept --jobs 1`. Port: the
library's step engine (`lastmile/engine.ts`) inside `Bench`, with the real KRT build `~/fabdesk-evals/builds/krt-c6-20261110`, the
same build the toolkit uses. kicad-cli `/usr/bin/kicad-cli-nightly` 10.99.

Board: cm5_minima (`~/pcb-cmp/cm5_minima/proj2`, spec `~/pcb-cmp/cm5_minima/onboard/spec.json`) with the copper of three signal
nets deleted on both sides (`/CM5/nLED_ACTIVITY`, `/PCIe-M2/FB`, `Net-(J1-K_GREEN)`; 17 items), so the start board has 5 open
connections. The port's copy has its board renamed `CM5.kicad_pcb` (with its `.kicad_pro` / `.kicad_prl`), so every step also
exercises a board not called `board.kicad_pcb`.

## Run 1: the port onboards the board itself

`finish`, `rip`, `blockers:1.0`: figures agree on all three (open 5 -> 0, DRC unchanged, A7 0, A8 1; each passes the gate).
Routed copper: identical for `finish` (2547 items) and `rip` (2546); `blockers:1.0`'s ripped board is identical (2464 items, and
`rip.json` equal), its routed board differs (61 / 51 items). Cause: the requirements, not the engine. Fabdesk's onboarding declares
In1.Cu and In4.Cu as plane layers on cm5_minima, the oracle's held-out onboarding declares none, so `@layers` expands to four
signal layers on the port's side and six on the oracle's. Time: oracle 104 s, port 87 s.

## Run 2: both sides read the oracle's requirement files (`--same-req`)

| action | figures (open, DRC, A7, A8) | gate | routed copper |
| --- | --- | --- | --- |
| `finish` | agree: 0, {courtyards_overlap 1, copper_edge_clearance 2}, 0, 1 | passes on both | identical (2547 items) |
| `rip` | agree | passes on both | identical (2546) |
| `blockers:1.0` | agree | passes on both | identical (2640) |
| `taps` | agree: 5 open (no tap nets selected) | "no gain" on both | identical (2511) |
| `pairs-all` | DRC clearance 26 (oracle) vs 27 (port); the rest equal (open 105, A8 35) | rejected on both (new DRC class, A8 worse, pairs worse) | KRT stages 1-3 (both pair classes, legs) identical on both sides; stage 4 (`finish`) differs by 12 items |

The expanded KRT plans are identical for every action. The KRT input boards are equal item for item except 18 footprint property
strings where the oracle's converter writes a tab as `\t` and the port keeps the tab character (part descriptions; not read by the
router). `pairs-all`'s stage 4 got identical copper and identical net classes on both sides; running the oracle's own stage-4
command again on the oracle's own stage-3 board gives a third result (escalations 1, failed 3, against the oracle's 3 / 4 and the
port's 1 / 4). KRT's finish stage is not deterministic on this board, so that row measures KRT, not the port.

Time: oracle 612 s, port 563 s (one candidate at a time on each side).

## Not covered

- `a7`, `shorts`, `legs`, `reroute`, `mirror`, `bundle`, `pairs`, `pairs-m`, `nudge` / `turn` through KRT on a real board: their
  rip and nudge halves are compared separately ([rip](lastmile-rip-parity.md), [nudge](lastmile-nudge-parity.md)), and their
  route half is the same `routeKrt` call with another plan.
- A board of C6 / R1N size through KRT (cm5_minima has 112 footprints).
