# Explicit board sources and physical instances

The read-only `GET /projects/:id/board-sources` endpoint inspects `fabplane.assembly.json` in a registered project. `CoreClient.inspectBoardSources(id)` provides the typed client call. This establishes source ownership for the assembly canvas and a limited set of explicit native source tools. It is not a compatibility validator or a complete multi-board editor.

Without a manifest, inspection retains the existing single canonical `board.kicad_pcb` at the project root. With a manifest, only declared sources appear: historical or alternative PCB files are never gathered automatically. An invalid, unsafe or changing manifest fails rather than falling back to an unrelated root board.

A **source** owns one canonical board directory. An **instance** identifies a physical use of that source. Two identical daughterboards share one source and have two instances; they must not become duplicate editable files or double-counted source records. Connections refer to instance IDs and connector references. Canvas positions are presentation coordinates, not KiCad placements or chassis positions.

```json
{
  "contract": "fabplane.assembly.v1",
  "sources": [
    { "id": "carrier", "name": "Carrier", "location": "project", "directory": "boards/carrier" },
    { "id": "io", "name": "I/O", "location": "project", "directory": "boards/io" }
  ],
  "instances": [
    { "id": "carrier-main", "sourceId": "carrier", "name": "Main carrier" },
    { "id": "io-left", "sourceId": "io", "name": "Left I/O", "presentation": { "units": "canvas-px", "x": 100, "y": 200 } },
    { "id": "io-right", "sourceId": "io", "name": "Right I/O", "presentation": { "units": "canvas-px", "x": 500, "y": 200 } }
  ],
  "connections": [
    { "id": "left-cable", "name": "Left I/O cable", "a": { "instanceId": "carrier-main", "connector": "J1" }, "b": { "instanceId": "io-left", "connector": "J2" } }
  ]
}
```

Local sources use `board.kicad_pcb` and optionally `board.kicad_sch` and `renders/pcb.svg` under the declared directory. Existing PCB adoption remains a separate operation; inspection never copies, renames, rewrites, migrates or downloads anything. Relative model paths therefore remain untouched. A source can instead declare `location: "unresolved"` with `provenance: { repository?, ref?, path, sha256? }`; it remains unresolved until a later explicit import workflow. Provenance hashes describe the referenced original, not a promise that the working file still matches it.

Inspection returns source status (`available`, `missing`, `unresolved`, `blocked`), current PCB bytes/SHA-256 when safely readable, and the manifest SHA-256. `available` means a regular project-owned file exists, not that it is a valid KiCad board, up to date with its schematic, electrically correct or mechanically compatible. Optional preview paths are not freshness evidence. Imported PASS labels are not accepted by the manifest schema.

Paths must be portable and project-relative. Inspection rejects symlink aliases (including aliases within the project), hard-linked native files, duplicate underlying files, oversized files and files changing while hashed. Hashing is streamed with bounded concurrency. Manifest inspection is limited to 512 KiB; a PCB is limited to 512 MiB. The response contains no outside file paths or contents.

Single-board inspection retains `editing: "single-board-only"`; declared assemblies report `editing: "explicit-source-tools"` for the limited native operations described below. The overview now displays these declared sources and instances, with source-bound native placement, rectangular resizing and derived SVG preview updates. Before expanding other member workflows, implement and validate captured board ownership in tool/job arguments, native session keys, file paths, review anchors, query invalidation, source revision checks and in-flight manifest-change guards. Never route editing by temporarily swapping the root PCB or mutating the global active project.

Validation covers two declared boards and an ignored historical variant, repeated instances, missing/external sources, invalid/traversal manifests, directory/file symlink aliases, outside aliases, hard links, a dangling manifest, legacy single-board behavior, no writes, typed client routing and authenticated local daemon HTTP responses.

## Agent project context

The existing `project_status` tool now includes the same explicit assembly membership when a declaration is present. It reports source availability, physical instances, links, provenance and current inspected hashes. Native file/build/release/DRC status remains qualified as **project root** data; it does not describe or certify member boards. Only the explicitly scoped placement and rectangular-resize tools support member mutation; other native workflows remain unavailable. An invalid or dangling declaration produces an unavailable membership section while preserving useful root status, rather than silently advertising an ordinary root board. Projects without a declaration retain their existing status shape and behavior. Status does not open KiCad, fetch external repositories or write files.

## Captured native ownership guard

The core now has an internal `resolveNativeBoardBinding` / `withNativeBoardBinding` execution scope. It captures a declared source at an exact manifest SHA, copies caller identities, and pins the canonical project and board-directory identities. Concurrent and nested operations retain their own scopes. Rechecks reject membership changes, replaced directories, wrong native targets and file aliases, including native project/schematic/library companion files. The guard runs at native operation entry and immediately before the existing document revision/save checks and save RPC. It does not replace native saved-source conflict checks.

The read-only `pcb_inspect` transport now activates this scope for declared members. The opted-in `pcb_place`, `pcb_resize_outline` and derived `render_pcb_svg` tools activate the same scope. Other member operations remain unavailable until their query keys, asset paths, comments and operations are explicitly scoped. Ordinary single-board projects retain their legacy behavior. Source-bound native operations are blocked at an assembly root when no supported member scope is established. These checks are optimistic preflight checks, not a cross-process filesystem transaction or a guarantee that an external editor cannot race an RPC.

The installed native KiCad test saves one owned placement, rejects a different board directory, then changes the declaration after a second native placement commit. The guarded save fails while saved PCB bytes and unsaved live placement both remain intact. Seven ownership unit tests also cover caller-object mutation, stale/queued selection, retargeting, aliases, directory replacement and concurrent/nested scopes; a session regression verifies that a failed ownership check makes zero save calls.

## Read-only member inspection over tools

`pcb_inspect` accepts optional `board: { sourceId, manifestSha256 }`. The source ID identifies an editable source definition, not one physical instance. For an assembly this selector is required; ordinary single-board inspection omits it. Only explicitly opted-in tools accept the selector. Arbitrary directories, instance IDs, stale hashes and unsupported member operations are rejected without root fallback.

```ts
const assembly = await client.inspectBoardSources(projectId);
if (assembly.mode !== "assembly" || !assembly.manifestSha256) throw new Error("No assembly declaration");
const inspection = await client.callTool("pcb_inspect", {
  projectId,
  board: { sourceId: "io", manifestSha256: assembly.manifestSha256 },
  kinds: ["components", "board_geometry"],
});
```

Structured results carry `_board: { projectId, sourceId, manifestSha256 }` alongside the saved PCB revision. The core keeps the root project ID for leases/jobs and uses the captured source directory for native sessions. Scoped handles cannot inherit or mutate parent board-default metadata. A host that ignores the selector or fails to establish its execution scope is refused.

Direct MCP, discovered-capability dispatch and HTTP forward the same selector. Deferred jobs pin the original owner and execution guard, reject retargeted projects or replaced directory containers, and retain their own cancellation/progress context. Re-resolving a byte-identical replacement must not legitimize a queued job.

Project-wide status/files and global library operations remain available. Existing project-scoped circuit/route/KiCad/verification/render/export/simulation/CAD operations and concrete-board core operations are disabled at an assembly root until member support is implemented. This is a product ownership boundary, not an operating-system permissions sandbox; explicit project file access remains project-wide.

The running native-app walkthrough inspected two real saved sources, switched 20 mm carrier → 15 mm I/O → 20 mm carrier, and verified the scoped identities, independent native sessions and unchanged PCB/manifest/preview bytes. The carrier had four outline segments; the I/O had one native rectangle. KiCad created its normal session lock files. No root PCB was created, and no-selector/stale/instance selectors plus unsupported edits were rejected. Geometry inspection does not verify connectivity, schematic parity or mechanical compatibility.


## Assembly canvas and explicit preview updates

The canvas overview shows declared physical instances, their real saved PCB previews and declared links. Repeated instances share one source status. Missing or unresolved sources stay visible with an availability message. No preview generation runs merely by opening the project. A newly opened assembly defaults to Overview; an existing saved workspace choice wins. The Boards area provides the same explicit board picker rather than opening an unrelated root PCB.

Selecting an instance reveals its tools. Inspect PCB replaces the canvas with that source’s saved SVG and scoped native part count/outline dimensions; it opens no extra window. Returning preserves the assembly camera. Keyboard selection, zoom, fit and background pan are supported. Ask prepares an unsent project draft. Links expose their two declared endpoint boards and remain compatibility-unverified. Map positions and link ports do not represent physical connector positions or installed geometry.

Source/artifact hashes are checked per owned board directory, including changes that preserve file length and timestamps. Both instances of a shared source warn together; the update badge counts that source once. Create/Update preview explicitly calls `render_pcb_svg` with the captured source ID and manifest SHA. The tool exports an immutable PCB snapshot, checks source bytes and original source ownership before publishing, and checks both preview and receipt paths against output aliases. A changed declaration or redirected output leaves the previous image and receipt intact. These checks are optimistic preconditions, not a filesystem transaction or a guarantee against every cross-process race.

The detail view keeps its camera while a refreshed SVG arrives. Changes to membership disable actions on the old selection until the board is selected again. Source availability, saved-preview freshness, schematic parity and connection/fit validation are distinct: the latter checks remain unverified. Placement of physical instances, member schematic/3D/CAD workflows, checks and scoped comments are still pending.

The running installed-KiCad walkthrough and screenshots are in [canvas progress](ui-progress/canvas-workspace/README.md#declared-multi-board-canvas-and-source-preview-updates).


## Guarded member placement and rectangular resize

`pcb_place` and `pcb_resize_outline` now accept the same explicit `board: { sourceId, manifestSha256 }` selector as inspection. Both require the selected source’s inspected `expectedSourceSha256` for an assembly member. Placement checks this requirement before calling the native service; resize already requires it in its schema. Existing unscoped single-board placement retains its prior argument contract. Missing selectors cannot become a root-board edit, and unsupported tools still reject selectors.

The source selector identifies a source design: editing it affects all its declared physical instances. It does not move an assembly instance in the enclosure. Native positioning preserves routed copper by default and reports affected copper; that report is not clearance/DRC approval. Rectangular resize retains the existing native minimum corner and primitive IDs and never scales footprints or copper. Complex and locked outlines retain the existing rejection behavior. Creating/replacing arbitrary member outlines is not enabled.

Registry, HTTP, direct MCP and capability dispatch share the captured source context; structured outputs echo `_board`. Clients must retain that identity in queries, preview paths and in-flight controls before exposing member editing UI. The canvas enables source-bound placement and rectangle resizing only when source ownership, saved-preview hashes and the native SVG coordinate frame are verified. Agent project status describes the limited explicit source tools rather than claiming every member workflow is available.

An installed native integration test dispatches through the actual tool registry/context factory into KiCad. With two source directories containing the same native item IDs and two instances sharing source A, it rejects missing/stale source hashes before opening a session, moves R1 by 0.1 mm, and resizes A from 15 × 15 to 20 × 15 mm. Tracks/vias/zones/nets remain unchanged; resize also preserves the placed component/pad data. Source B and an unrelated root PCB remain byte-identical. Stale inspected bytes and stale manifest membership are rejected. Native close/reopen confirms the saved footprint position, original outline ID and native minimum corner. A host that ignores the source scope is refused. The separate native ownership test still rejects a changed declaration before save while preserving unsaved live edits. These checks do not establish electrical or mechanical compatibility, undo integration or protection against every external-editor race.


## Source-bound editing controls on the canvas

The member PCB canvas now reuses the native part/outline tools with an explicit source selector. Part and outline query keys include source ID and captured manifest SHA; inspection and mutation confirmations must echo that owner. Inspecting two sources with the same R1 reference cannot share a query or confirmation. Selectors are copied before asynchronous inspection. Older/root or mismatched responses fail closed.

Clicking a verified native PCB location reveals Parts and Board size. Mouse/keyboard targets are proposals until Apply. Native editing requires a matching source/preview receipt, the native millimetre coordinate stamp, current membership and the runtime’s explicit-source-tools capability. Returning to all boards is disabled during native save/refresh. A changed source or declaration disables Apply while keeping unsaved values. Empty member outlines cannot fall through to unsupported root outline creation; complex/locked boundaries retain their actual native rejection reason.

Member tools refresh only their source’s SVG and validate the scoped native result. Ask identifies the source in an unsent draft. Member comments are absent until anchors are scoped; the post-save root-check shortcut is replaced with guidance to check the selected source in KiCad. The popup observes final SVG fit changes so resizing the window does not leave the drag target hidden behind it. Source originals and derived-artifact currentness remain distinct from DRC, routing safety or physical fit.

The physical installed-app walkthrough saved an I/O R1 move and dragged/applied a 15 × 15 → 20 × 15 mm outline, preserving the other source and parent metadata, components/pads/copper during resize, edge identity and origin. Both physical instances reflected the shared source. Cross-source state isolation, stale-membership blocking with retained fields, unsent source-specific Ask and exact 960 × 720 target/popover clearance passed. Every fixture file was restored; a native inspection then confirmed the restored original part position and geometry. No real VAIO PCB was edited. [Screenshots and evidence](ui-progress/canvas-workspace/README.md#source-bound-member-canvas-editing-controls).
