# Native-first agent interface prototype

Local prototype branch: `local/native-first-agent-interface`, based on Candidate 2 iteration 8
(`b4f7c3b`). The completed local implementation is commit `a86fdb3`. This branch is intentionally not
published or packaged as an AppImage.

## What changed

- Codex receives 19 MCP functions at turn start: 17 common native-KiCad operations plus
  `capability_search` and `capability_call`. The complete 65-operation registry remains available
  on demand. The explicit schema payload falls from about 64 KB for the full registry to 24 KB.
- MCP server guidance is one factual sentence. Generated project guidance no longer describes a
  workflow or the custom JSON netlist.
- New projects do not create `circuit.netlist.json`. The first native schematic edit creates the
  KiCad project/schematic/PCB triplet. BOM, SPICE, and netlist exports derive from the saved
  schematic.
- `pcb_inspect` supports bounded queries by kind, reference, net, layer, rectangle, or
  point/radius, returning millimetre coordinates and a PCB revision hash.
- `render_view` renders revision-bound inline PNGs, with layer selection, an exact
  board-coordinate crop, and reference/net highlights.
- `pcb_edit_copper` and `pcb_edit_graphics` expose smaller revision-guarded atomic edit schemas;
  the broad transaction tool remains in the searchable compatibility catalog.
- Copper endpoints can name `{reference, pad}` and are resolved against exact saved-board pad
  coordinates; inspected coordinates retain nanometre-derived precision.
- Native edit results report only changed IDs/counts and revisions, rather than returning a full
  board snapshot. Preview explicitly means structural validation only.
- Native placement moves and rotates the existing embedded footprint geometry without requiring
  its source library. Save any open PCB and schematic first; unsaved or unknown modified state
  rejects placement before the commit, since recovery can restart the shared KiCad session.
  Flips use KiCad's native transform (including its angle change). Failed operations restore saved files
  and discard the edited session before a later operation can reuse it.
- `schematic_review` is initially visible, connection batches create safe labelled pin stubs, and
  legacy netlist compiler operations are excluded from native capability search.
- Native symbol creation preserves library identity, power symbols need no fake footprint, and
  connection preflight rejects crossing or ambiguous labelled stubs before committing.
- Release enforces design-rule floors, ERC, parity-enabled DRC, revision binding, and required
  outputs. PCB placement can also lay out reference fields without refreshing the footprint library.
- Agent shell scripts can search, describe, call, and batch any registry operation with
  `fabpcb tool`. This supplies programmable loops and JSONL batching without legacy Python
  `pcbnew` or a different KiCad build.
- Native connections and inspection resolve local library pins through the current symbol position,
  rotation, and mirroring, including updates in the same call. Derived symbols are placed from
  resolved library definitions. Save/reopen regressions compare exact net endpoints and ERC for
  combined transforms, multi-unit symbols, and inherited pins. Power-symbol serialization remains
  normalized.
- USB-C library search accepts the `power-only-usb-c` role and ranks explicit power/charging-only
  parts ahead of generic data connectors. USB-C symbol/footprint pairs receive compatibility
  validation when they are added.
- Native PCB geometry accepts names such as `F.Cu`, `B.Cu`, `F.SilkS`, and `Edge.Cuts`, while
  retaining numeric layer compatibility.
- Blank-project PCB inspection returns a successful empty result. Schematic review detects note
  collisions and low sheet utilization; release fails when most PCB references are hidden.

The remaining custom JSON path is compatibility-only: `circuit_build` consumes it and
`circuit_read_errors` reads its build report. Neither appears in the native profile. Native
`export_netlist` creates a netlist only when requested near the end of a project.

## Saved hierarchy truth contract (H5)

Fabdesk now builds one native saved-hierarchy inventory from `board.kicad_sch`, KiCad 10
`top_level_sheets`, and recursively referenced `Sheetfile` properties. Packaged KiCad's XML
netlist export supplies complete component/net facts; live IPC counts are authoring details only.
The aggregate schematic revision hashes every referenced sheet instance and file revision, so ERC,
parity, release, project status, and native edit guards become stale when any child changes.
Missing/unreadable references fail complete-project applicability, while unreferenced schematic
files are listed as orphans and excluded from electrical totals.

This is a versioned compatibility change:

- `fabdesk.schematic-inspection` is `3.0.0`. Its default changed from a root-sheet authoring dump to
  a compact complete-hierarchy summary. `detail=authoring|full` plus optional `sheet` expands one
  bounded live sheet with exact IDs and coordinates.
- `fabdesk.schematic-review` is `3.0.0`; findings explicitly cover one selected/current sheet and
  are bound to the aggregate saved revision.
- `fabdesk.native-inspection` and `fabdesk.native-release` are `2.0.0`; their schematic `sha256`
  identity is now the aggregate hierarchy revision, with the root-file hash retained separately.
- Consumers that assumed default `schematic_inspect.symbols`, root-file revision identity, or the
  old contract versions must request authoring detail or read the new `hierarchy`/`authoring`
  members. Single-sheet aggregate identity intentionally differs from the former raw-file hash.

## Morning test

The prepared test launcher uses an isolated state database and project root:

- State: `/home/shane/fabdesk-native-agent-test/state`
- Projects: `/home/shane/fabdesk-native-agent-test/projects`
- Source: `/home/shane/fabdesk-agent-freedom-visual-geometry`

It deliberately does not use `/home/shane/fabdesk`, which is a source checkout even though it is
also the application's historical default project path.

Build and install the prototype once:

```bash
cd /home/shane/fabdesk-agent-freedom-visual-geometry
bun install --frozen-lockfile
bun run typecheck
bun test packages/tools/test/registry.test.ts packages/tools/test/mcp.test.ts apps/core/src/tool-cli.test.ts apps/core/test/http.test.ts
bun run build:core
apps/core/dist/linux-x64/fabdesk-core install-cli
```

Then launch the bundled KiCad/FabPCB runtime with the prototype source:

```bash
/home/shane/fabdesk-evals/bin/run-native-agent-test
```

In the app, create a fresh project such as `Native Agent Test 3` and give Codex a normal PCB request.
Do not reuse an evaluation project. Confirm that the project
starts without `circuit.netlist.json`, the agent can create native files, and the run uses
`pcb_inspect`/`render_view` for local inspection. Existing projects with a custom netlist remain
readable through the compatibility catalog.

Inside a running agent session, the app then provides the required URL, token, and project
environment variables. The agent (or a shell script it writes) can use:

```bash
fabpcb tool search "inspect board region"
fabpcb tool describe pcb_inspect
fabpcb tool call pcb_inspect --request '{"kinds":["components","tracks"],"region":{"minX":0,"minY":0,"maxX":20,"maxY":20}}'
fabpcb tool batch --input @calls.jsonl
```

`calls.jsonl` contains one `{"name":"...","arguments":{...}}` object per line. The dispatcher is
conservatively marked as potentially destructive/open-world because it can call operations with
different side effects.

The exact packaged KiCad environment is also available without going through a PCB construction
tool:

```bash
fabpcb env describe --project /absolute/path/to/project
fabpcb env exec --project /absolute/path/to/project -- kicad-cli --version
fabpcb env exec --project /absolute/path/to/project -- kicad-cli pcb drc board.kicad_pcb
```

`describe` returns machine-readable executable, version, library, stock-data, runtime, and project
provenance while excluding credentials. `exec` sets the project working directory, prepends the
packaged KiCad binary directory to `PATH`, and resolves the literal `kicad-cli` command to the exact
`KICAD_CLI` executable used by Fabdesk. It exposes an environment capability without prescribing an
authoring workflow.

Project revisions are content-addressed independently of the authoring method:

```bash
fabpcb revision checkpoint --project /absolute/path/to/project --label "before reroute"
fabpcb revision accept --project /absolute/path/to/project
fabpcb revision status --project /absolute/path/to/project
fabpcb revision discard --project /absolute/path/to/project
```

`checkpoint` never changes the accepted pointer. `accept` first proves that each present native
schematic or PCB reopens with the packaged KiCad version, but deliberately does not require ERC or
DRC success for an intermediate revision. The accepted pointer advances atomically only after that
validation and snapshot complete. `discard` restores the accepted source snapshot; candidate-only
files are moved to a recovery directory rather than deleted. Generated reports, renders, exports,
KiCad user-state files, locks, backups, Git metadata, and dependencies are excluded from source
snapshots.

Verification, rendering, and release are callable from the shell without selecting an MCP tool:

```bash
fabpcb verify --project /absolute/path/to/project
fabpcb render --project /absolute/path/to/project --document schematic
fabpcb render --project /absolute/path/to/project --document pcb --request @render.json
fabpcb release --project /absolute/path/to/project --request @release.json
```

These commands invoke the same local Fabdesk kernels used by the application. They require a live
local core (`FABDESK_CORE_URL` and `FABDESK_TOKEN`) and a clean accepted source revision. Each
command checks the accepted revision again after completion and fails stale if source files changed;
generated reports, renders, and exports do not alter the source revision. `verify` runs each
applicable ERC, DRC/parity, and gate check. Release inputs remain explicit JSON rather than hidden
workflow defaults.

For the next clean test, restart the launcher and use a new project; the three completed 2026-09-15
blinkers are retained as diagnostic evidence and should not be overwritten. The packaged KiCad
10.99 integration test already passes for rotated symbols, power symbols, clean ERC, native PCB
update/parity, outline creation, and placement. The next manual run should measure behavior and
visual quality rather than rediscovering those serialization defects.

## Known prototype boundaries

- Schematic rendering is whole-sheet; region crop/highlight currently applies to PCB views.
- The script interface is JSON/JSONL. A thin Python wrapper can be added after this shape is
  measured; rebuilding KiCad for deprecated SWIG bindings is not part of this prototype.
- The legacy compiler remains available only for compatibility and controlled comparisons.
- No qualification package or official evaluation run has been produced from this branch.

The interface follows the official OpenAI guidance for GPT-5.6: use lean prompts, expose only
task-relevant tools, keep descriptions concise, and validate changes on representative tasks.
See <https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.6>.

## MCP effect annotations

Each registry definition explicitly declares `readOnlyHint`, `destructiveHint`, and `openWorldHint`;
`idempotentHint` records whether repeating a call adds effects. The MCP adapter publishes these
same values for direct tools and capability-search results. Metadata describes the broadest
supported mode, including optional writes and previews.

Saving reports, exports, screenshots, or render artifacts is a state change even when native
KiCad files stay unchanged. Overwriting an artifact is a potentially destructive write. Starting
another durable route job is not idempotent. A bounded project, library catalog, or signed-in
team workspace is closed-world even when its service is remote. Arbitrary renderer JavaScript
and general UI actions can reach beyond that boundary.

Annotations are hints, not authorization. Existing supervised-mode classification consumes
read-only and idempotent hints, so correcting those values also changes its classification of
builds, route starts, screenshots, and JavaScript wait predicates. Tool handlers, input schemas,
outputs, tool names, and exposure profiles retain their implementations.

Sources: [OpenAI tool annotation guidance](https://developers.openai.com/plugins/plugin-guidelines),
[Anthropic MCP tool guidance](https://www.anthropic.com/engineering/writing-tools-for-agents),
and the [MCP annotation specification](https://modelcontextprotocol.io/specification/2025-11-25/schema#toolannotations).
