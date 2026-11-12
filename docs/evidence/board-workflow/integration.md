# Integration notes

## 1. DRC severity

`kicad-cli pcb drc --severity-all` also reports violations the project marks ignored or excluded ("Intentional Overlap") as ordinary
errors. The Python oracle runs without that flag. Every board-workflow tool now runs `runLiveDrc` (`packages/tools/src/tools/common.ts`):
`severity: "project"` (no severity flag) and any `excluded` item dropped from the JSON, which is what `drcInputFromFile` does for
the edit stage. Used by `board_check`, the layout scoring and courtyard gate (`board_route`), `board_edit`, `board_release` and
`board_lastmile`.

Stage-1 parity, cm5_minima `proj2`, live DRC (harness `packages/board-workflow/test/parity-stage1.ts`, `--no-stress`):

| A2 errors | oracle DRC (no flag) | live, project severity + excluded dropped | live, `--severity-all` (old path) |
|---|---|---|---|
| courtyards_overlap | 1 | 1 | 2 |
| copper_edge_clearance | 2 | 2 | 2 |

19 of 19 rows agree (all of A1-A9 fields, onboard, and "live project-severity A2 equals oracle A2"). The layout stage's unexplained
"A2 courtyards_overlap 1 oracle vs 2 TS" is this same flag: `--severity-all` counted the owner-excluded overlap. (The earlier edit-stage
note of 4 vs 3 courtyard errors is the same effect on a different count basis; that count was not reproduced here.)

## 2. Finish it

`serve({ boardChecks })` overrides whether Finish it uses recorded A1-A9 and the review gate (default: `board_check` is registered).
`apps/core/test/finish-it-http.test.ts` runs with it off (the three tests that failed only because `board_check` is registered now
pass); `apps/core/test/finish-it-board-http.test.ts` (new, adapted from the old branch's `finish-it-toolkit-http.test.ts`) runs it
on: milestones `schematic, build, route, verify, review`, done mode written to `.fabdesk/board/done-mode.json` (`no-regression` for a placed
board never measured), the prompt names `board_check` and "5. review", completion needs recorded A1-A9 plus a current review gate (passing
gate completes without an agent, a no-new-failure board completes, a review recorded for an earlier board does not count).
`milestoneForTool` already maps `board_route` and `board_edit` to route, `board_review` to review, `board_check` and `board_release`
to verify. `board_silk` maps to no milestone (my decision: it is a label pass, not a milestone). With the board checks on, the verify line of the prompt no longer tells the agent
to run `verify_drc` (board_check includes DRC).

## 3. board_lastmile folded into board_route

One tool, `board_route`, `action` = `check|place|rank|route|auto|status` (layout) plus `new|try|loop|why|crossings|fit|pairs|validate|accept|undo|view|info|prune`
(last mile). `workspace` is the shared folder argument (default `.fabdesk/board/layout/ws` for layout, `.fabdesk/board/lastmile/main` for the
last mile; the old `ws` name argument is gone). `jobs` is optional (layout default 4, last mile by memory). `status` answers for the last-mile
bench when a workspace holding one is named, or when there is no layout flow and a bench exists. Inputs are grouped by stage in each
argument's description. The library modules are unchanged; the tool file `board-lastmile.ts` is deleted, its handler lives in
`packages/tools/src/tools/board-lastmile-actions.ts` (plain functions); its tests moved to `packages/tools/test/board-route-lastmile.test.ts`.
BOARD toolset lists: `board_lastmile` removed from the registry test and the tool index.

## 4. board_edit repairs what it cut

`EditRunners.repair` is wired to `lastmile.repairCandidate`: the candidate folder becomes the bench's start board, the `finish` action runs under
the whole-board gate (fewer opens, no new DRC class, A7/A8 not worse), the accepted board is written back over the candidate, then the A1-A9
proof runs. A finish that does not pass the gate leaves the board as edited and the note says why (the proof then reports the opens).
Tested with fake engines (library: improves 4 to 1 opens and writes back; gate rejection leaves the candidate) and through the tool with a fake
router (opens 2 to 0, proof passes, adopt proceeds; with a router that closes nothing: left as edited, adopt refused).
**Not run: a real cm5_minima `board_edit` full with routing.** The `finish` step needs a router: fab_router/Freerouting go through the KiCad IPC
bridge (not available outside the app) and TraceMaker is not to be run here. What was run on cm5_minima (real kicad-cli, no router): see section 5.

## 5. Review -> edit bridge

`createEditCandidateBuilder` (`packages/board-workflow/src/review-edit.ts`), used by `board_review fix apply`. For each edit proposal it runs `runEdit`
(full) down the toolkit's ladder (nearest legal spot with nothing displaced, then make room with neighbours within 2 mm, then 4 mm), treats a
source that already fails checks as "no new failure" (the toolkit's `--heldout`, which it set when the review's acceptance failed), reviews the candidate,
and reports READY only when the proof passes, the finding is gone, the candidate has no must-fix or question finding the source review lacked, and
0 collateral nets and 0 unplanned parts moved. It writes `review-bridge.json` beside the candidate. Two defects in the library were found by running it on
cm5_minima and fixed: the decoupling plan's id contained `:` (the edit plan rejects it) and `accept_before` was not in the review's `EditPlan` type.

cm5_minima (`proj2`, copy; real kicad-cli, no router): review 7.0 s, 39 findings, one DECAP finding with an edit proposal (`L3:DECAP:U602:-`, move one cap next to U602).
Builder (12.6 s): rung 1 (nearest legal spot) gives a candidate; finding gone; the proof fails A1 (2 opens left by the cut copper, which the route repair would close, no router here);
two new findings follow from those opens (`L1:OPEN`, `L1:A1`). Result: not READY, with those reasons. Unit tests (fake review + edit fixture): READY, finding still present,
new finding, proof failing, an unsolvable stop.

## 6. Agent doc

`packages/agents/src/board-workflow-md.ts` holds the section; `renderAgentsMd` includes it when `boardWorkflow` is set (the core sets it when
`board_check` is registered); `docs/board-workflow.md` is the same text (a test keeps them equal). The neutral-wording guard tests (no "workflow",
"prefer", "retry", "run ... first" in agent-facing text) still apply to everything outside that section; the section itself prescribes a method, so the tests
cut it out before applying the guard (my decision; otherwise the section could not exist). `docs/board-review.md` is deleted (nothing linked to it).

## 7. Native tools the board tools supersede (nothing deleted)

Each description now ends with one sentence naming the board tool. `BOARD_START_TOOLSETS` is `core, render, board` (the `verify` toolset left it; `verify_erc` and
`verify_viagrid` are named in `BOARD_START_TOOLS`) and `BOARD_START_SUPERSEDED` removes `verify_drc` from the start set. Still loadable with `load_toolset` /
`capability_search`. `verify_gate`, `release_build` are no longer in the start set (covered by `board_release`).

| native tool | covered by | coverage gaps | safe to delete? |
|---|---|---|---|
| `verify_drc` | `board_check` (A2 plus parity, zones refilled, A1-A9, history) | per-violation geometry and object ids (`responseMode=full`), warning baselines / gate, scoped DRC, explicit assembly members, the `reports/drc.json` that Finish it, the UI and mobile read; 12 files in apps/core, 2 in mobile, 13 in packages/tools, UI, client-core | No |
| `pcb_place` | `board_edit` (move to/near, displace, swap side/value; cuts and re-lands copper; proves A1-A9) | placing on a board without onboarding or a schematic sheet, silkscreen reference-field adjustment, locked-group and stale-copper reports; UI uses it; 3 files in apps/core, 7 in packages/tools | No |
| `schematic_edit` | `board_edit` for remove/swap/add/net ECOs only | everything else in schematic authoring: wires, labels, multi-unit placement, undoable batches, the schematic canvas; 8 files in apps/core, 5 in packages/tools | No |
| `pcb_update_from_schematic` | `board_edit` for an ECO that changes sheet and board together | KiCad's native Update PCB from Schematic for a fresh or externally edited schematic (parity-conflict dry run); 2 files in apps/core, 5 in packages/tools | No |
| `pcb_edit_copper` | `board_route` last mile re-routes what is open and tightens pairs under a gate | arbitrary tracks/vias by coordinates, delete by inspected id, named-net removal as one recoverable transaction | No |
| `route_run` | `board_route` for the staged flow (check, place, rank, route, last mile) | the single autoroute of the live board through the bridge (Freerouting / fab_router), its job events that the UI, mobile and `route_status` read (29 files in packages/tools, 18 in apps/core, 7 in mobile); the staged flow also needs KiCadRoutingTools and TraceMaker installed | No |
| `export_gerbers`, `export_drill` | `board_release gerb` / `fab` (CAM twice, independent render, drill counts) | ungated export of the current board for non-release uses, single-layer exports; UI export panel and mobile call them | No |
| `export_zip` | `board_release fab` (the gated package) | named archive of whatever files are present, no gates; UI and mobile | No |
| `export_pos` | `board_release bom` (JLC CPL with rotations from JLC's footprints) | the plain pad/centre positions CSV (UI, non-JLC fabs) | No |

The orchestrator should ask the owner before any deletion. In short: no row is a safe delete today.

## 8. Final audit

See the end of the integration report (commands and output are in the hand-off message). Summary: typecheck passes; `bun run test` fails only the three
`packages/kicad` `mechanical.test.ts` tests, which fail identically on a throwaway checkout of origin/main with the baseline vendor copied in and `bun install`.
