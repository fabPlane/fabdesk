# PCBGolf through fabdesk (2026-09-14)

[commaai/PCBGolf](https://github.com/commaai/PCBGolf) is a layout challenge: the panda-jungle-like
board (STM32H725 LQFP-144, USB2517 hub, four OBD-C ports with load switches, current monitors and
CAN transceivers, 12 V input with two bucks, microSD, 238 populated parts, 196 nets, 936 pins) is to
be re-laid-out as small as possible. Score = PCBA bounding-box volume (mm³) + 50 × vias + 5000 ×
copper layers; lowest wins. The repository ships the schematic, an unrouted board with every part
at the origin, and a project-local footprint library (`pcbgolf.pretty`).

This is the first real KiCad design (not an agent-written netlist) pushed through fabdesk's
netlist → build → place → route path. What it took, what broke, and what was fixed on `main`.

## The path

1. **Netlist.** `kicad-cli sch export netlist --format kicadsexpr` on the fork, then the new
   `scripts/import-kicad-netlist.ts` turns it into `circuit.netlist.json`: components with their
   footprints, `fields` (MPN) and `libSource`, nets with pin nodes, DNP parts dropped (four M2 bolt
   holes, two capacitors, one header), nets left with one node pruned. The project-local library is
   declared as `libraries: [{ kind: "footprint", nickname: "pcbgolf", uri: "${KIPRJMOD}/pcbgolf.pretty" }]`
   and the `.pretty` directory copied into the project. That part of the compile works as designed.
2. **Build.** 238 parts compile in 5–8 s. On a 60 × 45 mm outline KiCad's legacy autoplacer fits
   40 parts and leaves 198 stacked at the origin, and the build said "238 placed" (KiCad's own
   count). On 120 × 100 mm it spreads all 238 into the corner in 48 s and says "0 placed" with
   `autoplace_failed`. Neither count means anything; the build now reads the saved board and warns
   `footprints_stacked` with the refs.
3. **Placement.** A cluster-and-pack script (hubs — ICs and connectors — placed by hand on a
   70 × 55 mm board; every passive attached to the hub it shares the most signal nets with, decoupling
   caps to the chip with the most pins on their rails; ring-packed on a 0.5 mm grid without courtyard
   overlap) produced `docs/router-cases/pcbgolf.place.json`: 238/238 placed, DRC clean apart from
   two microSD pads 0.03 mm from the edge. Applied with `circuit_place` in two calls (its 200-entry
   cap at the time; now 1000). The four port channels stack down the right edge next to their
   vertical USB-C receptacles,
   the MCU sits in the middle, power on the left, host USB-C on the top edge, microSD and the button
   on the bottom.
4. **Rules.** The netlist's `board.rules` (0.15 mm clearance and track, 0.45/0.25 via) reached the
   board constraints but not the project file's `Default` net class, so kicad-cli DRC judged the
   board at KiCad's stock 0.2 mm and flagged the host USB-C's own pads (0.1989 mm apart). The build
   now writes the class into `board.kicad_pro` itself. Edge clearance (compile default 0.5 mm; the
   original project uses 0.025) and hole clearance (0.25; the vertical USB-C's own pegs sit 0.209
   from its shield pads) still cannot be set from the netlist — patched by hand in the project file
   for this run.
5. **Routing.** The JS router (`bun scripts/router-repro.ts docs/router-cases/pcbgolf.netlist.json`)
   gives up after 15 s and six attempts with `Static reachability precheck failed: 2 route(s) have
no legal path … Net-(LED1-B-)` and routes nothing — the R1 pad-inflation precheck, here on the
   RGB LED's 0.65 mm pads; the bridge survived. Freerouting through the bridge failed before it
   started: the `RunBoardJobExportSpecctra` job returned neither inline output nor a file
   (`ENOENT …/board.dsn`), although the same fork's `kicad-cli pcb export specctra` writes the DSN
   fine. Freerouting was therefore run by hand on that export and the session imported back
   through `ImportSpecctraSession` on the bridge session. Result below.

## What was fixed on `main`

| Symptom                                                                                                                                                                                                                                                                                                                                             | Where                                                 | Fix                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Build FAILED … SaveDocument: AS_BAD_REQUEST - request failed: basic_string` for the whole netlist, no hint why. Bisected to one net: `Net-(J2-CD{slash}DAT3)` — KiCad's own escape for a `/` in a label. Any `{…}` in a net name plus a rules write (the `SetNetClasses` call) breaks the fork's project save; without rules the same board saves. | fork (`SetNetClasses` + project save)                 | `circuit_build` refuses net names with `{` or `}` before compiling and names them;                          the import script rewrites the escapes to `_`. The fork bug is filed below. |
| `circuit_query select=components` showed every part at (0, 0) after a build (right again only after `circuit_place` reloaded the board). The fork keeps the footprint proto's `position` apart from the v10 `transform` and does not update it when the autoplacer moves parts.                                                                     | fork                                                  | The build compares the session's footprint positions with the saved file and reopens the board from disk when they disagree (a no-op once the fork is fixed).                            |
| "238 placed" with 198 parts stacked at the origin (and "0 placed" when all 238 were spread).                                                                                                                                                                                                                                                        | fork (`AutoplaceFootprints.placed_count`)             | New `readFootprintPlacements` / `stackedFootprints` in `@fabdesk/kicad`; the build warns `footprints_stacked` with the refs when parts share a spot.                                       |
| DRC ran at 0.2 mm although the netlist said 0.15: the project file had no `net_settings.classes`, and every later save (route, unroute, place) drops them again.                                                                                                                                                                                    | fork (project save drops the net classes the API set) | `persistDefaultNetClass` writes the `Default` class into `board.kicad_pro` after the build and after every save the design service makes.                                                  |
| `scripts/router-repro.ts` could not run a case with a project-local library.                                                                                                                                                                                                                                                                        | fabdesk                                               | Copies `${KIPRJMOD}/<name>` directories from next to the case file.                                                                                                                        |
| No way to get an existing KiCad design into a fabdesk project.                                                                                                                                                                                                                                                                                      | fabdesk                                               | `scripts/import-kicad-netlist.ts` (with tests).                                                                                                                                            |

Reproduce the fixes end to end: `FABDESK_TOKEN=… bun scripts/router-repro.ts docs/router-cases/pcbgolf.netlist.json --keep`
(build, the placement file, `route_run`, DRC). Change the netlist's board to 60 × 45 to see the
stacked-footprint warning; put `{slash}` back into the microSD net to see the refusal.

## Filed against the fork / fab_pcb (not fixable from fabdesk)

Porting note (2026-09-29): this work was first written against an older `main` and ported by
intent; `vendor/fab_pcb` on `main` is already past `0f368fe`, so the four fab_pcb PRs below are in
the pinned bridge. The fabdesk-side checks stay as defensive no-ops when the fork behaves: the
brace refusal names the nets before the bridge's own `validateNetlist` would, the stacked-footprint
warning reads the saved file, the board is reopened only when its positions are stale, and the net
class is rewritten only when the project file lacks it.

Workarounds opened on fab_pcb the same day: [#29](https://github.com/TensorFleet/fab_pcb/pull/29)
(G30 refused by `validateNetlist`, plus these entries in `docs/04-ipc-gaps.md`),
[#30](https://github.com/TensorFleet/fab_pcb/pull/30) (G32: placed count from pad positions,
`autoplace_incomplete` warning), [#31](https://github.com/TensorFleet/fab_pcb/pull/31) (G33: the
compile job writes the net class into the project file after its save) and
[#32](https://github.com/TensorFleet/fab_pcb/pull/32) (G34: DSN from `kicad-cli pcb export
specctra` when the job returns nothing — verified: `route_run` with Freerouting runs through the
bridge again). The fork itself still owns the root causes.

- **G30 — braces in net names break the project save after `SetNetClasses`.** Any net named with
  `{…}` (`Net-(J2-CD{slash}DAT3)`, `A{colon}B`, even `CD{x}DAT3`) + one `SetNetClasses` call in the
  session → the next `SaveDocument` answers `AS_BAD_REQUEST: request failed: basic_string`. No rules,
  or the same nets renamed, saves fine. Repro: any two-part netlist with such a net and
  `board.rules.clearanceMm`.
- **G31 — `FootprintInstance.position` is not the v10 transform.** Reads 0,0 for every footprint
  after `ImportNetlist` + `AutoplaceFootprints`; correct after the board is reopened from disk.
- **G32 — `AutoplaceFootprints.placed_count` is meaningless** (238 with 198 unmoved; 0 with all
  moved and `APR_*` ≠ completed). The compile's `footprintsPlaced` should come from positions.
- **G33 — the project save writes no `net_settings.classes`** after `SetNetClasses`, so file-based
  tools see stock rules.
- **G34 — `RunBoardJobExportSpecctra` (inline, async false) returns no output on the nightly
  `20260912-5e09a6e3be`;** the bridge's Freerouting adapter then fails with `ENOENT board.dsn`.
  `kicad-cli pcb export specctra` on the same file works. Until fixed, `router: "freerouting"`
  cannot run through the bridge at all.
- Compile `BoardRules` has no copper-to-edge or hole clearance; a compact board needs both.

## Numbers

| Stage                                          | Result                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Netlist                                        | 238 components (7 DNP dropped), 196 nets, 936 nodes; GND 233 pins, +3V3 64, +12V 40                                                                                                                                                                                                       |
| Build, 70 × 55 mm                              | 8.4 s; every part in the corner                                                                                                                                                                                                                                                           |
| Placement (script)                             | 238/238 inside the outline, 66 → 2 DRC errors once the rules were right                                                                                                                                                                                                                   |
| Score before routing                           | 70 × 55 × (1.6 + 11.0 mm DC jack) = 48 510 mm³ + 10 000 (2 layers) = **58 510**                                                                                                                                                                                                           |
| Freerouting 2.4.1, 10 passes, by hand (33 min) | 502 / 732 connections routed, 2 662 track segments, 298 vias, 230 open; pass 1 alone took 72 s and reached 351                                                                                                                                                                            |
| DRC after the import                           | 53 errors, none the router's: 31 clearance inside the host USB-C footprint and 4 inside the hub's QFN (0.199 mm pads judged at the stock 0.2 mm once the save had dropped the net class again), 16 hole clearance on the vertical USB-C pegs, 2 microSD pads at the edge; 230 unconnected |
| Score as routed                                | 48 510 + 50 × 298 + 10 000 = **73 410**, with 230 connections still to route                                                                                                                                                                                                              |

A single-sided 70 × 55 mm board with GND as tracks (233 pins) is what stops Freerouting short; a
bottom-side ground pour with a via per pad would close most of the 230 but cost ~11 000 points.

The volume term is set by the 11 mm DC jack and the four 8.9 mm vertical USB-C receptacles, so the
board's footprint is what the challenge is really about. A competitive entry would put the
passives on the back (the score charges volume, and 0.5 mm of 0402s under an 11 mm jack is nearly
free) — `circuit_place` cannot flip a part to `B.Cu` yet, and the placer above is single-sided.

## Files

- `docs/router-cases/pcbgolf.netlist.json`, `pcbgolf.place.json`, `pcbgolf.pretty/` — the case
  (`scripts/router-repro.ts` copies the library into the project).
- `scripts/import-kicad-netlist.ts` — KiCad netlist → `circuit.netlist.json`.
- The placer and the score calculator lived in the session scratchpad; the placement they produced
  is the `.place.json`. The score is outline area × (1.6 mm + tallest part on each side) + 50 ×
  vias + 5000 × copper layers, with part heights from the datasheets.
