# Native-first agent interface prototype

Local prototype branch: `local/native-first-agent-interface`, based on Candidate 2 iteration 8
(`b4f7c3b`). This branch is intentionally not published or packaged as an AppImage.

## What changed

- Codex receives 17 MCP functions at turn start: 15 common native-KiCad operations plus
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
- Agent shell scripts can search, describe, call, and batch any registry operation with
  `fabpcb tool`. This supplies programmable loops and JSONL batching without legacy Python
  `pcbnew` or a different KiCad build.

The remaining custom JSON path is compatibility-only: `circuit_build` consumes it and
`circuit_read_errors` reads its build report. Neither appears in the native profile. Native
`export_netlist` creates a netlist only when requested near the end of a project.

## Morning test

From this worktree:

```bash
cd /home/shane/fabdesk-agent-freedom-visual-geometry
bun install --frozen-lockfile
bun run typecheck
bun test packages/tools/test/registry.test.ts packages/tools/test/mcp.test.ts apps/core/src/tool-cli.test.ts apps/core/test/http.test.ts
bun run dev
```

In the app, create a fresh project and give Codex a normal PCB request. Confirm that the project
starts without `circuit.netlist.json`, the agent can create native files, and the run uses
`pcb_inspect`/`render_view` for local inspection. Existing projects with a custom netlist remain
readable through the compatibility catalog.

Build and install the local CLI symlinks once before testing script-driven agent behavior:

```bash
bun run build:core
apps/core/dist/linux-x64/fabdesk-core install-cli
```

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

## Known prototype boundaries

- Schematic rendering is whole-sheet; region crop/highlight currently applies to PCB views.
- The script interface is JSON/JSONL. A thin Python wrapper can be added after this shape is
  measured; rebuilding KiCad for deprecated SWIG bindings is not part of this prototype.
- The legacy compiler remains available only for compatibility and controlled comparisons.
- No qualification package or official evaluation run has been produced from this branch.

The interface follows the official OpenAI guidance for GPT-5.6: use lean prompts, expose only
task-relevant tools, keep descriptions concise, and validate changes on representative tasks.
See <https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.6>.
