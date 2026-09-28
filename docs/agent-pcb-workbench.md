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

## Minimal agent contract

Fabdesk tells the agent only what is specific to the environment: the canonical filenames used by
the UI, bundled executable paths, project directories, available MCP tools, and whether an operation
addresses live KiCad state or persisted files. It does not prescribe a source format, workflow,
router strategy, retry budget, or stopping policy. The agent may create project-local scripts and
intermediate artifacts and choose its own route through the available capabilities.

Individual tools still enforce their own invariants. For example, `circuit_build` is fail-closed and
retains a rejected authoritative schematic under `.fp-pcb/rejected/`, but using that compiler is an
agent choice rather than a project requirement.

## Python and IPC

Python is not a second name for the KiCad IPC layer. A script may invoke `$KICAD_CLI` or directly
analyze or generate project files, reports, Gerbers, drill files, BOMs, images, or other artifacts.
A script may also connect to the KiCad API server or call MCP when that is useful; those paths see
the same live document state as the corresponding service.

The repository's current Python files under `scripts/vm/` automate VM keyboard, display, and
receiver behavior; they do not connect to the FabPCB or KiCad IPC transports.

## UI-visible evidence

Fabdesk displays canonical project files plus artifacts under `renders/`, `reports/`, and `exports/`.
The MCP verification, rendering, and export tools write the formats the UI already understands.
Agents using another method can still place compatible outputs in those locations.
