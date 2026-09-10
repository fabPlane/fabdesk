# Agent PCB workbench

Fabdesk runs the agent inside the selected project. It is a workbench around KiCad, not a fixed
PCB wizard: the agent may combine structured MCP tools, the bundled `kicad-cli`, direct file and
report analysis, one-off scripts, and the fabPlane desktop UI.

Call `pcb_environment` to discover the canonical project files, exact KiCad CLI path and version,
FabPCB bridge, and desktop-automation availability. Spawned agents also receive:

```text
FABDESK_PROJECT_DIR
FABDESK_KICAD_PROJECT
FABDESK_KICAD_SCHEMATIC
FABDESK_KICAD_BOARD
KICAD_CLI
FABDESK_FP_PCB_BRIDGE_URL
```

`KICAD_CLI` is an absolute path when Fabdesk can resolve KiCad. Use it instead of assuming that a
system `kicad-cli` is the same build as the FabPCB API server. The packaged desktop passes the
bundled runtime and library environment through its PCB supervisor; a CLI selected in Settings is
resolved again for each agent run.

## Working lanes

- **MCP / FabPCB:** structured operations against live KiCad state, plus convenience workflows
  such as `circuit_build` and `route_run`.
- **Bundled KiCad CLI:** persisted-file ERC, DRC, rendering, conversion, and export. Reloading files
  through a separate CLI process is an important serialization-boundary check.
- **Direct-file scripting:** parsing reports and fabrication files, geometry checks, comparisons,
  deterministic generation, and other independent analysis.
- **fabPlane UI:** visual inspection and interaction through the `app` toolset when automation is
  enabled.

`circuit_build` is useful but not mandatory. An agent may start from an existing native KiCad
project, inspect it with CLI or MCP, edit it through available structured operations, use the UI,
or generate a source design and compile it.

## Python and IPC provenance

Python is not a second name for the KiCad IPC layer. A script may invoke `$KICAD_CLI` or directly
analyze project, report, Gerber, drill, BOM, image, or other artifacts. If it connects to the KiCad
API server, imports a KiCad IPC binding, or calls an MCP tool, it must identify that dependency in
its output and trace. Such a result exercises the live-KiCad lane and must not be described as an
independent validation of that lane.

The repository's current Python files under `scripts/vm/` automate VM keyboard, display, and
receiver behavior; they do not connect to the FabPCB or KiCad IPC transports.

## Hard boundary

Exploration and repair are intentionally flexible. Release claims and manufacturing exports are
not: their ERC, DRC, connectivity, and schematic-parity evidence must be fresh for the canonical
project-file revisions being exported. A render or report from an earlier revision is evidence of
that earlier revision only.
