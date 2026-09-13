# Autorouter issues — cases, reproduction, and what a router agent should fix

Collected 2026-09-13 while building the retro-PCB boards from the youtube plan across desktop and
phone. Every board that has a fine-pitch part (0.5 mm USB-C, QFN) comes out of `route_run` with
"42/42 connections routed" and then fails DRC with dozens of errors. The agent, told to "fix DRC
errors", has no tool that can, and ends up hand-editing `board.kicad_pcb` for 15 minutes.

The router is fab_pcb `packages/router/src/js-router.ts` (`@tscircuit/capacity-autorouter`
0.0.885 behind a `SimpleRouteJson` adapter) running on the FabPlane PCB bridge; fabdesk only
calls it (`apps/core/src/fp-pcb-design.ts` → `route_run`). Fixes land in `TensorFleet/fab_pcb`,
then bump `vendor/fab_pcb` here.

## Reproduce

Needs a bridge and a daemon with the KiCad fork (`docs/handoff-fab-pcb.md` §3). With the dev
desktop app running, the daemon is `http://127.0.0.1:47831` and the token is in
`~/Library/Application Support/fabPlane Dev/daemon.json`. Then:

```bash
FABDESK_TOKEN=$(jq -r .token ~/Library/Application\ Support/fabPlane\ Dev/daemon.json) \
  bun scripts/router-repro.ts docs/router-cases/usb-c-fanout.netlist.json --keep
```

The script creates a project from the case, runs `circuit_build` → `route_run` → `verify_drc`,
prints the DRC violations by rule with a few examples, and deletes the project unless `--keep`.
`--router freerouting` and `--settings '{"effort":"high"}'` pass through to `route_run`.
`render_board` on the kept project gives a picture (`renders/top.png`).

Runs are **not deterministic**: the same netlist gave 73, 59, 45 and 48 errors on four runs.
Judge a fix on the rule categories going to zero, not on a count.

## Cases (`docs/router-cases/*.netlist.json`)

| Case | What it is | Result today (errors by rule) |
| --- | --- | --- |
| `usb-c-fanout` | one 16-pin USB-C (GCT USB4105, 0.5 mm pitch), 6 × 0603, 1×04 header; 9 nets, 25 × 20 mm | 9 clearance, 5 shorting_items, 4 hole_clearance, 3 copper_edge_clearance, 1 tracks_crossing |
| `qfn-fanout` | one QFN-28 0.5 mm pitch, 12 × 0603 fanned out from every second pin, common GND; 25 × 25 mm | 26 copper_edge_clearance, 8 clearance, 4 tracks_crossing |
| `ps1-serial-dongle` | the real board 1: USB-C + CP2102N (QFN-28) + SOT-23-5 LDO + 1×08 header + 10 passives; 16 nets, 40 × 20 mm | 23–42 clearance, 14 copper_edge_clearance, 4–7 hole_clearance, 1–5 shorting_items, 1–9 tracks_crossing, solder_mask_bridge |

| `gb-link-usb-bridge` | the real board 2: RP2040 (QFN-56) + W25Q16 + USB-C + 3 × 74LVC1T45 + LDO + crystal + 31 passives; 41 parts, 29 nets, 50 × 30 mm | first full `route_run` sat 6 min with no progress and was cancelled; the agent then routed in stages (24 runs, 11 failed with `Static reachability precheck failed: N route(s) have no legal …`); the end state has 360 errors: 174 clearance, 113 tracks_crossing, 40 shorting_items, 32 solder_mask_bridge, 17 unconnected |

| `famicom-expansion-adapter` (+ `.place.json`) | the real board 4: DA-15, two 2×04 IDC headers, SOIC-16 mux, 3 mm LEDs, 0805 passives; 14 parts, 15 nets, 60 × 40 mm, **with a sane hand placement** (connectors on the edges, mux in the middle) | run to run: `HB ran out of iterations` (nothing routed), or 23/38 routed with 38 clearance, 18 shorting_items, 3 tracks_crossing. The same netlist with the autoplacer's corner-packed placement routed 39/39 with only placement errors — spreading the parts out made the router worse. |

Baseline that passes: the 3-part blinky in `docs/handoff-fab-pcb.md` §3 (0 errors). Anything with
two pads closer than `clearance + trackWidth` fails.

`scripts/router-repro.ts` applies `<case>.place.json` (a `circuit_place` placements array) after the
build when one exists, so a case can pin its placement.

## Failure classes

### R1 — traces inside the clearance of neighbouring pads, and outright shorts

`Clearance violation (clearance 0.2000 mm; actual 0.0600 mm) — Track [USB_DP] on F.Cu | Pad A7
[USB_DN] of J1`, `Items shorting two nets (nets USB_DN and USB_DP) — Pad A7 [USB_DN] | Track
[USB_DP]`. Every fine-pitch connector or QFN produces these at the pads a trace exits between.

Where it comes from (`js-router.ts`): pads become rectangles inflated by
`clearance + trackWidth/2 + 50 µm`. With 0.5 mm pitch and 0.3 mm pads the inflated boxes of
neighbouring pads overlap and the solver's reachability precheck declares the net "sealed in" and
fails the **whole run**. The retry loop (`inflations = [undefined, clearance, 0]`) then re-runs
with inflation = clearance and finally **0 nm**, at which point the solver happily lands a
centreline on the edge of the neighbouring pad. The run still reports "all connections routed".

What to do: never lower inflation below `clearance + trackWidth/2`. Fine-pitch escape needs a
different mechanism — carve the exit corridor for the *target* pad only (drop that one pad's own
box while its net is solved, keep the neighbours), or route those nets on a finer grid, or hand the
connector's nets to Freerouting. Whatever the mechanism, `route_run` must report a net it could not
route within the rules as **open**, not as routed.

### R2 — trace-to-trace clearance and crossings on the same layer

`Tracks crossing — Track [N12] on F.Cu | Track [N3] on F.Cu`, `Clearance violation ( … actual
0.1587 mm) — Track [N12] | Track [N3]`. Seen in `qfn-fanout` between fanout traces of different
nets, i.e. the solver's own output conflicts with itself. Likely the same root as R1 (inflation
retry at 0 also applies to trace obstacles), possibly plus `tracesToItems` stitching segments
without checking the result. A post-solve self-check (segment/segment distance per layer against
the rules) would at least flag these as conflicts.

### R3 — copper too close to the board edge

`Board edge clearance violation (board setup constraints edge clearance 0.5000 mm; actual 0.0000
mm)`. Two sources: (a) tracks: `minBoardEdgeClearance` is passed, but traces still touch the
outline — check whether the solver honours it or whether the outline is passed as a polygon it
ignores; (b) pads: the autoplacer (`packages/compile/src/apply.ts`, KiCad legacy grid placer,
rotation 0) packs footprints into the top-left corner and puts tall parts (a 1×08 header on a
20 mm board) across the outline, sometimes at negative coordinates. fabdesk now has
`circuit_place` (moves footprints by rewriting their transform in the saved file and reloading the
board — the API's `UpdateItems` moves only the anchor, gap G28), so the agent can fix placement;
the router still should not route into an edge violation.

### R6 — large boards: minutes with no progress, then a solver failure

`gb-link-usb-bridge` (41 parts, GND on 46 pads, 3V3 on 31 pads): the first `route_run` produced
no progress for 6 minutes (the solver never left its first phase) and had to be cancelled; the
retry loop (8 rounds of a full solve each) makes a failing board cost 8× a passing one. Partial
runs (`onlyConnections`) fail with `Static reachability precheck failed: 6 route(s) have no legal
…` as soon as earlier tracks box a pad in. Whatever replaces R1 must also keep a bound on total
solver time and report progress (the daemon now forwards phase/percent to the cinema, so a stuck
phase is at least visible).

### R7 — coarse boards that fail outright

`ps1-pio-breakout` (three 2.54 mm headers, 68 nets, nothing finer than 1.6 mm holes) and the placed
`famicom-expansion-adapter` end with `solver failed (attempt 3): HB ran out of iterations` — the
solver gives up after the retry loop with nothing routed. Boards of this class are what a hobbyist
autorouter is supposed to eat; the capacity mesh appears to fragment on long parallel bundles and
on large empty areas. Reproduce with the two cases above.

### R4 — hole clearance on the connector's own pegs

`Hole clearance violation (0.2500 mm; actual 0.1944 mm) — Pad A1 [GND] of J1 | NPTH pad of J1`.
Intrinsic to the KiCad USB-C footprints against the default 0.25 mm hole clearance; not the
router. Either the compile job sets the project's hole clearance to the footprint's reality or
these go on the project's `allowedDrcWarnings` list. Listed so the router agent does not chase it.

### R5 — solder_mask_bridge

Consequence of R1: a trace that touches a neighbouring pad merges the mask apertures. Goes away
with R1.

## What "fixed" looks like

- `bun scripts/router-repro.ts` on the three cases: `clearance`, `shorting_items`,
  `tracks_crossing`, `solder_mask_bridge` = 0. `copper_edge_clearance` = 0 for tracks (pad
  violations are placement, tracked separately). `hole_clearance` handled per R4.
- A net that cannot be routed within the rules is reported open by `route_run` / `route_status`,
  and the DRC-clean state is the default — no `settings.extra.obstacleInflate` needed.
- The retro boards (RP2040 + USB-C + flash + level shifters, 30–50 parts) route clean on 2 layers
  within the 5-minute `route_run` timeout.

## Alternatives worth measuring first

- **Freerouting** (`packages/router/src/freerouting.ts`, DSN/SES): honours KiCad rules by
  construction. Internal-only today (`channel === "internal"`, needs the jar + JDK). Run the three
  cases with `--router freerouting` on an internal build and record the result here; if it is clean,
  the product decision is whether to ship the jar.
- A DRC-driven repair loop in fabdesk: after `route_run`, run DRC, `route_unroute` the nets named in
  clearance/shorting/crossing violations, re-route them with a larger inflation. Cheap to build,
  but it only helps if the router can actually route those nets within the rules (R1).
