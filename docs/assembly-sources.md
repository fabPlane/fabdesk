# Explicit board sources and physical instances

The read-only `GET /projects/:id/board-sources` endpoint inspects `fabplane.assembly.json` in a registered project. `CoreClient.inspectBoardSources(id)` provides the typed client call. This is an ownership foundation for the canvas roadmap, not multi-board editing or a compatibility validator.

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

`editing: "single-board-only"` explicitly records that this endpoint does not enable native editing of assembly members. The current UI is unchanged. Before promoting assembly editing, implement and validate captured board ownership in tool/job arguments, native session keys, file paths, review anchors, query invalidation, source revision checks and in-flight manifest-change guards. Never route editing by temporarily swapping the root PCB or mutating the global active project.

Validation covers two declared boards and an ignored historical variant, repeated instances, missing/external sources, invalid/traversal manifests, directory/file symlink aliases, outside aliases, hard links, a dangling manifest, legacy single-board behavior, no writes, typed client routing and authenticated local daemon HTTP responses.

## Agent project context

The existing `project_status` tool now includes the same explicit assembly membership when a declaration is present. It reports source availability, physical instances, links, provenance and current inspected hashes. Native file/build/release/DRC status remains qualified as **project root** data; it does not describe or certify member boards. Assembly editing remains explicitly unavailable. An invalid or dangling declaration produces an unavailable membership section while preserving useful root status, rather than silently advertising an ordinary root board. Projects without a declaration retain their existing status shape and behavior. Status does not open KiCad, fetch external repositories or write files.

## Captured native ownership guard

The core now has an internal `resolveNativeBoardBinding` / `withNativeBoardBinding` execution scope. It captures a declared source at an exact manifest SHA, copies caller identities, and pins the canonical project and board-directory identities. Concurrent and nested operations retain their own scopes. Rechecks reject membership changes, replaced directories, wrong native targets and file aliases, including native project/schematic/library companion files. The guard runs at native operation entry and immediately before the existing document revision/save checks and save RPC. It does not replace native saved-source conflict checks.

The read-only `pcb_inspect` transport now activates this scope for declared members. Assembly-member mutations/exports and editing UI remain unavailable until their query keys, asset paths, comments and operations are explicitly scoped. Ordinary single-board projects retain their legacy behavior. Source-bound native operations are blocked at an assembly root when no supported member scope is established. These checks are optimistic preflight checks, not a cross-process filesystem transaction or a guarantee that an external editor cannot race an RPC.

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
