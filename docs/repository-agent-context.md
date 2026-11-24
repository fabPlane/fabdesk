# Repository instructions and Fabdesk runtime context

Agent startup preserves existing `AGENTS.md` and `CLAUDE.md` files byte-for-byte, including legacy
Fabdesk-generated files and text outside their old user-section markers. Startup does not create
these files when absent. Existing project policies remain repository-owned.

Fabdesk writes its current capabilities and workspace defaults to `.fabdesk/agent-context.md`
and passes the same text to every adapter through its session prompt. This also works for a new
project without repository instructions. Draft discussion keeps its existing planning restrictions
and does not prepare engineering context.

The context file is replaced atomically and belongs with local Fabdesk state, not engineering
policy. Root `board.kicad_*` paths describe the current tools' defaults. They do not establish
which nested native project is current, and manifest defaults do not override the selected
project's real settings. File selection is descriptive context rather than permission to edit.

This change prevents future instruction replacement. It does not recover instructions already
lost in earlier versions, remove legacy generated guidance, authenticate private imports or
migrate native dependencies or convert native file formats. Existing repositories still need
explicit source identification before design editing. No automatic project understanding or
native dependency migration is implied.


## Existing repositories and automatic native views

GitHub import opens the repository for chat without adopting even a lone discovered PCB. The
agent follows the original repository instructions and current handoffs to establish which native
design matters. `project_set_board {sourcePath}` stores that conversation context outside the
repository, in Fabdesk's local home. A source-only declaration does not update `fabdesk.json`,
change engineering files or perform UI automation.

The existing PCB, schematic and 3D tabs render the declared native design using the existing
SVG and GLB viewers. They poll saved native inputs every two seconds while mounted and refresh
on a new revision. All three share one revision including native project/rules, matching PCB,
root schematic and reachable sheets. Unavailable or invalid sources stay errors rather than
falling back to another board. Renders use private snapshots, retaining original names and
hierarchy; there is no new root working copy. Preview artifacts are prepared in the background
after saved inputs settle, ready for opening; an already open view updates immediately.

A source declaration never opens, closes or switches panels. Content updates are automatic;
navigation stays with the user. The agent reveals an existing view only when the current request
asks to see something, including natural phrasing such as "show me the current board". Reviewing
or working on a design alone does not imply a request to change the view. Chat ownership is
independent of the generated artifact cache. Actual loaded bytes are verified before a panel observation
reports ready. That observation expires after five seconds without a fresh source check.

The selected native source feeds main's existing board renderers and Placement, Routing and Checks
views. Supported board tools and manufacturing exports resolve transport aliases such as
`board.kicad_pcb` to the original native basename in memory. Generated outputs and board comments
are isolated per basename under `.fabdesk/native/`; canvas pins and agent comment tools use the
same store. Files browsing and repository notes retain repository scope. Explicit existing
assembly source operations retain their own scope.

Pending or failed source lookup blocks board-dependent operations and shows a retryable status.
Automatic preview failures retain any prior preview with an explicit older-preview warning and
retry at the same source revision. Source paths remain visible beside export/check actions.
Native editing and routing still require a runtime supporting both the source format and required
APIs. VAIO format 20261025 currently opens with the installed nightly, which lacks GetRatsnest;
the older bundled fork supports that API but rejects this format. VAIO routing remains unqualified.
No header conversion, silent engine replacement or fabricated compatibility is performed.

`app_present` remains an optional capability for supporting files in the existing Files panel.
Routine board work declares semantic source context once; it does not need app_state/app_present
loops. Generated artifacts alone are never proof of source validity or fabrication readiness.


The native-source adapter feeds main's original `SvgTab` and `ThreeDTab` components. PCB and
schematic retain `SvgViewer`/`SvgCanvas`; 3D retains `ModelCanvas` and its GLTFLoader. Source-specific
bindings verify preview receipts. Export profiles match normal board views, including native PCB
millimetres and the board GLB profile. 3D warnings and external assets are not engineering checks.
