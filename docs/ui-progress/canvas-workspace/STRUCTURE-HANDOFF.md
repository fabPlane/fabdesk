# Shared UI structure — delegation handoff

Follow-up: schematic entry and board request clarity revised after user feedback. See [SCHEMATIC-FLOW.md](SCHEMATIC-FLOW.md). Latest UI checks234pass/917assertions; no native source changes.

Source checkpoint: `b38683d`. **Shared UI structure ready for delegation.** Final UItypecheckPASS;233tests912assertions/0fail. This handoff covers UI structure; feature implementation is separately qualified. Local only.

All13 non-Mechanical registered views reached their rendered shell in the isolated root study; assistant closed and34 protected files exact. Mechanical remains teammate-owned. Existing router failure is recorded honestly.

| Feature | UI home | Implementation state |
|---|---|---|
| Project workspace and navigation | Header project chooser; workspace switcher; corner assistant | Connected |
| Fresh start and editable sketches | Start composer → Draw/open sketch, Upload image, GitHub import | Connected with agent dependency |
| Project and board overview | Overview → Connections; select board/link | Connected |
| Assembled 3D project view | Overview → Connections menu → 3D assembly | Pending integration |
| Native part position and board size | Boards → PCB → select location → Parts / Board size | Connected, bounded |
| Part replacement | Selected native part → More part actions → Replace reference | Pending integration |
| Schematic and side-by-side inspection | Boards → Schematic; Show PCB/schematic alongside | Connected, bounded |
| Individual 3D board models | Boards → 3D; Outputs → Models & video | Connected, bounded |
| Routing and playback | Board → Tools → Routing | Connected, bounded |
| Board artwork | Board → Tools → Artwork; fresh-start art link | Deferred by user |
| Mechanical and enclosure | Workspace → Mechanical | Teammate-owned |
| Parts, BOM and procurement | Workspace → Parts & BOM → Parts / Shopping | Connected, bounded |
| Saved-output library | Outputs → Library | Connected |
| Renders and product video | Outputs → Library / Models & video | Connected, bounded |
| Manufacturing files and stencils | Outputs → Export files; legacy Files exporter retained | Connected, bounded |
| Freshness and source reconciliation | Header Review → Updates → Design sources / Generated outputs / Saved checks | Connected provenance; pending reconciliation |
| Local changes and revisions | Review → Changes | Connected root-board comparison |
| Comments and pinned review | Review → Comments; selected drawing → Pin comment | Connected root board |
| PCB/schematic checks and findings | Review → Checks; contextual board check entries | Connected, bounded |
| Share, KiCad push/pull and general recovery | Review → Changes → Publish & sync | Pending integration |
| Files and project notes | Workspace → Files → Files / Notes | Connected |
| Assistant, voice and project context | Corner Ask fabPlane; central fresh composer; requested conversations | UI connected; provider deferred |
| Settings, routers, inventory and order flow | Workspace options; Parts/Order checks; project menu | Existing functionality preserved |

## Project workspace and navigation

**Home:** Header project chooser; workspace switcher; corner assistant  
**Next owner:** Coworker to assign  
**Feature state:** Connected

**Working/preserved**

- One primary surface, secondary tools closed; official fabPlane logo/name.
- Task restore and adaptive first-open default; project/chat drawer is requested.

**Remaining feature work**

- Keep one navigation system as new features land; preserve project and endpoint ownership.

**Dependencies:** UI store and project/source queries

**UI states:** Fresh/empty, populated, selected task, reconnect/error recovery; compact/wide; keyboard tab recovery

**Entry files:** `packages/ui/src/layout/CanvasWorkspace.tsx`, `packages/client-core/src/workspace-navigation.ts`, `packages/ui/src/stores/ui.ts`

**Evidence:** [fresh-start-clarity-native.json](fresh-start-clarity-native.json), [header-review-native.json](header-review-native.json)

## Fresh start and editable sketches

**Home:** Start composer → Draw/open sketch, Upload image, GitHub import  
**Next owner:** Coworker to assign  
**Feature state:** Connected with agent dependency

**Working/preserved**

- One composer; direct input alternatives and quiet art entry.
- Existing editable sketch saving/import/copy and draft recovery retained.

**Remaining feature work**

- Resume actual sketch-to-board agent validation after provider model compatibility is fixed.

**Dependencies:** Codex model-routing ticket; native generation tools

**UI states:** Empty, drawing/upload selection, import dialog, retained failure recovery; no automatic send

**Entry files:** `packages/ui/src/chat/FreshStartActions.tsx`, `packages/ui/src/sketch/SketchPad.tsx`, `packages/ui/src/sidebar/CreateProjectDialog.tsx`

**Evidence:** [fresh-start-clarity-native.json](fresh-start-clarity-native.json), [editable-sketch-native.json](editable-sketch-native.json)

## Project and board overview

**Home:** Overview → Connections; select board/link  
**Next owner:** Coworker to assign  
**Feature state:** Connected

**Working/preserved**

- Actual declared boards/links; source-qualified warnings; missing-source recovery.
- Device-local card arrangement, zoom/Fit, reload/reset; connection endpoints open owned boards.

**Remaining feature work**

- Complete missing source imports and compatibility evidence as separate feature work.

**Dependencies:** Assembly manifest and actual native source files

**UI states:** Quiet, selected board/link, source checking, stale/unavailable source, retry; compact/wide

**Entry files:** `packages/ui/src/layout/ProjectOverview.tsx`, `packages/ui/src/layout/AssemblyOverview.tsx`, `packages/client-core/src/assembly-map-layout.ts`

**Evidence:** [board-map-layout-native.json](board-map-layout-native.json), [assembly-view-structure-native.json](assembly-view-structure-native.json)

## Assembled 3D project view

**Home:** Overview → Connections menu → 3D assembly  
**Next owner:** Coworker to assign  
**Feature state:** Pending integration

**Working/preserved**

- Requested pending state and working route to individual board models.

**Remaining feature work**

- Connect an assembled scene with owned board transforms and cable contracts; distinguish exploded view from installed positions.

**Dependencies:** Shared transform/coordinate contract; complete models; fit ownership with Mechanical teammate

**UI states:** Closed by default; explicit pending/disabled scene; real missing-model fallback

**Entry files:** `packages/ui/src/layout/AssemblyOverview.tsx`, `packages/ui/src/board/AssemblyBoardModel.tsx`

**Evidence:** [assembly-view-structure-native.json](assembly-view-structure-native.json)

## Native part position and board size

**Home:** Boards → PCB → select location → Parts / Board size  
**Next owner:** Coworker to assign  
**Feature state:** Connected, bounded

**Working/preserved**

- Native reference selection, position/rotation proposals and guarded Apply; limited eligible reverts.
- Board-size proposal/anchor workflow retained; source ownership and freshness guards.

**Remaining feature work**

- Broaden supported outlines only under native safety contracts; do not infer rerouting or schematic reconciliation.

**Dependencies:** Native inspection/edit APIs, source hashes, preview receipts

**UI states:** Requested tools/properties, selected reference, draft proposal, locked/stale/error/busy, limited revert; compact

**Entry files:** `packages/ui/src/board/NativePartTools.tsx`, `packages/ui/src/board/NativeOutlinePanel.tsx`, `packages/ui/src/board/NativePartTarget.tsx`

**Evidence:** [pending-native-actions-structure.json](pending-native-actions-structure.json), [board-switcher-native.json](board-switcher-native.json)

## Part replacement

**Home:** Selected native part → More part actions → Replace reference  
**Next owner:** Coworker to assign  
**Feature state:** Pending integration

**Working/preserved**

- Clear selected-reference home; explicit pending label and disabled action.

**Remaining feature work**

- Implement selection of compatible replacement, native preview and guarded apply preserving references/nets/pads; validate source preservation.

**Dependencies:** Native replacement transaction and compatibility contract; no lossy PCB rewrite

**UI states:** Closed disclosure by default; selected real reference; unfinished action disabled

**Entry files:** `packages/ui/src/board/NativePartTools.tsx`

**Evidence:** [pending-native-actions-structure.json](pending-native-actions-structure.json)

## Schematic and side-by-side inspection

**Home:** Boards → Schematic; Show PCB/schematic alongside  
**Next owner:** Coworker to assign  
**Feature state:** Connected, bounded

**Working/preserved**

- Existing root/member schematic views and missing-file recovery.
- Stable PCB/Schematic/3D task locations; direct member switching retains the task.

**Remaining feature work**

- Complete member schematic hierarchy/library import; connect full comparison separately.

**Dependencies:** Native schematic hierarchy, symbol libraries and source ownership

**UI states:** Saved/missing source, load/export failure/retry, requested comparison; no parity claim

**Entry files:** `packages/ui/src/board/SvgTab.tsx`, `packages/ui/src/board/AssemblySchematicPreview.tsx`, `packages/ui/src/board/BoardComparison.tsx`

**Evidence:** [schematic-source-recovery-native.json](schematic-source-recovery-native.json), [board-switcher-native.json](board-switcher-native.json)

## Individual 3D board models

**Home:** Boards → 3D; Outputs → Models & video  
**Next owner:** Coworker to assign  
**Feature state:** Connected, bounded

**Working/preserved**

- Existing orbit/zoom/Fit viewer, deliberate generation, model download and source status.
- Member source picker; honest missing-model/dependency status.

**Remaining feature work**

- Complete external component-model dependencies and member video/assembly alignment as separate work.

**Dependencies:** Native exporter, model dependencies and revision receipts

**UI states:** Missing/loading/error/current/outdated model; source scope; deliberate generation

**Entry files:** `packages/ui/src/board/AssemblyBoardModel.tsx`, `packages/ui/src/board/ThreeDTab.tsx`, `packages/ui/src/board/ModelCanvas.tsx`

**Evidence:** [assembly-view-structure-native.json](assembly-view-structure-native.json), [output-parts-ownership-native.json](output-parts-ownership-native.json)

## Routing and playback

**Home:** Board → Tools → Routing  
**Next owner:** Coworker to assign  
**Feature state:** Connected, bounded

**Working/preserved**

- Existing run/playback/detail workflow; setup requested, failure remains visible.
- Primary board tabs remain keyboard reachable from the tool.

**Remaining feature work**

- Feature owner should verify router installation and a new real run in their environment; retain actual board-level scope.

**Dependencies:** Installed router/native bridge; recorded run identity

**UI states:** No/recorded run, requested setup/detail, active/error; actual retained fab_router failure observed

**Entry files:** `packages/ui/src/board/cinema/CinemaTab.tsx`, `packages/ui/src/board/BoardPanel.tsx`

**Evidence:** [board-tools-native.json](board-tools-native.json), [primary-tab-focus-native.json](primary-tab-focus-native.json)

## Board artwork

**Home:** Board → Tools → Artwork; fresh-start art link  
**Next owner:** Coworker to assign  
**Feature state:** Deferred by user

**Working/preserved**

- Existing art preview/persistence structure preserved; reachable requested tool.

**Remaining feature work**

- UI Apply integration and further artwork polish deferred; define safe additive operation before connecting it.

**Dependencies:** Artwork/native fabrication contract; original source preservation

**UI states:** Existing empty/upload/preview structure retained; no new Art work in this milestone

**Entry files:** `packages/ui/src/board/ArtTab.tsx`

**Evidence:** [board-tools-native.json](board-tools-native.json)

## Mechanical and enclosure

**Home:** Workspace → Mechanical  
**Next owner:** Existing teammate  
**Feature state:** Teammate-owned

**Working/preserved**

- Existing navigation and implementation preserved without changes.

**Remaining feature work**

- Existing import/generation/fit/polish work belongs to the assigned teammate.

**Dependencies:** Teammate-owned CAD/import/generation contracts

**UI states:** Not reopened or modified in final audit; excluded from this agent completion criteria

**Entry files:** `packages/ui/src/board/CadTab.tsx`

## Parts, BOM and procurement

**Home:** Workspace → Parts & BOM → Parts / Shopping  
**Next owner:** Coworker to assign  
**Feature state:** Connected, bounded

**Working/preserved**

- Existing project hardware/netlist table, search/filter, CSV export and requested add/edit controls.
- Manufacturing screen links here; Shopping has its own authentication/list/error states.

**Remaining feature work**

- Connect source-qualified member/aggregate BOM and physical quantities; do not treat project extras as complete board coverage.

**Dependencies:** Complete netlists/parts sources; cloud shopping auth for procurement

**UI states:** Table/empty, requested filters/add/edit, loading/error, signed out; explicit coverage caveat

**Entry files:** `packages/ui/src/board/ProjectBomPanel.tsx`, `packages/ui/src/board/ShoppingListTab.tsx`

**Evidence:** [output-parts-ownership-native.json](output-parts-ownership-native.json)

## Saved-output library

**Home:** Outputs → Library  
**Next owner:** Coworker to assign  
**Feature state:** Connected

**Working/preserved**

- Saved images/videos/models/manufacturing in one library; search/category/exact source filters.
- Selection reveals Preview/Download/Show file; no zoom controls on collections.

**Remaining feature work**

- Add further provenance coverage only with real dependency receipts.

**Dependencies:** Saved files and qualified source identities; authenticated blob reads

**UI states:** Empty/no-match, selected, loading/read-error/retry, source current/outdated/unverified; compact

**Entry files:** `packages/ui/src/board/OutputsLibrary.tsx`, `packages/client-core/src/output-library.ts`

**Evidence:** [output-discovery-native.json](output-discovery-native.json)

## Renders and product video

**Home:** Outputs → Library / Models & video  
**Next owner:** Coworker to assign  
**Feature state:** Connected, bounded

**Working/preserved**

- Existing saved media, download formats, model/video source status; creation options requested.

**Remaining feature work**

- Broaden tracked dependencies and member-scoped export; keep explicit user generation choices.

**Dependencies:** Native model/render/video tools and actual input receipts

**UI states:** Saved/missing media, buffering/error, outdated inputs, requested preset/duration/output settings

**Entry files:** `packages/ui/src/board/ThreeDTab.tsx`, `packages/ui/src/board/VideoSourceStatus.tsx`, `packages/ui/src/board/RendersTab.tsx`

**Evidence:** [output-parts-ownership-native.json](output-parts-ownership-native.json)

## Manufacturing files and stencils

**Home:** Outputs → Export files; legacy Files exporter retained  
**Next owner:** Coworker to assign  
**Feature state:** Connected, bounded

**Working/preserved**

- Existing Gerber/drill/placement/DXF/ZIP/printed and laser stencil access; advanced formats requested.
- BOM canonical home is Parts; legacy export access retained.

**Remaining feature work**

- Connect member-scoped manufacturing only with captured scope and source-preserving native validation.

**Dependencies:** Saved native PCB, installed exporters and source receipts; assembly export scope incomplete

**UI states:** Source/missing/blocked scope, requested formats/settings, busy/error/completion; no readiness inferred

**Entry files:** `packages/ui/src/board/FilesTab.tsx`, `packages/ui/src/board/file-exports.ts`, `packages/ui/src/board/FileExportControls.tsx`

**Evidence:** [output-parts-ownership-native.json](output-parts-ownership-native.json)

## Freshness and source reconciliation

**Home:** Header Review → Updates → Design sources / Generated outputs / Saved checks  
**Next owner:** Coworker to assign  
**Feature state:** Connected provenance; pending reconciliation

**Working/preserved**

- Actual receipt-based statuses and per-output choices; source checks kept separate from engineering pass.
- Requested pending synchronization options expose both directions; Ask draft remains separate.

**Remaining feature work**

- Implement non-mutating source comparison and explicit guarded direction plan/apply; broaden receipts for untracked outputs.

**Dependencies:** Directional native reconciliation, captured source hashes, conflict review

**UI states:** Current/outdated/unverified/missing/error; requested details; explicit pending sync; no automatic design overwrite

**Entry files:** `packages/ui/src/board/ReviewUpdates.tsx`, `packages/ui/src/board/AssemblyReviewUpdates.tsx`, `packages/ui/src/board/KeepSavedOutput.tsx`

**Evidence:** [review-groups-native.json](review-groups-native.json), [review-source-recovery-native.json](review-source-recovery-native.json), [pending-native-actions-structure.json](pending-native-actions-structure.json)

## Local changes and revisions

**Home:** Review → Changes  
**Next owner:** Coworker to assign  
**Feature state:** Connected root-board comparison

**Working/preserved**

- Existing revision selectors, saved diff modes/change list and drawing navigation retained.

**Remaining feature work**

- Add member/source-qualified diff and source-qualified pins before enabling them for assemblies.

**Dependencies:** Git history, native comparison artifacts and source ownership

**UI states:** No history, missing/member unsupported state, loading/error/saved comparison, selected change

**Entry files:** `packages/ui/src/board/DiffTab.tsx`

**Evidence:** [hosted-review-structure-native.json](hosted-review-structure-native.json)

## Comments and pinned review

**Home:** Review → Comments; selected drawing → Pin comment  
**Next owner:** Coworker to assign  
**Feature state:** Connected root board

**Working/preserved**

- Existing active/resolved comments, drawing pins, details and assistant draft context retained.

**Remaining feature work**

- Add member/source-qualified anchors and hosted discussion integration; do not attach root pins to member geometry.

**Dependencies:** Comment source-anchor contract and hosted review stack

**UI states:** Empty/list, active/resolved, selected pin, save/retry; member scope remains explicitly limited

**Entry files:** `packages/ui/src/board/ReviewComments.tsx`, `packages/ui/src/board/SvgTab.tsx`

## PCB/schematic checks and findings

**Home:** Review → Checks; contextual board check entries  
**Next owner:** Coworker to assign  
**Feature state:** Connected, bounded

**Working/preserved**

- Existing DRC/ERC reports, query/severity filters, exact finding navigation and source receipts.
- Member PCB-only report scope and shared-source identity retained.

**Remaining feature work**

- Complete schematic hierarchy/ERC/parity and inter-board compatibility separately; real findings are not a pass.

**Dependencies:** Native check tools, source dependencies and captured report identities

**UI states:** No report, checking/error/retry, source changed/current, filtered/no-match, selected exact finding

**Entry files:** `packages/ui/src/board/DrcTab.tsx`, `packages/ui/src/board/AssemblyChecks.tsx`, `packages/ui/src/board/CheckFindingFilters.tsx`

**Evidence:** [finding-filters-native.json](finding-filters-native.json), [root-finding-filters-native.json](root-finding-filters-native.json)

## Share, KiCad push/pull and general recovery

**Home:** Review → Changes → Publish & sync  
**Next owner:** Coworker to assign  
**Feature state:** Pending integration

**Working/preserved**

- Requested Share/Sync/History states, explicit pending labels/disabled unfinished actions; local fallback paths work.

**Remaining feature work**

- Connect actual hosted status/review links/permissions; reviewed-file push and previewed pull; implement general undo journal separately.

**Dependencies:** Separate hosted feature stack; exact reviewed revision and protected pull semantics; native recovery journal

**UI states:** Closed by default, explicit pending states, local fallback navigation, Escape/focus; compact

**Entry files:** `packages/ui/src/board/HostedReviewTools.tsx`

**Evidence:** [hosted-review-structure-native.json](hosted-review-structure-native.json)

## Files and project notes

**Home:** Workspace → Files → Files / Notes  
**Next owner:** Coworker to assign  
**Feature state:** Connected

**Working/preserved**

- Existing searchable folder explorer, selected preview/actions, download, image/sketch copy and failure recovery.
- Project notes drafts, preview, explicit save and outside-change handling retained.

**Remaining feature work**

- Broaden preview/import formats only with clear source ownership; preserve unsaved drafts.

**Dependencies:** Authenticated file APIs, project events and conflict-aware notes persistence

**UI states:** Empty/selected/large/unavailable/error/retry; draft/dirty/conflict/save; requested format/tool access

**Entry files:** `packages/ui/src/board/FilesTab.tsx`, `packages/ui/src/board/NotesTab.tsx`

**Evidence:** [file-download-native.json](file-download-native.json), [image-preview-recovery-native.json](image-preview-recovery-native.json)

## Assistant, voice and project context

**Home:** Corner Ask fabPlane; central fresh composer; requested conversations  
**Next owner:** Coworker to assign  
**Feature state:** UI connected; provider deferred

**Working/preserved**

- One mounted composer; project-scoped drafts/attachments and explicit conversation selection.
- Voice/model/settings entry points preserved; no hidden automatic send.

**Remaining feature work**

- Resolve documented Codex CLI model compatibility and rerun actual agent reasoning workflow; do not retry blocked provider setup in UI handoff.

**Dependencies:** Local work/codex-model-compatibility-ticket.json; existing provider/voice services

**UI states:** Closed/requested dock, fresh start, retained draft/attachment, busy/error/provider failure; reasoning unverified

**Entry files:** `packages/ui/src/chat/ThreadView.tsx`, `packages/ui/src/chat/Composer.tsx`, `packages/ui/src/layout/CanvasWorkspace.tsx`

**Evidence:** [fresh-start-clarity-native.json](fresh-start-clarity-native.json)

## Settings, routers, inventory and order flow

**Home:** Workspace options; Parts/Order checks; project menu  
**Next owner:** Coworker to assign  
**Feature state:** Existing functionality preserved

**Working/preserved**

- Requested settings/account/router/voice/appearance/privacy/shortcut controls; inventory and order flow retain return-to-canvas routes.

**Remaining feature work**

- Feature owners validate their service/account/install prerequisites; no implicit manufacturing readiness.

**Dependencies:** Existing settings/services/installed routers; no global credential/security changes

**UI states:** Requested secondary surfaces, connection/auth/install/error states; existing implementation retained

**Entry files:** `packages/ui/src/settings/SettingsDialog.tsx`, `packages/ui/src/inventory/InventoryView.tsx`, `packages/ui/src/order/OrderFlow.tsx`
