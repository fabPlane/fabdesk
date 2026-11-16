# Reviewing the board workflow integration (PR #448)

How to review `feat/board-workflow`: what to read, in what order, what to check, and how to reproduce the evidence. The design,
verification status and known gaps are in [board-workflow-design.md](board-workflow-design.md); this page is the review procedure.

## What you are reviewing

The PCB method refined on real boards (the vaio I/O board C6 and carrier R1N) in the external Python toolkit `~/pcb`, integrated
into Fabdesk as TypeScript. The question for review: **is the toolkit's workflow properly integrated into Fabdesk, and does the
evidence show it works well there?** Scope is placed board → fab-ready; the text → placed board handoff is a known, separate gap.

Scope: about 60k added lines across 388 files, including tests, parity harnesses and evidence. Use `git diff --stat origin/main...HEAD` for the current size.

| Area | Lines | Review depth |
| --- | --- | --- |
| `packages/board-workflow/src` (library) | ~19k | Read the stage you know best in full; skim the rest against its parity evidence |
| `packages/board-workflow/test` (unit tests + parity harnesses) | ~6k | Check that the tests assert behaviour, not just shape |
| `packages/tools/src` (tools, installer, governor, jobs, adopt) | ~4k | **Read in full**: this is where Fabdesk state, the network and processes are touched |
| `apps/core`, `packages/protocol`, `packages/ui`, `packages/agents`, `plugins/fabplane` | ~1.6k | Read in full: Finish it, MCP sessions, settings, agent text |
| `docs/evidence/board-workflow/*.md` | ~1.8k | Read the tables and the "differs" rows; skip the method prose once |
| `.github/workflows/board-engines.yml`, `scripts/board-engines-smoke.ts` | ~350 | Read in full |

## Reading order

1. **[board-workflow.md](board-workflow.md)**: the text the agent reads (stages, A1–A9, working rules, defaults). Everything below
   should do what this page says. It equals `packages/agents/src/board-workflow-md.ts` (a test enforces it).
2. **[board-workflow-design.md](board-workflow-design.md)**: tools, how stages connect, engines, verification table, deliberate
   differences from the toolkit, known gaps.
3. **The tools** (`packages/tools/src/tools/board-*.ts`): thin wrappers. Check each `description` against what the handler does.
   - `board-check.ts`, `board-route.ts` (+ `board-lastmile-actions.ts`, `board-host.ts`), `board-edit.ts`, `board-review.ts`,
     `board-silk.ts`, `board-release.ts`, `board.ts` (`board_job`), `board-engines.ts`.
4. **The library**, one stage at a time, each with its evidence file open beside it:

   | Stage | Code | Evidence |
   | --- | --- | --- |
   | Onboard + A1–A9 | `onboard.ts`, `accept.ts`, `requirements.ts` | `stage1-parity.md` |
   | Layout | `layout/` | `layout-parity.md` |
   | Last mile | `lastmile/` (`engine.ts` runs steps; `rip.ts`, `nudge.ts`, `tighten.ts` + `pairops.ts`, `bench.ts`, `gate.ts`) | `lastmile-parity.md`, `lastmile-rip-parity.md`, `lastmile-nudge-parity.md`, `lastmile-pairops-parity.md`, `lastmile-krt-e2e.md` |
   | ECO edit | `edit/` | `edit-parity.md` |
   | Review | `review/`, `review-edit.ts` | `review-parity.md` |
   | Silk + release | `silk/`, `release/` | `release-parity.md` |
   | Cross-cutting | `sysinfo.ts`, `sexpr.ts`, `board.ts` | `integration.md` |

5. **Plumbing**: `packages/tools/src/{resources,durable,board-state,board-adopt}.ts`, `routers/{krt,uv,registry}.ts`,
   `apps/core/src/{serve,finish-it-plan,mcp-sessions,mcp-stdio}.ts`.

## What to check

### Integration (is the toolkit's method really there?)
- [ ] Every toolkit stage and step the agent text names exists and does what it says. Unported or unavailable steps must **fail by
      name**, never silently do something else (this was a bug once: last-mile router steps used to collapse into one generic route).
- [ ] Last-mile steps run their own KRT plans (`lastmile/engine.ts` → `layout/route.ts` `routeKrt`), rip before routing for
      `repair` steps, nudge before routing for `nudge` steps; boards of any file name work (not only `board.kicad_pcb`).
- [ ] The deliberate differences from the toolkit (design doc → "What differs from the oracle on purpose") are reasonable and none
      is hidden elsewhere.
- [ ] Nothing at runtime reads `~/pcb`, runs a `pcb` binary or needs `FABDESK_PCB_BIN` (`grep -rn "pcb-worktrees\|FABDESK_PCB_BIN\|~/pcb" packages apps --include=*.ts`
      should hit only tests/harnesses).

### Safety of the user's project
- [ ] Every write goes under `<project>/.fabdesk/board/` (workspaces, candidates, records) until an explicit adopt.
- [ ] Adopt (`board-adopt.ts`) is all-or-nothing: board and sheets backed up first, restored on any failure, error says so.
- [ ] The review gate (`board-state.ts`) goes stale on any change it covers (board, schematics, project files, requirements), and
      `board_release fab` writes nothing unless every gate passes for this exact design.
- [ ] Paths from tool input are confined to the project (`workspace`, `candidate`, `spec`, `plan` file arguments).

### Engines, network, processes (supply chain)
- [ ] KRT install (`routers/krt.ts`): pinned release URL + sha256, platform binary choice, Python packages installed with
      `--require-hashes` from `routers/krt-lock.json`, no unpinned download, nothing written outside the fabdesk data dir.
- [ ] uv bootstrap (`routers/uv.ts`): pinned version, per-platform sha256 from the release's published sums.
- [ ] Auto-install on first use (`registry.ensure`): one shared install, never installs over a set-but-broken override
      (`krtDir`, `FABDESK_KRT_DIR`, `TRACEMAKER_BIN`), honours Settings `autoInstallEngines`; no tokens shipped.
- [ ] Resource governor (`resources.ts`, `sysinfo.ts`): a job waits only on another admitted job (never forever); memory per
      platform (Linux `/proc`, macOS `vm_stat`, Windows `os.freemem`); one TraceMaker at a time.
- [ ] Durable jobs (`durable.ts`, `board_job`): scoped to the calling project, pruned, cancel reports the real end state.
- [ ] Owner custom review checks (`review/checks.ts`) run only with `trustCustom`, through the platform shell.

### The agent's experience (is it smooth?)
- [ ] A project with a placed board starts with `core`, `render`, `board` toolsets (desktop runs **and** external MCP sessions:
      `projectStartToolsets`); `circuit_build` / `pcb_update_from_schematic` switch `board` on.
- [ ] Finish it uses A1–A9 and the review milestone only for a project with a placed board (`boardChecksInFinishIt`), and its
      prompt names `board_route` / `board_review`.
- [ ] External Codex / Claude Code: MCP instructions and resource `fabdesk://docs/board-workflow` / prompt `board_workflow` come
      from `BOARD_WORKFLOW_MD`; board calls return a job id before the client's timeout (`durableWaitMs`).
- [ ] Tool results: a STOP / FAIL / NOT RELEASED is a normal result with its reason, not a tool error; step errors stay short
      (the bench shows the last 160 characters).

### Code conventions (AGENTS.md)
- [ ] Strict TS idioms (`exactOptionalPropertyTypes`: `...(x ? { k: x } : {})`), extensionless relative imports, `zod/v4`,
      underscore MCP tool names, client code not DOM-bound in `client-core`.
- [ ] No `bun install` inside `vendor/`, submodule pins unchanged versus `main`.

## Reproduce the evidence

Run from the repository root of a checkout of `feat/board-workflow`.

**Every reviewer** (minutes):
```bash
bun install && bun run typecheck && bun run test
```
Expected: all green except the 3 `packaged kicad-cli mechanical truth` tests in `packages/kicad`, which fail the same way on `main`.

**Engines on this machine** (a minute or two; downloads KRT and Python packages into a temp dir):
```bash
bun scripts/board-engines-smoke.ts
```
Prints a JSON report: host memory, process check, process priority, custom-check shell, KRT install, import, and a real KRT route
on `packages/board-workflow/test/fixtures/krt-smoke.kicad_pcb`. CI runs the same on ubuntu, macOS arm64 and Windows
(`.github/workflows/board-engines.yml`, on this PR).

**Parity with the toolkit** (needs the Python toolkit checkout `~/pcb-worktrees/heldout`, `kicad-cli` nightly, the boards in
`~/pcb-cmp` and `~/vaio_p_modding`; one heavy job at a time — routing on large boards holds several GiB):
```bash
bun packages/board-workflow/test/parity-rip.ts     --board ~/vaio_p_modding/io-c6/work/c6-rerun91/final --spec ~/vaio_p_modding/io-c6/release/C6-eco95/spec.json --out /tmp/rip --perturb 8
bun packages/board-workflow/test/parity-pairops.ts --board DIR --spec SPEC.json --out /tmp/pairops   # R1N: io-c6/release/R1N-bom with the pairs97/98 acceptance, see lastmile-pairops-parity.md (A8 24 -> 6)
bun packages/board-workflow/test/parity-nudge.ts --out /tmp/nudge   # cm5_minima, C6, R1N cases built in
bun packages/board-workflow/test/e2e-lastmile-krt.ts --board ~/pcb-cmp/cm5_minima/proj2 --spec ~/pcb-cmp/cm5_minima/onboard/spec.json --out /tmp/e2e --same-req --actions finish,rip,blockers:1.0,taps
```
Each harness prints its usage in its file header and writes a table (`*-parity.md` / `e2e.json`) into `--out`; compare with the
committed evidence file. The other stages: `parity-stage1.ts`, `parity-edit.ts`, `parity-review.ts`, `parity-release.ts`,
`parity-layout.ts`, `parity-lastmile.ts`, `review-seeds.ts`.

**Against stock agents** (hours, paid model use): the paired slice in `~/pcb-cmp/harness` (`slice-2026-11-12b.sh`, results in
`~/pcb-cmp/results-slice-2026-11-12`, graded by `grade.py` with the toolkit as an independent checker). Results are posted on the PR.

## Known gaps — do not flag these as new findings

Use the current [design doc → Known gaps](board-workflow-design.md#known-gaps) as the source of truth. In particular:
text → placed board handoff; unpublished TraceMaker placer binaries (an explicit `TRACEMAKER_PLACE_BIN` works);
ARM KRT source builds and macOS x86_64; candidate adopt/undo/diff in the UI; jobs not persisted across a daemon restart.
Courtyard refit, planes/escape steps, edit repair/churn guard, intent and review autopilot are implemented and should be reviewed.
Flag a documented gap if the code or agent text claims otherwise.

## Reporting

Per finding: file:line, what is wrong, a concrete failure scenario (inputs → wrong result), and whether it contradicts the agent
text, the design doc or an evidence file. Separate **blocking** (project corruption, wrong release gate, unpinned download, an
advertised step that silently does something else) from **follow-up**.
