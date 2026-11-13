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
| `board_check` | (one call) onboard on first use, then A1–A9 on the saved board, history, change against the board as onboarded; `upgrade` (pre-10 file format), `confirm`, `candidate` | `accept`, `onboard`, `history` |
| `board_route` | `check` `place` `rank` `route` `auto` `status` `courtyards` (layout; the layout spec carries pairseat templates); `blocks` `floorplan` `block_eval` `placement` (the floorplan path: the toolkit's `block_inventory`, `floorplan_run` + `block_pass`, `block_eval`, `placement_check`); `new` `try` `loop` `sweep` `why` `crossings` `fit` `pairs` `validate` `accept` `undo` `view` `info` `prune` (last mile; the `replace:GROUP` action is `route_region --replace`); `clean` (housekeeping, the toolkit's `clean.py` for `.fabdesk/board/`) | `layout/`, `lastmile/`, `clean.ts` |
| `board_edit` | `mode` impact · apply · proof · full; `adopt`; plan keys remove, move (`to`, `near` a part / pad / point / `net:NAME`), displace, `legalise` (the toolkit's `tp_legalise`, its own search: test points to the first free spot round their net's centroid; poses equal tp_legalise.py's on cm5_minima TP101–TP106, vme-wren TP1–TP6 and all 115 jetson test points), swap, add, net | `edit/` |
| `board_review` | `run` `gate` `dispose` `fix` `try` `autopilot` `intent` `intent_init` `intent_decide` `import_expert` `status`; `cable` `page` `diff` (look at boards, never touch the review record) | `review/`, `review-edit.ts` |
| `board_silk` | `check` `place` `show` | `silk/` |
| `board_release` | `bom` `gerb` `check` `fab` `cam` `vias` | `release/` |
| `board_job` | `wait` `status` `cancel` `list` | `packages/tools/src/durable.ts` |

`board_edit`, `board_release`, `board_silk`, `board_route` and `board_review run` / `try` / `autopilot` run through `runDurable` (`board_check` and the other `board_review` actions return directly): a call waits up to 25 minutes, then returns a job id while the job continues
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
| tracemaker-place (TraceMaker's placer) | `board_route` floorplan, block_eval with `replace`; last-mile `replace:` | `TRACEMAKER_PLACE_BIN`, else the registry's `tracemaker-place` beside TraceMaker (Fabdesk's TraceMaker archives ship it; `ensurePlacer` installs TraceMaker on first use, or upgrades an older archive), else beside the TraceMaker binary or in its build tree's `src/place` ([routers](routers.md#tracemakers-placer-tracemaker-place)) |
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
| Onboard + A1–A9 ([stage1](evidence/board-workflow/stage1-parity.md)) | cm5_minima (live DRC, 19/19 rows), vme-wren (recorded DRC) | agree, except one deliberate difference | anchors written at micron precision, not 6 significant digits (the oracle's own A5 fails on an untouched vme-wren with `%g`); C6, vme-wren stressed variant not run; a pre-10 board is refused until `board_check upgrade: true` (KiCad's `pcb upgrade` on a copy, every item's net checked, written over the board with the previous one kept; unit-tested with a faked kicad-cli, not run on cm5) |
| Edit ([edit](evidence/board-workflow/edit-parity.md)) | cm5_minima 9 plans, 176/176 rows (live DRC); vme-wren apply and impact only, 70/70 | agree | strict-mode verdicts, `make_room`, `fixed_allowed`, `dnp`, side flip, `symbol` add: unit-tested only; vme-wren candidates not scored; sheets in sub-folders not handled |
| Review ([review](evidence/board-workflow/review-parity.md)) | cm5_minima, 64/64 findings as onboarded and 103/103 stressed, same ids and severities | agree | 19 of 20 checks (`silk` joined the review on 2026-11-13 and is unit-tested only, not compared on cm5); seed bench (11/11) not run; escape replay: see the bench row; cards and ratings produced no findings on cm5, so unit-tested only |
| Release and silk ([release](evidence/board-workflow/release-parity.md)) | jlcsim cm5, C6, R1N identical; BOM, viaproc identical; silk counts equal on four boards | 28 of 33 harness rows agree | silk: label positions equal for 104/112 on cm5 (greedy solver; small geometry differences), 7 vs 8 silk-over-copper hits, on the TF board 17 labels are hidden against the oracle's 16; gerbcheck uses its own reader (no gerbonara); Python `fab.py` itself never run (its review gate needs the toolkit registry) |
| Layout ([layout](evidence/board-workflow/layout-parity.md)) | cm5_minima `check` and derived inputs agree; `place` differs | **oracle bug**: on boards with `(at x y rot)` poses the oracle's `set_pose` rotates but never moves footprints, so every seed fails the courtyard gate. The port handles `(at …)` and passes 4/4. | `rank` and `route` ran on cm5 (rank best seed 18 opens; route 16 opens, A1/A2/A8 failing, 1028 s) with **no oracle figures** (the oracle refuses this board as "pre-10 format" and its TraceMaker step crashes); vme-wren, jetson, default 8-seed rank, repeat runs: not run |
| Last mile ([lastmile](evidence/board-workflow/lastmile-parity.md)) | cm5_minima, 22/22 rows (figures, 18 pair measurements, crossings, gate on 400 random pairs, tighten) | agree | `try finish` not compared (different routers); router wiring exercised with fakes and one real `tighten` run, not against a real bridge |
| Last-mile rip ([rip](evidence/board-workflow/lastmile-rip-parity.md)) | C6 and cm5_minima, every `rip_items` mode (`--drc`, `--a7`, `--a8` short/long/`--around-ripped`, `--a8-uncoupled` with and without pad stubs, `--window`, `--around-opens`, `--spare-pairs`, `--spare-open-nets`), 40/40 rows | ripped boards and `rip.json` byte-identical | window order under `--a8 --around-ripped` is sorted (the oracle's follows Python set order); argparse prefix abbreviations not accepted |
| Last-mile nudge and fit ([nudge](evidence/board-workflow/lastmile-nudge-parity.md)) | cm5_minima, C6, R1N: points, REF, REF.PAD, rotations, F/B turns, pair cuts, keepouts, fixed parts, R1N allow-all rule areas, two-part moves, `fit` printouts; 132/134 rows | every placed board byte-identical | 2 rows: C6's spec fixes parts that are not anchors (the port's fixed set is anchors plus locked footprints); the `fit` picture is the SVG view, not matplotlib |
| Last-mile pair ops ([pair ops](evidence/board-workflow/lastmile-pairops-parity.md)) | R1N each op alone and the six-op `tighten` (193/195; 44/44 at the oracle's seed 37), cm5_minima as is (195/195) and at pair gap 0.20 (193/193) | agree: R1N A8 24 -> 6, worst length difference 4.27 -> 1.57 mm, DRC 0, collateral 0 on both sides; edited boards byte-identical at seed 37 | 2 rows: retune's walk direction comes from Python set order (the copper is the same; segment order, and so one round's DRC count, differs); mirror-force moving a plane-only ground via and skew banning a DRC-named segment are unit-tested only |
| Last-mile engine with real KRT ([e2e](evidence/board-workflow/lastmile-krt-e2e.md)) | cm5_minima with 3 nets opened, board renamed `CM5.kicad_pcb`; `finish`, `rip`, `blockers:1.0`, `taps`, `pairs-all` against the toolkit's bench on the same KRT build; fakes for the no-KRT and `fill` paths | with the same requirements: figures agree on 4 of 5 and the routed copper is identical for `finish`, `rip`, `blockers:1.0`, `taps` | `pairs-all`: KRT's own finish stage is not deterministic on this board (the oracle rerun gives a third result); with the port's own onboarding the plane layers differ (In1/In4), so `@layers` does too; no C6/R1N-size board routed |
| Power ports (`parity-power.ts`) | `apply_netclasses` on C6, cm5_minima, vme-wren, jetson judged bare (and native: untouched); `power_escape` on C6 placed and routed, cm5, vme-wren, jetson (a 0.6 mm power class where the board had none); `power_planes` on C6 with its In4 plan and board plans on the three others; `pour_opens` on C6 (2 scored folders), cm5, jetson, end to end on cm5 | project JSON and `.kicad_dru` identical; escape track sets and counts identical, boards byte-identical with the script's uuids on 4 of 5; plane zones and records identical (up to 75 pieces, 66 corridors); pours and `pours.json` identical, and on cm5 the poured board byte-identical with A1–A9 equal | jetson escape: one bridge emitted in the other order and direction (the script orders pin pairs by CPython object id); `power_planes.py` has C6's outline box written in, so on the other boards a copy with the box from the plan ran; KiCad's fill and unconnected list depend on zone uuids (cm5 pours: 18 vs 17 opens with fresh uuids, equal with the same ones) |
| Cable reach, board page, change picture, bench tools ([views and bench](evidence/board-workflow/views-bench-parity.md)) | cable: the vaio chassis files (3 files, 31 frame x cable results, also with the eco95 board swapped in) and 3 edge sweeps (141 rows); board page: C6 full page, cm5 and vme per layer (DRC reports from kicad-cli); change picture: C6 -> C6-eco95, b2245 -> b22451, b81 -> b83, with and without `--layers`; editbench tasks on cm5 and vme, table over 22 C6-eco95 results; pairbench metrics and collateral on C6/C6-eco95, cm5, vme; escape replay over the 7 replay boards | identical (cable results and printed lines; layer SVG bodies, opens, DRC errors; change pages byte for byte apart from Python set order; plans; table; 12/12 escapes with the same finding ids) | board page: the layer list follows the board's copper (the toolkit's is its 8-layer board's and fails on others), 3D renders not compared (images); pairbench's runner (bench `try` of pair actions) not run (no router or KRT run for this comparison), only its metrics and table |
| Placement and floorplan ([placement](evidence/board-workflow/placement-parity.md)) | `placement_check` and `block_inventory` on C6 (placed-E2, the release board, four ICs turned), cm5_minima, vme-wren; `floorplan_run` on C6 (the owner's H2 floorplan replaying its recorded TraceMaker outputs, 10 passes; disp-V6 with sub-groups and pinned poses on a stand-in placer); route_region's rip on C6 (two cases), cm5, vme; block_eval's plan for three C6 groups | agree: whole JSON (placement, blocks), pass records, placer arguments, pass inputs and final boards byte for byte (floorplan), ripped boards byte for byte | rotation ties with zero saving are float noise in the toolkit (compared as ties); no real tracemaker-place run (the eval held the machine); the floorplan's final test-point step is the edit stage's `legalise` (its own parity); route_region's TraceMaker / fastroute routing is replaced by the last mile's KRT `after-cut` plan |
| Courtyards (`parity-courtyards.ts`) | `add_courtyards.py` (main 066fea8) on C6 fab112 (owner repo f1a1d256: add mode, and the J101/IC201 `--refit --bodies part-bodies.json` that shipped in fab116), C6 release (add, halos, refit with and without bodies), cm5_minima and vme-wren (add, halos on two parts, refit of three 90/270-degree parts pads-only and with a body crossing the pad box), synthetic 0/90/180/270/-90/45-degree footprints in both pose spellings; 38/38 rows | boards byte-identical (uuids of new items masked) and printed JSON equal; the C6 refit also equals the board the owner committed (32fac8bb) | none differ; the pre-fix angle reading had measured 147 (C6), 31 (cm5), 369 (vme) footprints' pad boxes wrong |
| Acceptance judging rules (`parity-acceptance.ts`) | C6-eco95 with its own acceptance.json (4 named courtyard-overlap exceptions; `inner_neck_allowance_mm: 0` on PWR_LOGIC_3313 / PWR_LCD33_3313; named PWR proxy classes): 3 DRC reports (live, fab116's recorded, j101-courtyard113's) x 5 requirement variants (as written, no exceptions, one dropped plus absent pairs, allowances removed, allowance 0 on every power class); 159/159 rows | every A1-A9 field equal to `check_acceptance.py`, and the review's drc findings equal to `check_drc` | A8's `note` is worded for the port (compared apart); before the port A2 failed this board (4 courtyards_overlap, 1 PWR_LCD33_3313 width proxy) |
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
  An edit candidate (a `fix` proposal, `try`, the combined candidate) is judged by a full review of the candidate, where the toolkit re-runs identity, netlist and the
  finding's own check only: a fix that breaks a label or any other check is not READY. Candidate records of another design hash are ignored by the gate's
  classification, `fixes/combined.json` is removed when fewer than two edits are READY, and `try` also writes the change picture of a READY candidate
  (the toolkit draws it for `fix` candidates only). The silk check's plot failing is a check error (a silent empty plot would pass every label).
- Release: strict A1–A9 (no no-regression mode); exceptions only as `CHECK=FILE#ID` with an owner decision; nothing is written into the package folder until the gates pass; drill maps are Gerber X2, not PDF; the pixel-shift search replaces the FFT in `gerbcheck`.
- Silk without pcbnew: shapes come from KiCad's own Gerber plots plus the board file, with a text-extent table measured against pcbnew (within 0.02 mm on all but one measured label).
- Placement and floorplan: C6's hard-coded values are options or derived (outline for the via-site grid, the ground net, the fixed pattern, the off-board staging square and the keep-out box, both reproducing C6's numbers); a zero-saving rotation tie names the first turn (the toolkit's choice is the last bit of a set-order sum); a footprint written `(transform (translate ..))` without `(rotate)` reads as 0 degrees (the toolkit found no pose); the gather point is also applied to boards written with `(at x y r)` poses; `block_eval` takes its base plan from the layout spec's TraceMaker plan, not C6's `plan-r6.json`, and sets no `escape`; last-mile `replace:` routes with the KRT `after-cut` plan (cut pairs as pairs first), not TraceMaker's CLI.
- Courtyards: a refit naming a reference twice refits it once (the script would edit stale spans); an unknown reference, a part without pads or a body without `size` is refused by name (the script raised a KeyError / TypeError); a footprint without a copper side counts as front.
- Last mile: a `fit` picture is the SVG board view (rasterised by the host), not matplotlib; the nudge's fixed parts are the mechanical anchors plus locked footprints, not a spec regex.
  DRC classes the gate does not count are the board's own (`acceptance.lastmile.inherited_drc` in the requirements, default
  none), not the oracle's carrier-board `hole_clearance`; candidates of one try get unique folders (the oracle refused a
  duplicate output folder); copper merges touch only board-level tracks, vias and arcs (the oracle's regex also cut arcs out of
  pad and polygon outlines).
- Power ports: `power_planes` takes the board outline's bounding box for its grid (the script had C6's 74.9 x 65.4 mm box written in) unless
  the plan gives `box`, and names zones with `name_prefix` (default `power_planes`, the script wrote `C6`); `power_escape` visits same-net pin
  pairs in file order (the script's CPython object-id order is not reproducible). `escape`, `planes:FILE` and `pour` are also last-mile steps
  under the bench gate (the toolkit ran escape and planes only before routing, and `pour_opens` as a separate scored run). The release applies the
  acceptance rules to the project like `fab.py` but stops when that changed it (the design hash the review covers includes project files).

## Known gaps

Not ported or not wired. None is hidden by a stub: an unported action fails by name.

- **Engines**: KiCadRoutingTools and TraceMaker are not bundled; they install on first use (or with `board_engines`). Cold, KRT takes about 40 s on a fast link and ~125 MB of downloads; offline, the steps that need it fail with the reason and only `finish` (on the app's router), `fill` and the pair steps run. Linux arm64 and Windows arm64 have no prebuilt KRT core: it is built from source only when cargo and a C compiler are present (rustup is not bootstrapped; the source build is unverified on real ARM hardware and not reproducible, as the release has no `Cargo.lock`). The uv bootstrap and hash-locked install are verified cold on Linux x86_64 only (macOS and Windows paths are unit-tested with fakes). `route_run router=tracemaker`, `why` (causes) and `validate` (pair audit) install TraceMaker on first use too.
- **Last mile**: KiCadRoutingTools' installer is verified by hand on Linux x86_64; on macOS arm64 and Windows x64 it is verified by the board engines CI job (see Verification on macOS and Windows), which has to run on a pushed branch before that counts. `fill:fastroute` is not available. `pairbench` (one table over several boards) is a library function and dev script (`scripts/bench.ts pairs`), not a tool. The pair `vias` op keeps the toolkit's behaviour of never moving the N member alone (a signed-distance test; see the pair-op evidence).
- **Layout**: The floorplan path's `tracemaker-place` ships in Fabdesk's TraceMaker archives only once the weekly TraceMaker binaries job has rebuilt them with it (verified locally on Linux; macOS and Windows only by that CI run). Until the published release carries it, the floorplan path fails by name with the reason and `TRACEMAKER_PLACE_BIN` as the way out. route_region's `--router fastroute`, `--escape` (power_escape) and `--plan` are not ported; `--around-opens` is the last mile's `blockers:R`. `add_courtyards` (with `--refit` / `--bodies`, and the 2026-11-13 relative pad angle) is ported as `board_route courtyards`.
- **Pairs routed apart through a tight connector fan-out** (the eval's HDMI board, 0.5 mm pitch): `bundle` / `pairs-all` fail here exactly as in the toolkit; KiCadRoutingTools routes a leg single-ended when it is "electrically short" (under max(5 x the centerline setback, 3 mm) of coupled run), and a smaller `--diff-pair-centerline-setback` (plan:FILE) only reaches the 3 mm floor (A8 9 -> 8, one new open). Every agent that passed routed these pairs by hand. The `pairs` report says so and names the try to run first.
- **Edit**: the repair runs editbench's chain (finish; pairs + pairs-all when a pair got worse; then taps, a7, leg, rip + blockers:1.0 while opens or A7 failures remain) and keeps the candidate's last-mile workspace (`<candidate>/.lastmile`) for `board_route`; after the proof the churn guard gives untouched nets their source copper back when the board scores no worse (both ported 2026-11-13, from the pcb-vs-fabdesk eval). `apply_netclasses` for bare boards is not ported. Edit compute (impact, apply, proof) runs in a child process of the core (`child-tasks.ts`, `board-child` subcommand): on jetson (86 MB) it holds ~7 GiB plus the scoring DRC (13.8 GB in all), which inside the daemon had grown it to 20 GB and stalled every client; the edit's own memory use is worth profiling. Review, silk and release compute still run in the core and can move onto the same runner.
- **Ported 2026-11-13**: `cable` is `board_review cable` (an action of the reviewer: a fit review across boards that shares the mouth check's rule; the edit impact's moved-connector line points at it); `diff OLD NEW` is `board_review diff` (the same picture as every READY candidate's change.html); `tools/board_page.py` is `board_review page`; `editbench tasks` / `table`, `pairbench` and `review bench` are `src/bench/` plus `packages/board-workflow/scripts/bench.ts` (they measure the workflow, so they are a dev harness rather than agent tools; the replay boards are not shipped, the script is pointed at them).
- **Python commands with no counterpart**: the `boards` registry view (a project is the unit; `board_check` prints `pcb status`'s lifecycle via `board-status.ts`). `pcb run` is `board_review autopilot` (its low-disk test: under 10 GiB or 10 % free it settles and builds no candidate), `pcb intent` is `board_review intent` / `intent_init` / `intent_decide`, and `review try` is `board_review try`.
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
- Parity harnesses: `packages/board-workflow/test/parity-{stage1,edit,review,release,layout,lastmile,power,cable,page,diff,bench,courtyards,acceptance}.ts`, and `review-seeds.ts`. Measurement harnesses (edit suite, pair bench, escape replay): `packages/board-workflow/scripts/bench.ts`. They need the
  Python oracle checked out and `kicad-cli`; run one heavy board job at a time (routing on large boards holds several GiB, and an earlier
  run of several jobs at once exhausted memory).
- `.gitignore` contains `release/`; `packages/board-workflow/src/release/` is excepted. Check `git status --ignored` after adding a directory named like an ignored one.
