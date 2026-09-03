# Viagrid 9055 in Fabdesk

Date: 2026-09-03. Branch `viagrid-test` (from `main` @ `ec4952b`). Machine: Windows 11, dev app (`bun run dev`),
local auth, capacity router, KiCad 10.0.6 and Claude Code 2.1.259 installed during the session.

[Viagrid](https://github.com/opulo-inc/viagrid) is Opulo's PCB template standard: a factory-made 2-layer blank
with vias already in it. You design *around* the vias (only the blank's vias may be used), then remove copper at
home (UV laser + LightBurn DXF, chemical etch, or CNC) to isolate the nets. The **9055 Standard** is the only
finished blank: 90 x 55 mm, 180 grid vias, 4 mounting holes for Hammond 1591XX enclosures.

## Status: the app builds a Viagrid 9055 board

After the changes below, a project set to `template: "viagrid-9055"` goes build → route → verify → KiCad → DRC →
render with every via on a factory via. Measured on the original 555 blinker layout (the one that needs layer
changes):

| Step | Before (main) | After (viagrid-test) |
| --- | --- | --- |
| `route_run` | 16 new vias, 0 on the grid | 6 vias, 6 on factory vias, `preset: laser-prefab` |
| `circuit.routed.json` | 180 factory vias + 16 new `pcb_via` | 180 factory vias, 6 of them `net_assigned`, 0 added |
| `verify_viagrid` | (did not exist) | passes: 6 claimed, 0 added, pads clear of holes |
| KiCad vias | all 180 on `(net 0)` | claimed vias carry their nets |
| KiCad DRC | 10 clearance errors (router vias vs tracks) | 33 clearance errors, all track spacing (see "Still open") |

The agent-written layout (parts in the via-free window) routes with 0 vias, `verify_viagrid` passes and KiCad
DRC reports **0 errors**.

## What was implemented

- **Board template** (`packages/protocol/src/api.ts`, `packages/tools/src/templates/viagrid-9055.ts`,
  `packages/tools/src/tools/project.ts`): `fabdesk.json` `board.template = "viagrid-9055"`.
  `project_set_board { template: "viagrid-9055" }` writes `viagrid-9055.tsx` (the 180 vias as
  `<via netIsAssignable />` plus the 4 holes, as a `<Viagrid9055Blank />` component), fixes the board at
  90 x 55 mm / 2 layers with the blank's 0.2 mm track and clearance rules, and replaces an untouched starter
  `circuit.tsx` with a Viagrid starter. `template: "none"` clears it. The grid geometry is exported
  (`VIAGRID_9055_VIAS`, `VIAGRID_9055_HOLES`, `isOnViagrid9055Via`).
- **Router** (`packages/router/src/adapters/capacity.ts`): `chooseCapacityPreset` picks
  `AutoroutingPipelineSolver8` (tscircuit's "laser prefab" solver) whenever the SRJ carries `netIsAssignable`
  obstacles, or when `settings.preset === "laser-prefab"`; `settings.preset === "default"` forces the old
  pipeline. The result reports `preset`, `stats.viasOnFixed` and a `detail` line such as
  `laser-prefab solver: 6/6 via(s) on the 180 fixed via position(s)`; the default preset reports assignable vias
  it ignored. `SrjObstacle.netIsAssignable` is now part of the protocol so it survives the worker boundary.
  `route_run` adds `preset: "laser-prefab"` automatically when the manifest has a template.
- **Merge** (`packages/tscircuit/src/merge-traces.ts`): a router via within 0.05 mm of an unclaimed assignable
  via *claims* it (`net_assigned`, `pcb_trace_id`, `source_trace_id`, `source_net_id`, connectivity key) instead of
  adding a second `pcb_via`; the trace's via point snaps to the factory via and takes its 1.0 / 0.2 mm sizes.
  `unrouteCircuit` and re-routing release claimed vias instead of deleting them (before, a re-route would have
  removed factory vias from the design).
- **Verification** (`packages/tools/src/tools/verify.ts`): `verify_viagrid` checks `circuit.routed.json`:
  every via is a factory via, none were added (a new via stacked on a factory position is reported as "merged
  without claiming"), and pads/plated holes stay 2.75 mm from the mounting holes. Writes `reports/viagrid.json`.
- **Agent docs** (`packages/agents/src/agents-md.ts`, `apps/core/src/serve.ts`): with a template set, the
  generated `AGENTS.md` carries a "Viagrid 9055 blank" section: render the blank, never add `<via>`, the grid
  geometry and free areas, 0.2 mm rules, run `verify_viagrid`.
- **Environment** (`packages/kicad/src/cli.ts`, `apps/core/src/doctor.ts`): KiCad is also probed under
  `%LOCALAPPDATA%\Programs\KiCad\<v>\bin` (where winget and the "current user" installer put it); the doctor
  warns when an agent resolves to an npm `.cmd` shim, which the core cannot spawn.
- Tests: `packages/tscircuit/test/viagrid-merge.test.ts`, `packages/router/src/viagrid-preset.test.ts`,
  `packages/tools/test/viagrid.test.ts`, `packages/agents/src/agents-md-viagrid.test.ts`. Typecheck is clean.
  Six `agents` tests, one `kicad` import test and the tools "path jail" symlink test fail on this Windows machine
  exactly the same on unmodified `main` (verified in a throwaway worktree); none are related.

## Second pass: app holes fixed the same day

- **Failed runs now speak up** (`apps/core/src/agent-runs.ts`): a run that cannot start, an `error` event from
  the CLI, or a non-zero exit with no reply writes a `⚠ …` line into the assistant message (persisted, so it
  survives reload). Verified live: a bogus binary path yields "⚠ failed to start C:/nonexistent/claude.exe:
  ENOENT …" in the chat instead of an empty turn.
- **npm `.cmd` shims work** (`packages/agents/src/detect.ts` `resolveWindowsShim`): the shim is read and the
  executable it forwards to (`node_modules/@anthropic-ai/claude-code/bin/claude.exe`) is what gets detected and
  spawned; every adapter now spawns the resolved path rather than the bare command name. Verified live: with no
  binary path configured, `/agents` reports the npm package's `claude.exe`.
- **Stale runs are closed on startup** (`apps/core/src/db.ts` `RunRepo.failStale`, called from `serve.ts`
  next to the jobs cleanup): runs left `running` by a previous daemon become `failed` with exit code −1.
- **Settings dialog re-reads on open** (`packages/ui/src/settings/SettingsDialog.tsx`): the settings query is
  refetched every time the dialog opens, so the draft starts from what the core has.
- **`verify_drc` result is bounded** (`packages/tools/src/tools/core.ts`): the JSON now carries counts by rule,
  the first `limit` items of each list, a `truncated` flag and the report path; 130 kB became 22 kB on the
  same board.
- **Board rules reach KiCad** (`packages/kicad/src/convert.ts` `applyRulesToKicadPro`,
  `packages/tools/src/tools/kicad.ts`): `board.rules` are written into the generated `.kicad_pro` (design
  rules and every netclass), so DRC checks the Viagrid blank's 0.2 mm track/clearance instead of 0.1 mm.
- **Automation bridge** (`apps/desktop/src/main/automation-server.ts`): `POST /ui` actions get 30 s (a send
  legitimately waits up to 20 s for the core), and a timeout says the action may still have completed.
- **Agent guidance** (`packages/agents/src/agents-md.ts`): the generated AGENTS.md tells the agent that shell
  tools may be blocked and cannot be approved mid-run, and that `circuit.json`/`reports/` are stale outputs, not
  inputs.
- **Wires across unused factory vias** (`merge-traces.ts`, `verify.ts`): a wire that runs over an unclaimed
  factory via now claims it for that net (the via is copper on both layers, so the connection is real), and
  `verify_viagrid` reports `via_shorts_nets` when two nets touch the same factory via. On the hard layout the
  router's 6 vias plus 5 pass-overs give 11 claimed vias and no shorts; KiCad still lists those 5 as
  `via_dangling` warnings (connected on one layer only), which is expected on a blank.

## Third pass

- **`export_dxf`** (`packages/kicad/src/exports.ts`, `packages/tools/src/tools/export.ts`): one DXF per layer
  (mm) into `exports/dxf/`, default F.Cu, B.Cu and Edge.Cuts. This is the copper-removal artwork a Viagrid
  board is finished with (LightBurn for a laser, or CNC). kicad-cli cannot mirror, so the tool says to flip the
  bottom layer in the laser software; on a Viagrid project it also points at the corner alignment marks.
- **Library warnings silenced at the source** (`packages/kicad/src/convert.ts` `silenceLibraryWarnings`): the
  generated `.kicad_pro` sets `lib_footprint_issues` and `lib_footprint_mismatch` to `ignore` under
  `rule_severities`, since every footprint on a generated board is embedded and has no library. That removes
  ~190 warnings per DRC run and leaves the real ones visible.
- **Running badge shows elapsed time** (`packages/ui/src/chat/ThreadView.tsx`): "running · 1m 05s", ticking,
  so a long run no longer looks frozen.

## How to use it

Chat: "Build a … on a Viagrid 9055 blank" and tell the agent to call `project_set_board` with
`template: "viagrid-9055"` first (the generated AGENTS.md then carries the rules). By hand:

```
project_set_board { template: "viagrid-9055" }   # writes viagrid-9055.tsx, sets 90x55 / 2 layers / rules
# edit circuit.tsx: keep <Viagrid9055Blank /> in <board>, place parts in the via-free areas
circuit_build → route_run → verify_viagrid → kicad_convert → verify_drc → render_board
```

## Bugs found in the app while doing this (not Viagrid-specific)

Status after the second pass: 1, 3, 4, 5 and 11 fixed; 2 mitigated (guidance in AGENTS.md; the default mode is
unchanged); 6, 7, 8, 9, 10 open.

1. **Runs die silently when the agent cannot start.** With the npm-installed `claude.cmd`, every run ended in
   11 ms with exit code −1 and the chat showed nothing, not even an error bubble; "Not logged in" was swallowed
   the same way. `packages/agents/src/process.ts` yields an `error` event, `apps/core/src/agent-runs.ts` emits it
   on the bus, but it is never persisted into the message, so a reload shows an empty assistant turn. Fix: store
   the error as a message part and show it. (The doctor now at least warns about the `.cmd` shim.)
2. **Permission loop with the default `acceptEdits` mode.** Claude Code runs headless with `--allowedTools`
   limited to the MCP tools plus Read/Edit/Write/Glob/Grep; every Bash/PowerShell call asks for approval that
   nobody can give, the agent retries with scripts, and burns minutes. Either surface the approval in the chat,
   default to `bypass`, or tell the agent in AGENTS.md that shell is unavailable.
3. **Settings dialog shows stale values.** After `PATCH /settings` from outside, the dialog kept showing the old
   binary path and permission mode (even after close/reopen) and Save would have written them back. The draft
   is seeded once and never refreshed from the query.
4. **Core restart strands runs as "running".** The dev core restarts on source changes and loses the agent
   subprocess, but the run record stays `running` with no end time and the thread header keeps its "running"
   badge.
5. **Automation bridge `/ui` actions time out while the page is idle.** `app_select_project`, `app_open_tab`,
   `app_new_chat` and `app_send_message` returned "eval timed out after 10000 ms" while `app_eval("1+1")`,
   `app_find` and screenshots worked, and the send had in fact happened, so a retry produced two concurrent runs
   on the same project. The store actions behind `/ui` need a timeout-safe path and the bridge should not report
   failure for an action that completed.
6. **Chat hides progress.** A long run shows one sentence and a collapsed "N tool calls, M errors" line; there
   is no elapsed time, no "waiting for the model", and errors are only visible after expanding.
7. **Stale artefacts mislead the agent.** With old `circuit.routed.json` / `reports/drc.json` in the project the
   agent spent minutes reading them instead of building; nothing tells it what is current.
8. **Import of the Viagrid blank**: strict import fails ("10 copper pours could not be linked to a net"), lenient
   import gives the 100 x 65 manufacturing panel, and import cannot be combined with a design.
9. **Generated KiCad noise**: ~190 `lib_footprint_issues` warnings (footprint library `tscircuit` not
   configured), `text_height` warnings, ERC `pin_not_connected` on the 555 and off-grid wire endpoints. These
   bury real findings and will trip `verify_gate`.
10. `circuit_query traces` shows same-net traces as `routed: false` after a complete route; `circuit_checks`
    before routing reports every trace as unconnected.
11. **`verify_drc` output is too large for the agent.** With 208 warnings the JSON result was 130 k characters
    and Claude Code refused it ("exceeds maximum allowed tokens"); the text says "showing 30" but the JSON still
    carries every violation. Cap the JSON, or return counts plus the report path.

## Still open for a fully finished Viagrid workflow

- **Router spacing.** The laser-prefab solver (like the default one) places parallel tracks 0.03–0.09 mm apart;
  with the blank's 0.2 mm rules now in the `.kicad_pro`, KiCad DRC reports 77 clearance errors on the hard
  layout (0 on the agent's simpler layout). `AutoroutingPipelineSolver8`'s options (`capacityDepth`,
  `targetMinCapacity`, `effort`, node sizes) expose no clearance; the fix has to go into the solver's
  high-density stage upstream, or a post-route DRC-repair pass.
- **Unused factory vias under tracks.** Wires that cross an unused via now claim it, and two nets on one via
  are flagged; better still would be to keep other nets' tracks off unused vias in the first place (obstacles
  with clearance for vias the net does not own).
- **Copper pours.** The guide recommends GND pours on both sides; the capacity adapter drops polygon obstacles.
- **Copper-removal artwork.** Viagrid is finished with a laser (DXF into LightBurn), etch masks or CNC; Fabdesk
  exports gerbers only. `kicad-cli pcb export dxf` per layer, mirrored bottom, registered to the blank's corner
  marks, is the missing export.
- **Placement help in the UI.** The PCB view should draw the grid and holes from the template.
- **Permission mode default.** `acceptEdits` still blocks shell commands with no way to approve them from the
  chat; AGENTS.md now warns the agent, but the app should either surface the prompt or default to `bypass`
  for its own headless runs.

## The 9055 blank, as measured

Source: `VIAGRID BLANK FILES/9055 STANDARD/KICAD/MANUFACTURING/viagrid.kicad_pcb` (KiCad 9, 500 KB). The
`KICAD/` folder otherwise holds only `PLACEHOLDER.TXT`; the design template is under
`LEGACY_FILES/PCB/template/viagrid_template.kicad_pcb`. Coordinates below are board-relative mm, +y up
(KiCad origin of the board is (148.75, 88.75)).

- Board 90 x 55 x 1.6 mm, 2 copper layers; manufacturing panel 100 x 65 with branding rails, corner slots and
  exposed-FR4 laser alignment marks.
- 180 grid vias, 1.0 mm pad / 0.2 mm drill, all on `GND` in the blank (ground pour both sides):
  - top and bottom rows at y = +/-20.5: x = -35 .. +35 step 2 (36 each);
  - left and right columns at x = +/-38: y = -14 .. +14 step 2 (15 each);
  - two clusters centred on x = +/-19 (39 each): rows y = +/-12 (x = 15..23 step 2), y = +/-10 (x = 13..25),
    y = +/-8 (x = 15..23), and a 5-via diamond at (19, +/-2) and (17|19|21, 0), mirrored.
- 4 mounting holes, 3.5 mm drill / 4.5 mm pad, at (+/-38.75, +/-18.25).
- 224 0.6 mm alignment/branding dots on the rails (outside the 90 x 55 board).
- `viagrid.kicad_pro` rules: track 0.2, clearance 0.2, min via 0.5, min copper-to-edge 0.5.

## Evidence from the investigation (before the fix)

| Run | Solver | New vias | On grid | Routed |
| --- | --- | --- | --- | --- |
| no template | pipeline 7 (Fabdesk default) | 17 | n/a | 15/15 |
| template, plain vias | pipeline 7 | 16 | 0 | 15/15 |
| template, `netIsAssignable` | pipeline 7 | 16 | 0 | 15/15 |
| 1-layer board (via-less baseline) | pipeline 7 | 0 | n/a | 15/15 |
| template | `AssignableAutoroutingPipeline2` | 0 | n/a | 7/7 nets |
| template | `AutoroutingPipelineSolver8` (laser prefab) | 6 | 6 | 7/7 nets |

Repro scripts: `scripts/experiments/viagrid/` (grid extraction, solver comparison, merge experiment, the mini
board source). Projects on this machine: `~/Fabdesk/viagrid-9055-mini` (via-needing layout),
`~/Fabdesk/viagrid-9055-agent` (agent-written layout), `viagrid-9055-blank` (import test).

## Tickets

Everything above is filed on the repo: #38-#55. Fixed: #38 #39 #40 (mitigated) #41 #42 #43 #44 #45 #46 #47 #48 #49 #50 #51 #52. Open: #53 router track spacing, #54 tracks over unowned vias, #55 first-run setup.
