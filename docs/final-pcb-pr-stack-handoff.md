# Agent handoff: final Fabdesk PCB PR stack

Last verified: 2026-09-09 (Asia/Bangkok)

## Objective

Land the cross-repository stack that lets an in-app Fabdesk agent create, build, route, inspect,
verify, render, export, and save a PCB through Fabdesk MCP and the bundled headless FabPCB/KiCad
backend. Do not require Browser Use, an external Codex process, or a separately installed bridge.

This document records integration and release state. It is not authorization to merge, publish a
public router bundle, or close an issue whose acceptance criteria have not been checked.

## Authoritative PR stack

| Order       | Repository / PR                                                 | Head verified                              | Purpose                                                                                                                                                                                              | Issue relationship                                                                                                                                                                                                                             |
| ----------- | --------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Independent | [Fabdesk #123](https://github.com/TensorFleet/fabdesk/pull/123) | `ad5049613e154e866fff5c22243ad0ce7d477927` | Restore the latest persisted Route Cinema run after restart or project-root relocation.                                                                                                              | Explicitly closes [Fabdesk #122](https://github.com/TensorFleet/fabdesk/issues/122).                                                                                                                                                           |
| Independent | [Fabdesk #143](https://github.com/TensorFleet/fabdesk/pull/143) | `75365b90422bab7a47220e7f0018dc1343fa975a` | Persist bounded agent/MCP/KiCad traces, project snapshots, portable LLM dumps, and SQLite copies.                                                                                                    | Implements the diagnostic/session-dump portion requested by [FabPCB #11](https://github.com/TensorFleet/fab_pcb/issues/11), but does not declare that issue closed.                                                                            |
| Independent | [Fabdesk #145](https://github.com/TensorFleet/fabdesk/pull/145) | `0217338bf4315bd3b9b2aa5134ed1825b83ad5b0` | Correct DRC/ERC rule labels, artifact names, GLB/PNG distinctions, and current normalized board statistics.                                                                                          | Explicitly closes [Fabdesk #115](https://github.com/TensorFleet/fabdesk/issues/115) and [Fabdesk #144](https://github.com/TensorFleet/fabdesk/issues/144).                                                                                     |
| 1           | [KiCad #3](https://github.com/TensorFleet/kicad/pull/3)         | `2494fe6a1c0e2b34738e323c38aaf6d4901e2ea4` | Publish `DocumentChanged` after successful netlist import and report ERC JSON positions in schematic units.                                                                                         | Dependency of FabPCB #9/#10 and Fabdesk #141; no declared closing issue.                                                                                                                                                                       |
| 2           | [FabPCB #9](https://github.com/TensorFleet/fab_pcb/pull/9)      | `a6bb8f98653fe36aa9e13d3d454fff088f7e2637` | Complete persistent sessions, compilation, placement, generated schematics, route application, library discovery, and reproducible native bundles.                                                   | Implements most of the backend required by FabPCB #11; no declared closing issue.                                                                                                                                                              |
| 3           | [FabPCB #10](https://github.com/TensorFleet/fab_pcb/pull/10)    | `f87d139dd5aaee0ec36283c78d0f68f9c0f43a94` | Replace the tscircuit capacity-router dependency with server-side `js_autorouter`; fix generated-schematic pin coordinates; allow private router source only in internal bundles; isolate KiCad from AppImage launcher variables. | Advances FabPCB #11, contributes the backend half of [Fabdesk #146](https://github.com/TensorFleet/fabdesk/issues/146), and remains a dependency of open macOS packaging issue [FabPCB #12](https://github.com/TensorFleet/fab_pcb/issues/12). |
| 4           | [Fabdesk #141](https://github.com/TensorFleet/fabdesk/pull/141) | `166848ecf9a0b3925b05f4fc1ebf2cb49b651235` | Supervise/package FabPCB, expose the complete MCP inventory, share one KiCad environment, load a bundle-relative router, isolate packaged KiCad, and require parity/ERC/SVG completion in the agent workflow. | Consumes KiCad #3 and FabPCB #9/#10 and implements the desktop half of Fabdesk #146; no declared closing issue.                                                                                                                                |

At verification time, all seven PRs were open. KiCad #3 and Fabdesk #141/#143 were mergeable and
clean; GitHub temporarily reported unknown mergeability for Fabdesk #123/#145, whose CI/security
checks were green. KiCad #3 had no reported checks. FabPCB #9 and #10 were mergeable with green
unit and browser smoke tests, while their self-hosted KiCad jobs (and #9's backend release job)
were still queued; GitHub consequently reported those two PRs as unstable rather than clean.

## Merge procedure

1. Merge independent Fabdesk #123, #143, and #145 in any order. Rebase dependent Fabdesk work if
   GitHub reports overlap.
2. Merge KiCad #3 into the `web-api` branch.
3. Merge FabPCB #9 into `main`; its earlier KiCad pin is superseded by #10's tested pin.
4. Retarget FabPCB #10 from `feature/fabdesk-handoff-followups` to `main`, resolve only the expected
   stack delta, rerun its checks, and merge it.
5. Confirm Fabdesk #141's `vendor/fab_pcb` gitlink equals merged FabPCB #10. Its verified pin is
   already `f87d139dd5aaee0ec36283c78d0f68f9c0f43a94`.
6. Rebase Fabdesk #141 onto the new Fabdesk `main`, rerun CI and the packaged smoke test, then merge.
7. Do not merge or close anything merely because the local integration branch passes. Re-check
   GitHub state and every required check immediately before each merge.

Do not squash the two FabPCB PRs together before retargeting #10: #10 is intentionally based on #9,
and retaining the boundary makes the native-backend work and router replacement independently
reviewable.

## Local integration evidence

The combined Fabdesk test branch was `local/final-pcb-run-20260909`; the uploaded handoff branch is
`codex/final-pcb-pr-stack-handoff-20260909`. It contains Fabdesk #123, #141, #143, and #145. The
latest handoff integration is `b13b9cd`, includes Fabdesk #141 at `166848e`, and pins FabPCB #10
at `f87d139`.

Validation completed locally:

- full Fabdesk test suite passed using bundled KiCad 10.99;
- Fabdesk typecheck, core build, and desktop build passed;
- real-board KiCad tests passed for DRC, statistics, PNG, GLB, SVG, and fabrication exports;
- 17 focused AppImage environment/recovery tests passed, and both Fabdesk and FabPCB typechecked;
- a fresh packaged project built three components and three nets and routed 3/3 connections while
  deliberately injecting the bad AppImage launcher variables covered by the regression;
- a real KiCad compiler integration generated horizontal and vertical symbol pins at their placed
  sheet coordinates and completed ERC with zero electrical errors;
- the packaged `simple-pcb` project generated and displayed both `renders/schematic.svg` and
  `renders/pcb.svg` through the buttons shown in the Schematic and PCB tabs;
- a Fabdesk MCP-only USB-C indicator run exercised parts search, build/rebuild, routing, queries,
  DRC/ERC, Route Cinema, PNG/SVG/GLB renders, BOM, Gerber, drill, position, and ZIP export;
- the route result identified `Autoroute (js)`, routed 13/13 connections, and produced 50 segments
  plus four vias;
- PR #143 recorded a valid 4.56 MB `llm-dump.json`, an identical 853-event JSONL trace, 71
  snapshots, 150 content-addressed blobs with no omissions, and the matching SQLite row;
- the repository-wide Prettier check remained red on the repository's existing broad formatting
  drift; do not run a bulk formatting rewrite as part of this stack.

The earlier schematic ERC failures were not harmless display noise. Library pins were copied as
symbol-relative coordinates into placed-symbol definitions, leaving labels electrically dangling.
FabPCB `e17e2d2` translates them to absolute sheet coordinates and adds unit plus real-KiCad ERC
regressions. KiCad `2494fe6` separately fixes the 100x-too-small positions in its ERC JSON report.

## Linux AppImage evidence

Artifact built from the combined checkout:

- path: `apps/desktop/release/fabplane-0.2.0-linux-x86_64.AppImage`;
- size: 477,653,707 bytes (approximately 456 MiB);
- SHA-256: `ad559ee8ea1ca23f99a68e66b12f79584181d43ec8140b5536ba6155ff1b14fc`;
- embedded KiCad commit: `2494fe6a1c0e2b34738e323c38aaf6d4901e2ea4`;
- embedded core extraction/execution passed;
- packaged bridge discovered 363 libraries, reported `kicadCliExists=true`, and reported
  `jsAutorouter.ok=true` using its bundle-relative router;
- the artifact identity is `fabPlane` in the UI, `fabplane` for the executable/artifact, and
  `com.tensorfleet.fabdesk` for the Linux application identity.

The prior known-good AppImage remains beside it as
`fabplane-0.2.0-linux-x86_64.84cfd93.AppImage` with SHA-256
`16a397f0003f0f55712a32fa2338a7596471a7116df4c6653ceab780cc6f0992`. The same build also produced
`fabplane-0.2.0-linux-amd64.deb` with SHA-256
`06478675dc4f51f33b8951703587a7f957c4f50d3f41a6ccd4334b3d130ede67`.

The first packaged build failure was not a missing `_pcbnew.kiface`. AppImage's `APPDIR` leaked
into the bridge, core, and then KiCad, causing KiCad to search under the AppImage launcher at
`usr/bin` instead of beside the bundled executable under `resources/pcb/kicad/bin`. KiCad created
partial project files before failing, so retries reported that the project already existed. FabPCB
`f87d139` and Fabdesk `166848e` include the fixes that remove launcher variables at process
boundaries and recover by releasing a bare session after partial `NewProject` failure. This fix is
tracked by
[Fabdesk #146](https://github.com/TensorFleet/fabdesk/issues/146).

Run it on this development machine with an explicit external project root:

```bash
cd /home/shane/fabdesk-pcb-pr-stack/apps/desktop/release
FABDESK_PROJECTS_DIR=/home/shane/fabdesk-projects \
  ./fabplane-0.2.0-linux-x86_64.AppImage
```

The production default is `~/fabdesk`. On this machine that path is a source checkout, so launching
without `FABDESK_PROJECTS_DIR` would incorrectly place projects inside a repository. Never put
Fabdesk projects or `.fabdesk/runs` into the Fabdesk source tree.

The packaged bridge uses port 4020. Before launching, stop the development stack and verify that
4020 is free so an existing bridge cannot mask the embedded backend. After launch, inspect
`http://127.0.0.1:4020/health` and require:

- `workspaceRoot` equals the intended external project directory;
- `kicadCliExists` is `true`;
- `jsAutorouter.ok` is `true`;
- the reported KiCad path is under the mounted AppImage's `resources/pcb` directory.

The tested AppImage did not contain a working Freerouting jar (`freerouting.ok=false`), while
`js_autorouter` was healthy and handled the tested agent workflow. Treat Freerouting packaging as a
separate optional follow-up unless release requirements explicitly make it mandatory.

## Run-dump workflow

Completed agent runs are recorded under the project, outside source repositories:

```text
<project>/.fabdesk/runs/<run-id>/trace.jsonl
<project>/.fabdesk/runs/<run-id>/llm-dump.json
<project>/.fabdesk/runs/<run-id>/snapshots/
```

The same completed dump is stored in Fabdesk's SQLite `run_dumps` table. Export it for another agent
without manually querying SQLite:

```bash
bun run runs:export -- <run-id>
```

Project templates must ignore `.fabdesk/`. Dumps can contain prompts, tool arguments/results,
project file contents, CLI output, and stack traces, so review/redact before sharing outside the
team.

## Open work and stop conditions

- [FabPCB #11](https://github.com/TensorFleet/fab_pcb/issues/11) remains open for the stronger
  quality/fail-closed acceptance criteria. PR #143 supplies the evidence needed to analyze it.
- [FabPCB #12](https://github.com/TensorFleet/fab_pcb/issues/12) remains open for native macOS x64
  and arm64 backend bundles, DMG/ZIP creation, signing, notarization, and clean-host tests.
- [Fabdesk #146](https://github.com/TensorFleet/fabdesk/issues/146) has a validated fix in FabPCB
  `f87d139` and Fabdesk `166848e`; keep it open until those commits land and its packaged acceptance
  checks are confirmed from the merged branches.
- Do not attach an embedded private-router bundle to a public GitHub Release until the
  `js_autorouter` licensing/distribution decision is explicit.
- Wait for or rerun FabPCB's queued native KiCad/release jobs before merging those PRs.
- After the final Fabdesk rebase, repeat one clean packaged run and one Route Cinema restart test.

## Definition of stack completion

For this integration milestone, completion means the embedded Fabdesk agent can discover and invoke
the entire PCB MCP workflow against the supervised bundled backend, `js_autorouter` is the active
server router, generated schematics pass ERC, both SVG views are produced, outputs persist outside
the source repository, packaged Linux startup uses the embedded KiCad runtime, and run evidence is
exportable for later LLM analysis. The local tests above meet that milestone; merge and
platform-release work remains governed by the ordered checklist.
