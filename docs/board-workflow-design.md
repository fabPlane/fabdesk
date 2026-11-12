# Board workflow: design, status and known gaps

This is the reviewer's document for `feat/board-workflow`. The agent-facing text is [board-workflow.md](board-workflow.md) (the same text
the agent doc carries; a test keeps them equal). Per-stage measurements are in
[evidence/board-workflow/](evidence/board-workflow/); this page says what exists, how it fits together, what was and was not verified,
and what is missing.

## What this is

The board method developed in the external `pcb` toolkit (Python; stages onboard → layout → last mile → edit → review → release, each
scored against the board's own acceptance checks A1–A9) is now part of Fabdesk, as TypeScript:

- `packages/board-workflow`: the workflow libraries. No CLI, no Python, no subprocess to a toolkit.
- `packages/tools/src/tools/board-*.ts`: seven tools, one per stage, in the `board` toolset.
- `packages/agents/src/board-workflow-md.ts`: the instructions the agent reads (stages, A1–A9, working rules, departable defaults).
- Plumbing every board tool shares: resource governor, durable jobs, adopt by IPC, content-addressed checkpoints, recorded A1–A9 state,
  a Finish it `review` milestone, toolsets chosen by project state, a Board checks section on the Status page.

Nothing in the shipped code reads `~/pcb`, runs a `pcb` binary, or needs `FABDESK_PCB_BIN`. The Python toolkit was the **oracle**: each stage
was ported against it and compared field for field (see Verification). The goal is a Fabdesk agent that does PCB work better than a
stock agent. That is a goal: it has not been measured (see Not measured).

## The seven tools

| Tool | `action` | Library |
| --- | --- | --- |
| `board_check` | (one call) onboard on first use, then A1–A9 on the saved board, history, change against the board as onboarded | `accept`, `onboard`, `history` |
| `board_route` | `check` `place` `rank` `route` `auto` `status` (layout); `new` `try` `loop` `why` `crossings` `fit` `pairs` `validate` `accept` `undo` `view` `info` `prune` (last mile) | `layout/`, `lastmile/` |
| `board_edit` | `mode` impact · apply · proof · full; `adopt` | `edit/` |
| `board_review` | `run` `gate` `dispose` `fix` `import_expert` `status` | `review/` |
| `board_silk` | `check` `place` `show` | `silk/` |
| `board_release` | `bom` `gerb` `check` `fab` | `release/` |
| `board_job` | `wait` `status` `cancel` `list` | `packages/tools/src/durable.ts` |

`board_edit`, `board_release`, `board_silk`, `board_route` and `board_review run` run through `runDurable` (`board_check` and the other `board_review` actions return directly): a call waits up to 25 minutes, then returns a job id while the job continues
(an MCP client drops a call at about 30 minutes). Every heavy tool is admitted by the resource governor by class (`light`, `router`,
`tracemaker`) and by board size (about 0.06 GiB per MB of board file; one TraceMaker at a time).

Each stage's result is data, not a tool error: a STOP, a FAIL or `NOT RELEASED (<gate>)` comes back as a normal result with its reason.

## How the stages connect

```
board_check ──► requirements (.fabdesk/board/requirements)  A1–A9 history (.fabdesk/board/accept)
     ▲                        │
     │ proof                  ▼
board_edit ◄── repair ── board_route (last mile bench, whole-board gate) ◄── board_route (place · rank · route)
     │                                                                               
     └─ candidate + origin.json ─► adoptCandidate ─► checkpoint · changed sheets · PCB delta as one KiCad commit · read-back
board_review ── gate (design hash) ──► board_release fab (refuses unless the gate is pass for this exact board)
board_review fix apply ──► board_edit (edit proposals become candidates; READY only if proof passes, finding gone, nothing new, 0 collateral)
```

- **One definition of done.** `board_check` records A1–A9 with the board's hash. Finish it reads that record: a board that came in failing is
  done on "no new failure" against its first result; a built board is strict. The mode is set at the first Finish it and never loosened by a resume.
- **One design hash** (board, schematics, project files, requirements). Any change makes the review stale; `board_release fab` reads the recorded gate.
- **One adopt path.** Candidates (edit, silkscreen, last-mile accept) are folders with an `origin.json` (project + file hashes). `adoptCandidate`
  refuses a stale origin, takes a checkpoint, writes changed schematic sheets, applies the PCB delta as one KiCad commit and reads it back.
- **Toolsets by state.** A project with a placed board starts with `core`, `render` and `board` (not the circuit-authoring tools, one `load_toolset`
  away); a successful `circuit_build` or `pcb_update_from_schematic` switches `board` on for the session.

State lives under `<project>/.fabdesk/board/`: `requirements/`, `accept/`, `done-mode.json`, `review/` (runs, `dispositions.json`, `intent.json`,
`latest.json`), `layout/`, `lastmile/<workspace>/`, `edits/`, `release/`, `adopt/`.

## Engines

The workflow is TypeScript; engines are programs it runs and nothing here installs them beyond what Fabdesk already does.

| Engine | Used by | Found through |
| --- | --- | --- |
| `kicad-cli` (DRC, exports, Gerber plots) | all | the resolved KiCad CLI; DRC at **project severity** with owner-excluded items dropped (`runLiveDrc`) |
| KiCadRoutingTools | `board_route` place, rank, route | `FABDESK_KRT_DIR` |
| TraceMaker | `board_route` route and last-mile steps | the router registry (`docs/routers.md`), else `TRACEMAKER_BIN` |
| fab_router, Freerouting | last-mile router steps | the PCB bridge (inside the app) |
| KiCad IPC | adopt | the bridge |

## Verification

Each stage was compared with the Python oracle on the same inputs. `parity-*.ts` harnesses are not part of `bun run test` (they need the Python
toolkit and kicad-cli); each prints its usage in the file header. Full tables, with every row that differs, are in the evidence files.

| Stage | Compared on | Result | Not compared, or differing |
| --- | --- | --- | --- |
| Onboard + A1–A9 ([stage1](evidence/board-workflow/stage1-parity.md)) | cm5_minima (live DRC, 19/19 rows), vme-wren (recorded DRC) | agree, except one deliberate difference | anchors written at micron precision, not 6 significant digits (the oracle's own A5 fails on an untouched vme-wren with `%g`); C6, vme-wren stressed variant not run; pre-10 boards refused |
| Edit ([edit](evidence/board-workflow/edit-parity.md)) | cm5_minima 9 plans, 176/176 rows (live DRC); vme-wren apply and impact only, 70/70 | agree | strict-mode verdicts, `make_room`, `fixed_allowed`, `dnp`, side flip, `symbol` add: unit-tested only; vme-wren candidates not scored; sheets in sub-folders not handled |
| Review ([review](evidence/board-workflow/review-parity.md)) | cm5_minima, 64/64 findings as onboarded and 103/103 stressed, same ids and severities | agree | 19 of 20 checks (`silk` is a separate stage); seed bench (11/11) and escape replay not run; cards and ratings produced no findings on cm5, so unit-tested only |
| Release and silk ([release](evidence/board-workflow/release-parity.md)) | jlcsim cm5, C6, R1N identical; BOM, viaproc identical; silk counts equal on four boards | 28 of 33 harness rows agree | silk: label positions equal for 104/112 on cm5 (greedy solver; small geometry differences), 7 vs 8 silk-over-copper hits, on the TF board 17 labels are hidden against the oracle's 16; gerbcheck uses its own reader (no gerbonara); Python `fab.py` itself never run (its review gate needs the toolkit registry) |
| Layout ([layout](evidence/board-workflow/layout-parity.md)) | cm5_minima `check` and derived inputs agree; `place` differs | **oracle bug**: on boards with `(at x y rot)` poses the oracle's `set_pose` rotates but never moves footprints, so every seed fails the courtyard gate. The port handles `(at …)` and passes 4/4. | `rank` and `route` ran on cm5 (rank best seed 18 opens; route 16 opens, A1/A2/A8 failing, 1028 s) with **no oracle figures** (the oracle refuses this board as "pre-10 format" and its TraceMaker step crashes); vme-wren, jetson, default 8-seed rank, repeat runs: not run |
| Last mile ([lastmile](evidence/board-workflow/lastmile-parity.md)) | cm5_minima, 22/22 rows (figures, 18 pair measurements, crossings, gate on 400 random pairs, tighten) | agree | `try finish` not compared (different routers); router wiring exercised with fakes and one real `tighten` run, not against a real bridge |
| Integration ([integration](evidence/board-workflow/integration.md)) | live DRC severity; Finish it flag on and off; review → edit bridge on cm5 | A2 now agrees with the oracle (courtyards 1 = 1) | real `board_edit` with a router, and READY from the review bridge: not reached on cm5 (no router outside the app) |

`bun run typecheck` passes. `bun run test` fails three tests, all in `packages/kicad/test/mechanical.test.ts`
("packaged kicad-cli mechanical truth"); they fail identically on a clean checkout of `origin/main`.

## What differs from the oracle on purpose

These are the port's own decisions, each recorded in the evidence file of its stage.

- Anchor coordinates at micron precision (above). Orderings the oracle took from Python set hash order are sorted.
- `place`: `(at …)` poses are handled (above). Scoring skips the schematic-parity DRC pass during routing (parity is not changed by routing); A3 is "not measured" there.
- Review: custom checks (shell commands from project data) run only with `trustCustom`; the interconnect gate is a hook, default none; the BOM check reads BOM decisions written by `board_release bom`; storage is `.fabdesk/board/review/`, not a registry.
- Release: strict A1–A9 (no no-regression mode); exceptions only as `CHECK=FILE#ID` with an owner decision; nothing is written into the package folder until the gates pass; drill maps are Gerber X2, not PDF; the pixel-shift search replaces the FFT in `gerbcheck`.
- Silk without pcbnew: shapes come from KiCad's own Gerber plots plus the board file, with a text-extent table measured against pcbnew (within 0.02 mm on all but one measured label).
- Last mile: `tighten` runs the `width` and `tighten` ops only.

## Known gaps

Not ported or not wired. None is hidden by a stub: an unported action fails by name.

- **Last mile**: rip-up and nudge helpers (`repair` steps `leg`, `blockers`, `window`, `a7`, `shorts`, `reroute`, `legs`, bundle with window; `nudge`, `turn`; `fit`) return "helper not available". Pair ops `vias`, `mirror`, `retune`, `skew` are missing, so the toolkit's "R1N A8 24 → 6" result is not reproducible. `why` and `validate` have no KRT or TraceMaker forensics.
- **Layout**: plans that ask for `planes` or `escape` raise "not ported"; pair pass-through templates are empty; `add_courtyards` is not ported (check reports the parts, cannot fix them).
- **Edit**: the churn-guard loop is not wired (`revertNets` exists); `apply_netclasses` for bare boards is not ported. Compute is synchronous, so a very large board blocks the core's event loop during `impact` or `apply`.
- **Python commands with no counterpart**: `intent` (nothing writes `.fabdesk/board/review/intent.json`; the agent or owner edits the file), `cable` (chassis reach), a standalone `diff` picture (the change picture exists inside review fix candidates), `clean` (only `board_route prune`), `upgrade` (a pre-10 board is refused with a hint), `boards` / `status` registry views (the Status page and `board_review status` replace them), and `run` (autopilot; `board_review fix apply` covers its settle-and-build part).
- **Interconnect contracts**: a hook (`setInterconnectGate`), default none for a standalone project.
- **Not in the UI**: adopting or undoing a candidate, diffs, visual constraint capture. The Status page shows A1–A9, review gate and onboarding.
- **Codex**: its client ignores a toolset added mid-session, so a board built in-session is picked up on the next run.

## Native tools the board tools overlap

Nothing was deleted: every overlapping native tool has callers (UI, mobile, Finish it) or a job the board tool does not cover. Each such tool's
description names the board tool that supersedes it for that job, and the start set for a placed board drops the duplicates
(`verify_drc` out; `verify_erc`, `verify_viagrid`, `pcb_inspect`, `render_*` stay). The table with the coverage gaps per tool is in
[integration.md §7](evidence/board-workflow/integration.md). Deleting any of them means migrating its callers first.

## Not measured

- Fabdesk against a stock agent (Claude, Codex) on the same boards, model and task. The held-out comparison has not been run on this code.
- Anything on vme-wren or jetson beyond onboarding, A1–A9 and edit apply/impact: no routing, review or release was run on boards of that size.
- `route` repeatability, and `rank` over the default eight seeds.

## For contributors

- The code is in `packages/board-workflow` (TypeScript, root workspace); tools are thin wrappers in `packages/tools/src/tools/board-*.ts`. Add a new
  workflow step to the library first, then expose it through the stage's existing tool as another `action`, not as a new tool.
- Parity harnesses: `packages/board-workflow/test/parity-{stage1,edit,review,release,layout,lastmile}.ts`, and `review-seeds.ts`. They need the
  Python oracle checked out and `kicad-cli`; run one heavy board job at a time (routing on large boards holds several GiB, and an earlier
  run of several jobs at once exhausted memory).
- `.gitignore` contains `release/`; `packages/board-workflow/src/release/` is excepted. Check `git status --ignored` after adding a directory named like an ignored one.
