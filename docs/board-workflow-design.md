# Board workflow: design, status and known gaps

This is the reviewer's document for `feat/board-workflow`. The agent-facing text is [board-workflow.md](board-workflow.md) (the same text
the agent doc carries; a test keeps them equal). Per-stage measurements are in
[evidence/board-workflow/](evidence/board-workflow/); this page says what exists, how it fits together, what was and was not verified,
and what is missing. How to review this work, step by step: [board-workflow-review.md](board-workflow-review.md).

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
| `board_route` | `check` `place` `rank` `route` `auto` `status` (layout); `new` `try` `loop` `sweep` `why` `crossings` `fit` `pairs` `validate` `accept` `undo` `view` `info` `prune` (last mile) | `layout/`, `lastmile/` |
| `board_edit` | `mode` impact · apply · proof · full; `adopt` | `edit/` |
| `board_review` | `run` `gate` `dispose` `fix` `import_expert` `status` | `review/` |
| `board_silk` | `check` `place` `show` | `silk/` |
| `board_release` | `bom` `gerb` `check` `fab` | `release/` |
| `board_job` | `wait` `status` `cancel` `list` | `packages/tools/src/durable.ts` |

`board_edit`, `board_release`, `board_silk`, `board_route` and `board_review run` run through `runDurable` (`board_check` and the other `board_review` actions return directly): a call waits up to 25 minutes, then returns a job id while the job continues
(an MCP client drops a call at about 30 minutes). Every heavy tool is admitted by the resource governor by class (`light`, `router`,
`tracemaker`) and by board size: a router run (KRT, TraceMaker) is estimated as the larger of a grid term, outline area × copper layers / grid² (`layout/footprint.ts`: 104 bytes per 0.05 mm cell plus 0.5 GiB; vme-wren's KRT `finish` peaked at 16.25 GiB over a full 33-min step budget), and a board-content term, 0.17 GiB per MB of board file (jetson: a rip / pair-routing KRT run reached 12.9 GiB where the grid term said 7.5); read by a one-pass scan of the layer table and outline, not a full parse, other jobs at about 0.06 GiB per MB of board file; one TraceMaker at a time. The same estimate limits the last-mile bench's parallel candidates and stretches its per-action budget, and a router or TraceMaker job estimated above the memory available now (or the machine's total) is refused with the reason instead of started. (The file-size rule alone said ~4 GiB on vme-wren; three parallel `try` candidates ran a 24 GiB eval out of memory.) Memory is read the same way by the
governor and the last-mile bench (`sysinfo.hostMemory` in `packages/board-workflow`): Linux `/proc/meminfo` MemAvailable, macOS `vm_stat`
(total minus app memory, wired and compressed pages; `os.freemem()` alone undercounts a busy Mac), Windows `os.freemem()`. A job only waits on
another admitted job: one that does not fit while nothing else runs starts at once with a "memory is short" note, so no class can wait forever.
Low disk is refused, not waited on.

Each stage's result is data, not a tool error: a STOP, a FAIL or `NOT RELEASED (<gate>)` comes back as a normal result with its reason.

## How the stages connect

```
board_check ──► requirements (.fabdesk/board/requirements)  A1–A9 history (.fabdesk/board/accept)
     ▲                        │
     │ proof                  ▼
board_edit ◄── repair ── board_route (last mile bench, whole-board gate) ◄── board_route (place · rank · route)
     │                                                                               
     └─ candidate + origin.json ─► adoptCandidate ─► checkpoint · changed sheets · PCB delta as one KiCad commit · read-back
board_review ── gate (design hash) ──► board_release fab (refuses unless the gate is pass for this exact design)
board_review fix apply ──► board_edit (edit proposals become candidates; READY only if proof passes, finding gone, nothing new, 0 collateral)
```

- **One definition of done.** `board_check` records A1–A9 with the board's hash. Finish it reads that record: a board that came in failing is
  done on "no new failure" against its first result; a built board is strict. The mode is set at the first Finish it and never loosened by a resume.
  Finish it applies the board plan (A1–A9 decide `verify`, a `review` milestone, the prompt naming `board_route` and `board_review`) only to a
  project with a placed board, while the board tools are registered and Settings `boardChecksInFinishIt` is not off (`boardChecksApply`); a fresh
  circuit design keeps the DRC/ERC plan (`route_run`, `verify_drc`) until its board exists. A run keeps the plan it started with.
- **One design hash** (board, schematics, project and rule files, requirements, `review.hash_extra`: `reviewHash` / `currentReviewHash`). Any
  change makes the review stale everywhere: the recorded gate (`review-gate.json`) carries that hash, so the Status page, Finish it and
  `board_release fab` all read a gate that is stale as soon as anything the review covered changes. A gate recorded without it reads as stale.
- **One adopt path.** Candidates (edit, silkscreen, last-mile accept) are folders with an `origin.json` (project + file hashes). `adoptCandidate`
  refuses a stale origin, takes a checkpoint, copies the board and every sheet it will write to `adopt/<stamp>/before/`, writes changed schematic
  sheets, applies the PCB delta as one KiCad commit and reads it back. All or nothing: if anything fails after the first write, the board and
  sheets are restored from `before/` (a sheet that did not exist is removed) and the error says the project was restored, or names each file that
  still differs and where its copy is.
- **Onboarding is confirmed, not assumed.** Onboarding's derived requirements stay "not yet confirmed" (Status page, `release_build`) until
  `board_check {"confirm": true}` records who checked them and when (`onboard-confirmed.json`, bound to `onboard.json`'s hash, so onboarding
  again needs a new confirmation).
- **Board jobs** (`board_job`, `durable.ts`) belong to the project they were started in: list, status, wait and cancel see only the caller's
  project (`list` with `allProjects` shows every one). Finished jobs are kept 1 h (the newest 50); `cancel` reports how the job ended, or
  `stopping`. Jobs live in the daemon's memory: an id from before a restart is reported as such, and the tool is run again.
- **Toolsets by state.** A project with a placed board starts with `core`, `render` and `board` (not the circuit-authoring tools, one `load_toolset`
  away); a successful `circuit_build` or `pcb_update_from_schematic` switches `board` on for the session.

State lives under `<project>/.fabdesk/board/`: `requirements/`, `onboard.json`, `onboard-confirmed.json`, `accept/`, `done-mode.json`, `review-gate.json`, `review/` (runs, `dispositions.json`, `intent.json`,
`latest.json`), `layout/`, `lastmile/<workspace>/`, `edits/`, `release/`, `adopt/`.

## Engines

The workflow is TypeScript; engines are programs it runs. KiCadRoutingTools and TraceMaker install themselves the first time a step needs them: the layout host's `ensure` (`board-host.ts` `engineEnsurer` → the router registry's `ensure`; `engineReady` / `requireEngine` in `layout/ctx.ts`) installs the missing engine inline with progress lines, one shared install for concurrent callers. KRT gets a private hash-locked Python (`krt-lock.json`, `--require-hashes`); when the machine has neither uv nor a Python ≥ 3.12 a pinned uv is downloaded to provision CPython 3.12, so nothing has to be preinstalled. A set override (Settings `krtDir`, `FABDESK_KRT_DIR`, `TRACEMAKER_BIN`) is used as given and never installed over; Settings `autoInstallEngines: false` turns installs on first use off; a failed automatic install is not retried automatically. The agent sees and installs engines with `board_engines` (status / install, a durable job); Settings → Routers and `registry.install(id)` remain. Details: `docs/routers.md`.

| Engine | Used by | Found through |
| --- | --- | --- |
| `kicad-cli` (DRC, exports, Gerber plots) | all | the resolved KiCad CLI; DRC at **project severity** with owner-excluded items dropped (`runLiveDrc`) |
| KiCadRoutingTools | `board_route` place, rank, route; every last-mile router, repair (rip) and nudge step; `why` forensics | Settings `krtDir`, then `FABDESK_KRT_DIR`, then the copy Settings → Routers → KiCadRoutingTools installed (pinned v0.23.8 + a private venv; `docs/routers.md`) |
| TraceMaker | `board_route` route; last-mile `fill:tracemaker`; `why` causes and `validate` pair / return-path audits | the router registry (`docs/routers.md`), else `TRACEMAKER_BIN` |
| fab_router, Freerouting | last-mile `fill:ROUTER`, and `finish` when KRT cannot be had | the PCB bridge (inside the app) |

The last mile's step engine is `lastmile/engine.ts` (toolkit `lastmile.run_step`): a `krt` step runs its own plan through
`routeKrt` (the same plan runner as layout) and merges the routed copper onto the native board; a `repair` step rips with
`lastmile/rip.ts` and routes what the rip opened with its plan; a `nudge` step re-seats parts with `lastmile/nudge.ts`
and re-routes the cut connections; `pairfix` runs in place; `fill` runs on the host's routers. Router steps work on boards of
any file name (the host routers get a `board.kicad_pcb` scratch copy). A KRT step first installs KRT when it is missing; when it
cannot be had (install error, broken override, auto-install off) only `finish` (on the host router, recorded as a fallback with the
reason), `fill` and the pair steps run, and every other KRT step fails with the install's reason (its tail, so the bench's last 160
characters keep the advice).
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
| Last-mile rip ([rip](evidence/board-workflow/lastmile-rip-parity.md)) | C6 and cm5_minima, every `rip_items` mode (`--drc`, `--a7`, `--a8` short/long/`--around-ripped`, `--a8-uncoupled` with and without pad stubs, `--window`, `--around-opens`, `--spare-pairs`, `--spare-open-nets`), 40/40 rows | ripped boards and `rip.json` byte-identical | window order under `--a8 --around-ripped` is sorted (the oracle's follows Python set order); argparse prefix abbreviations not accepted |
| Last-mile nudge and fit ([nudge](evidence/board-workflow/lastmile-nudge-parity.md)) | cm5_minima, C6, R1N: points, REF, REF.PAD, rotations, F/B turns, pair cuts, keepouts, fixed parts, R1N allow-all rule areas, two-part moves, `fit` printouts; 132/134 rows | every placed board byte-identical | 2 rows: C6's spec fixes parts that are not anchors (the port's fixed set is anchors plus locked footprints); the `fit` picture is the SVG view, not matplotlib |
| Last-mile pair ops ([pair ops](evidence/board-workflow/lastmile-pairops-parity.md)) | R1N each op alone and the six-op `tighten` (193/195; 44/44 at the oracle's seed 37), cm5_minima as is (195/195) and at pair gap 0.20 (193/193) | agree: R1N A8 24 -> 6, worst length difference 4.27 -> 1.57 mm, DRC 0, collateral 0 on both sides; edited boards byte-identical at seed 37 | 2 rows: retune's walk direction comes from Python set order (the copper is the same; segment order, and so one round's DRC count, differs); mirror-force moving a plane-only ground via and skew banning a DRC-named segment are unit-tested only |
| Last-mile engine with real KRT ([e2e](evidence/board-workflow/lastmile-krt-e2e.md)) | cm5_minima with 3 nets opened, board renamed `CM5.kicad_pcb`; `finish`, `rip`, `blockers:1.0`, `taps`, `pairs-all` against the toolkit's bench on the same KRT build; fakes for the no-KRT and `fill` paths | with the same requirements: figures agree on 4 of 5 and the routed copper is identical for `finish`, `rip`, `blockers:1.0`, `taps` | `pairs-all`: KRT's own finish stage is not deterministic on this board (the oracle rerun gives a third result); with the port's own onboarding the plane layers differ (In1/In4), so `@layers` does too; no C6/R1N-size board routed |
| Integration ([integration](evidence/board-workflow/integration.md)) | live DRC severity; Finish it flag on and off; review → edit bridge on cm5 | A2 now agrees with the oracle (courtyards 1 = 1) | real `board_edit` with a router, and READY from the review bridge: not reached on cm5 (no router outside the app) |

`bun run typecheck` passes. `bun run test` fails three tests, all in `packages/kicad/test/mechanical.test.ts`
("packaged kicad-cli mechanical truth"); they fail identically on a clean checkout of `origin/main`.

### Verification on macOS and Windows

The parts that touch the host OS are unit-tested with fake command output; `scripts/board-engines-smoke.ts` runs them for real and prints a
JSON report (one row per check, exit 1 if any fails):

- host memory: `sysinfo.hostMemory()` reads its platform source (`/proc`, `vm_stat`, `os`) with 0 < available ≤ total, and `sampleHost` can
  statfs; on macOS the raw `vm_stat` and `sysctl vm.swapusage` output go into the report (the unit-test sample was written from memory);
- `processRunning` finds the running Bun and not a made-up name (`pgrep`, `tasklist`); `treeRss` of the process (0 on Windows by design);
- `nodeRun`: exit code, log flushed on resolve, stdout to a file, the child's priority read back (nice +5, or BELOW_NORMAL on Windows), 124 on
  timeout;
- a review custom check through the platform shell (`/bin/sh -c`, Windows `cmd.exe /d /s /c`; a check can name `"shell": "bash"` and others);
- KiCadRoutingTools installed through the router registry (`install("krt")`) into a temp data dir, the venv Python from `krtPaths` importing
  numpy, scipy, shapely and `grid_router`, and `routeKrt` routing `packages/board-workflow/test/fixtures/krt-smoke.kicad_pcb` (two nets, six
  pads, both sides) with new copper and no failed nets.

Run it locally with `bun scripts/board-engines-smoke.ts [--out report.json] [--keep] [--skip-krt]` (needs network for the KRT download).
CI: `.github/workflows/board-engines.yml` runs it, plus `sysinfo.test.ts` and `resources-platform.test.ts`, on ubuntu-latest, a fresh
Blacksmith macOS 15 (Apple Silicon) VM and a Blacksmith Windows Server 2025 VM, on PRs touching the board packages, routers or resources, and by
`workflow_dispatch` (Actions → Board engines → Run workflow, or `gh workflow run board-engines.yml --ref <branch>`; dispatch needs the workflow
on the default branch, so before merge push the branch and open a PR). Each job uploads `board-engines-smoke-<os>.json`. It needs only the three
public submodules (no deploy key). Not covered: macOS x86_64, Windows on ARM (KRT ships no `grid_router` for it), Linux arm64, a machine
without network, KiCad itself (no DRC or scoring in the smoke), and the desktop app's Settings → Routers flow (the smoke calls the registry
directly).

## What differs from the oracle on purpose

These are the port's own decisions, each recorded in the evidence file of its stage.

- Anchor coordinates at micron precision (above). Orderings the oracle took from Python set hash order are sorted.
- `place`: `(at …)` poses are handled (above). Scoring skips the schematic-parity DRC pass during routing (parity is not changed by routing); A3 is "not measured" there.
- Review: custom checks (shell commands from project data) run only with `trustCustom`, in the platform shell unless the check names one; the interconnect gate is a hook, default none; the BOM check reads BOM decisions written by `board_release bom`; storage is `.fabdesk/board/review/`, not a registry.
- Release: strict A1–A9 (no no-regression mode); exceptions only as `CHECK=FILE#ID` with an owner decision; nothing is written into the package folder until the gates pass; drill maps are Gerber X2, not PDF; the pixel-shift search replaces the FFT in `gerbcheck`.
- Silk without pcbnew: shapes come from KiCad's own Gerber plots plus the board file, with a text-extent table measured against pcbnew (within 0.02 mm on all but one measured label).
- Last mile: a `fit` picture is the SVG board view (rasterised by the host), not matplotlib; the nudge's fixed parts are the mechanical anchors plus locked footprints, not a spec regex.
  DRC classes the gate does not count are the board's own (`acceptance.lastmile.inherited_drc` in the requirements, default
  none), not the oracle's carrier-board `hole_clearance`; candidates of one try get unique folders (the oracle refused a
  duplicate output folder); copper merges touch only board-level tracks, vias and arcs (the oracle's regex also cut arcs out of
  pad and polygon outlines).

## Known gaps

Not ported or not wired. None is hidden by a stub: an unported action fails by name.

- **Engines**: KiCadRoutingTools and TraceMaker are not bundled; they install on first use (or with `board_engines`). Cold, KRT takes about 40 s on a fast link and ~125 MB of downloads; offline, the steps that need it fail with the reason and only `finish` (on the app's router), `fill` and the pair steps run. Linux arm64 and Windows arm64 have no prebuilt KRT core: it is built from source only when cargo and a C compiler are present (rustup is not bootstrapped; the source build is unverified on real ARM hardware and not reproducible, as the release has no `Cargo.lock`). The uv bootstrap and hash-locked install are verified cold on Linux x86_64 only (macOS and Windows paths are unit-tested with fakes). `route_run router=tracemaker`, `why` (causes) and `validate` (pair audit) install TraceMaker on first use too.
- **Last mile**: KiCadRoutingTools' installer is verified by hand on Linux x86_64; on macOS arm64 and Windows x64 it is verified by the board engines CI job (see Verification on macOS and Windows), which has to run on a pushed branch before that counts. `fill:fastroute` is not available. `pairbench` (one table over several boards) is a harness, not a tool. The pair `vias` op keeps the toolkit's behaviour of never moving the N member alone (a signed-distance test; see the pair-op evidence).
- **Layout**: plans that ask for `planes` or `escape` raise "not ported"; pair pass-through templates are empty; `add_courtyards` is not ported (check reports the parts, cannot fix them).
- **Edit**: the repair runs editbench's chain (finish; pairs + pairs-all when a pair got worse; then taps, a7, leg, rip + blockers:1.0 while opens or A7 failures remain) and keeps the candidate's last-mile workspace (`<candidate>/.lastmile`) for `board_route`; after the proof the churn guard gives untouched nets their source copper back when the board scores no worse (both ported 2026-11-13, from the pcb-vs-fabdesk eval). `apply_netclasses` for bare boards is not ported. Edit compute (impact, apply, proof) runs in a child process of the core (`child-tasks.ts`, `board-child` subcommand): on jetson (86 MB) it holds ~7 GiB plus the scoring DRC (13.8 GB in all), which inside the daemon had grown it to 20 GB and stalled every client; the edit's own memory use is worth profiling. Review, silk and release compute still run in the core and can move onto the same runner.
- **Python commands with no counterpart**: `intent` (nothing writes `.fabdesk/board/review/intent.json`; the agent or owner edits the file), `cable` (chassis reach), a standalone `diff` picture (the change picture exists inside review fix candidates), `clean` (only `board_route prune`), `upgrade` (a pre-10 board is refused with a hint), `boards` / `status` registry views (the Status page and `board_review status` replace them), and `run` (autopilot; `board_review fix apply` covers its settle-and-build part).
- **Interconnect contracts**: a hook (`setInterconnectGate`), default none for a standalone project.
- **Not in the UI**: adopting or undoing a candidate, diffs, visual constraint capture. The Status page shows A1–A9, review gate and onboarding.
- **Codex**: its client ignores a toolset added mid-session, so a board built in-session is picked up on the next run.
- **Adopt on Windows**: the private `kicad-cli api-server` pair listens on a loopback WebSocket (fab_pcb's Windows transport) and is stopped with `taskkill /T /F`; unit-tested only, not yet run on a Windows host.

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
