# Saved board representation

`board_representation` is a separate, opt-in factual tool in the board toolset. It does not judge task completion, choose an action, or gate a save. No default agent context uses it.

- `action: current` captures the selected saved PCB, reports native item counts, component/net indices, saved-fill DRC and scope, and retains full revision evidence under `.fabdesk/representation/`.
- `action: inspect` refreshes actual files first, then reads the requested revision, explicitly labelled historical. Filter by `component` (reference or UUID), `net`, or `region` (x1,y1,x2,y2 in mm). Native protobuf fields and bounds use nanometres.
- `detail: receipt` retrieves the occurrence inventory and exact raw saved-fill receipt. A finding handle is scoped to its revision. `detail: source` explicitly retrieves captured source bytes as base64.

`pcb` selects a project-relative native board. The default follows `fabdesk.json`'s imported board path, otherwise `board.kicad_pcb`. Companions and library tables resolve from the selected board's directory. Project-local library files are copied and hashed. External, absent or unsupported library context is listed in every packet; the disposable measurement omits unsupported tables and does not claim full original library coverage. Original tables and measurement table hashes are retained. Source, checker and action statuses are separate. Failed checks have no zero-clean counts. Original board bytes are never refilled or saved.

Runtime: existing configured/bundled KiCad fork, through its native API and CLI, with isolated writable profiles including discovery. No Python installation is required. Linux native execution is covered by development controls; macOS remains unproven and Windows currently returns an explicit unsupported capture failure. Stock KiCad without `api-server` cannot capture these facts. The runtime executable/launcher and available provenance are hashed; external dynamic libraries/fonts/stock data are not fully frozen.

Scope: full returned native item JSON and original captured sources remain evidence; comparisons omit regenerated document-parent and nested decoration identities. Native observation differences are not causal proof of physical changes. Terminal connectivity partitions, schematic truth, effective rule resolution and hardware behavior are not measured. Saved DRC unconnected findings are a separate observation. Per-board locking protects publication, not external editor transactions. An interrupted process can leave a lock requiring explicit local recovery; the tool never steals it. History has no retention limit yet.

Optional development controls from the repository root:

```sh
FABDESK_REPRESENTATION_FIXTURES=/path/to/read-only/fixtures \
FABDESK_REPRESENTATION_KICAD=/path/to/packaged/kicad-cli \
FABDESK_REPRESENTATION_ORACLE=/path/to/python-with-pcbnew \
bun scripts/with-test-tmp.ts bun test packages/board-representation/src/index.test.ts
```

USB and HDMI fixtures are exposed development evidence, not held-out designs. Independent review and recorded packaged desktop proof are still required.
