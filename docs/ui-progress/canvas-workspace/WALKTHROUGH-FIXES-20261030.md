## Publication checkpoint · November 2, 2026

The requested follow-up push published **714d573** (output grouping/actions, schematic navigation, dialog/tooltips and BOM presentation) and **b5c9c53** (source-bound Gerber package with drill files). GitHub previously remained at **c424380**; the two later milestones had been local only. Their actual implementation and native validation are described below. Validation dates remain October 30; this publication does not imply new November 2 native results or a full-root/hosted-CI pass.

The Home → Open → Close → Home implementation is still uncommitted and under native validation. It is excluded from this publication. Output deletion, import provenance, component focus, model-coverage investigation and the remaining acceptance cases are unfinished. This is an interim publication, not completion of the nineteen-item queue or the additional user journeys. No merge or deployment.

The earlier “local” headings and pending statements below are chronological checkpoints. This section governs publication status; the newest manufacturing checkpoint supersedes the older statement that Gerber orchestration is unfinished.

## Manufacturing checkpoint

Outputs → Export files now creates a named Gerber ZIP by sequencing the existing source-guarded Gerber and drill exporters. The ZIP receives only this run’s returned filenames, excluding obsolete layers or optional earlier BOM/placements. A missing/failed drill stage, changed source, mismatched ZIP manifest or changed project cannot produce the completed-download state. Individual advanced exporters retain their existing behavior. The UI names the package, shows progress/error details and preserves source context.

Native Playbridge acceptance: visible Create Gerber package → 26-file result → Download → native Save. Archive CRC check passed, board.drl and copper/mask/paste/edge layers are present; downloaded bytes equal the saved archive. PCB, schematic and fabdesk.json remain byte-exact against the pre-export capture. Evidence: local 09-gerber-package-result.png and 10-gerber-package-proof.json. This verifies packaging, not DRC/fabrication approval.

UI/client/tools typechecks passed; UI 249/993 passed; focused package/output/native-preservation tests 23/114 passed. Member selection/source guards have unit coverage; the corresponding new multi-board native package repeat remains pending. Home lifecycle is next; the other remaining19-item acceptance requirements and new journeys are still active.

## Local second checkpoint — in progress

Schematic previews open at Fit width, with drag pan, pointer-centered zoom and Fit sheet reset. Library groups canonical video formats, schematic sheets and manufacturing layers; private video frames and a completed video’s supporting poster stay in Files. Each card has exact-file Files/Download actions; checkbox selection names and counts the grouped files. Render board image is directly available. Shared preview actions sit in the dialog header, labels escape clipping and follow loading dialog layout, and BOM shows lines versus summed quantity with compact source/filter controls.

Actual native checks in the isolated Playbridge import: one counted readiness note opened its exact DRC release-gate reason and explicit PCB-check destination without running checks; schematic Fit width → drag → Fit sheet → Fit width worked; video MP4 played to 0:05/0:06 and Close returned to Library; video group selected 3 files, plus one image selected 4, then Clear removed the selection; Render board image opened its existing saved Top view without regeneration; BOM showed 73 lines / 77 quantity and its filter icon opened the category controls. New captures 02–08 remain under the local walkthrough-fixes-2026-10-30 evidence directory.

Checks: affected UI/client-core typechecks pass; UI 249 tests / 993 assertions pass; output-library 12 tests / 54 assertions pass. Native model coverage discrepancy, output deletion, import provenance, Home lifecycle, focus-by-component and Gerber/drill package acceptance remain unfinished. Gerber orchestration is local work in progress, excluded from this checkpoint commit. No whole-queue completion or new full-root/build/hosted-CI pass claimed.

# Walkthrough feedback and fix pass · October 30

This is the current **19-item acceptance queue**, collected during the fresh imported Playbridge journey and the user's screenshot review. The user has now authorized fixes and requested an immediate remote checkpoint. Earlier completion statements in WHOLE-APP-20261030.md describe the previous implementation pass, not acceptance of this new feedback.

## Current implementation checkpoint

- **Item1 implemented; native acceptance pending:** imported-board picker now shows stable numeric versions newest first (root candidates first), a Path A–Z option, separately folded backups/archives, readable labels and wrapped exact paths. It preserves explicit source choice; first position does not mean validated/recommended.
- **Item19 implemented for single-board Overview; native acceptance pending:** the readiness badge opens the exact current reasons/warnings counted by Overview. Each note has a check/export/source next action, plus an explicit unsent Ask action. No check runs on opening; note visibility does not resolve it. Assembly source review keeps its existing source-focused behavior and still needs representative acceptance.
- Other items remain **unfinished**. The source identity work in item15 is not included in the sorting change. No model/geometry or Gerber/drill completeness fix is claimed.
- Validation: UI and client-core typechecks passed; UI suite249passed/993assertions/0failed; new imported-board tests3passed/9assertions cover numeric versions, root/unversioned ordering, stable ties and backup classification. No new full root suite, production build or hosted CI pass is claimed.
- Native before capture retained in outputs/walkthrough-fixes-2026-10-30/01-overview-before.png. Current user-led app activity was left undisturbed; after screenshots and full click acceptance for these changes remain pending. Older walkthrough captures are baseline evidence, not new fix acceptance.
- Local milestone work continues on feat/sketch-first-drafts / PR389. This checkpoint is being published at the user's explicit request; it does not finish the fix pass. No merge/deploy.
- Enclosure/assembly#398, replacement/resize#393 and Board Art Apply/polish stay deferred. No existing output was deleted. Temporary keep-awake record remains RELEASED; recurring automation stays paused.

## Requirements and acceptance

The sections below preserve the collected requested behavior. “Deferred”/“do not fix yet” inside historical collection notes describe their recording time; the current fix authorization and checkpoint above govern execution. Screenshot filenames identify preserved local evidence, not hosted attachments. Acceptance must be demonstrated rather than inferred from tests.

## 1. Sort imported board choices clearly

Status: requested, not implemented.

Surface: GitHub import → Project imported → Choose the board to open.

User observation: the list mixes v4.1, v3.0, v4.0 and deeply nested backups, making the intended choice unclear.

Evidence: `codex-clipboard-58e58385-e394-4e65-a679-f471d40c2a18.png` (retained local screenshot).

Current code: `CreateProjectDialog.tsx` renders `result.boards` directly. The import endpoint returns the recursive discovery order from `listKicadPcbFiles` without explicit sorting. Plain `backups` directories are not among its skipped directories; existing `pickKicadPcb` ranking is not used for this list.

Requested behavior:

- Use a stable, visible ordering rather than filesystem discovery order.
- Put root-level board candidates first; within version folders, sort recognizable version numbers newest first (v4.1, v4.0, v3.0; v10 after v9 numerically).
- Keep backup/archive candidates accessible but separate and secondary, preferably in a collapsed group. Folder names indicate organization only, not verified validity or currentness.
- Offer a simple sort control such as Version (newest first) / Path (A–Z), with deterministic path ordering for unversioned ties.
- Make long paths readable without horizontal clipping, retaining the exact relative path for disambiguation.
- Preserve explicit user choice; do not automatically adopt a board merely because it sorts first or label it latest/current without evidence.

Acceptance: repeat the screenshot's import case, verify numeric version ordering and backup grouping, keyboard selection and full-path access, and confirm that the clicked path is the board actually opened. Include root, unversioned and v9/v10 candidates in meaningful sorting checks.

## 2. Focus one project; switch through Home

Status: requested, not implemented. User explicitly changes the redesign direction away from easy in-workspace project switching; this supersedes the earlier recent-project header-switcher preference.

User intent: a VS Code/CapCut-style project lifecycle. Choose a project, open it, and focus on that project. To open a different project, first close the current project and return to Home. Closing a project does not mean quitting the app or deleting the project.

Requested behavior:

- Home is the place to browse/search recent projects, create a project, or import one. Opening a project enters its dedicated workspace.
- Show the active project name as workspace identity, without a direct project-switching dropdown or recent-project list. Project actions such as rename can remain available without offering another project.
- Provide a discoverable Close project / Back to Home action. Opening a different project follows this explicit exit, then selection on Home; no direct switching through chat lists, command shortcuts or secondary project menus.
- Keep board selection, workspace tabs and conversations within the active project available; these are not project switches. Separate any app-level settings/account access from project selection.
- On exit, protect actual unsaved edits and drafts using the existing guards. Preserve saved files, conversations and appropriate project view state for reopening.
- Explain running tasks on exit and preserve discoverable progress/results on Home or reopening. Do not silently cancel tasks, discard edits, or imply jobs stop just because the project closes.
- Move useful recent-project ordering to Home rather than removing the history. Preserve connected-core ownership and unavailable/deleted-project handling.

Acceptance: Home → open A → navigate boards/chat/files → close A → Home → open B. No in-project action switches directly to B. Verify unsaved-work handling, running-task continuity, reopen state, and create/import entry and landing paths. Compare the resulting Home/workspace navigation with the approved canvas references, adapting the earlier project dropdown to this newer explicit user direction.

## 3. Make large schematics inspectable

Status: requested, not implemented.

Surface: Board → Schematic; screenshot shows a very tall sheet fitted into a narrow, unreadable strip, surrounded by empty canvas. Zoom reads 100%, which does not communicate the effective drawing scale.

Evidence: `codex-clipboard-5894cd8a-4bbe-4425-8d2f-0c0d51df5cb0.png` (retained local screenshot).

Requested outcome: inspect component labels, connections and sections comfortably inside the app rather than only seeing the entire sheet as a thumbnail.

- Ensure zoom actually reveals drawing detail without a fit-to-container size cap. Support pointer-centered wheel/trackpad zoom, accessible +/- controls and intuitive pan, retaining sharp vector detail where available.
- Distinguish Fit sheet, Fit width and actual zoom clearly. Fit width should let the user read and pan/scroll a tall sheet; the zoom percentage must describe a defined scale rather than showing a misleading 100% for an unreadable overview.
- Make navigation discoverable with short tooltips/hints and keyboard access. Consider a small overview/minimap when zoomed into an unusually large sheet, only if it materially helps orientation.
- Where the source contains multiple sheets, provide a clear sheet/hierarchy selector rather than forcing the user through a combined thumbnail. Do not invent hierarchy for a single tall sheet.
- Evaluate find-by-reference/net and selection → details / Ask handoffs against existing parsed-source capabilities. Only expose semantic selection or net tracing where actual source data supports it; image inspection alone must not imply electrical connectivity checks.
- Preserve the selected board, sheet and viewport when opening/closing assistant or detail tools, and keep corner controls from covering the drawing/navigation.

Acceptance: use this imported tall schematic, zoom into a component until labels are readable, pan to a distant section, return via Fit, and repeat with fit-width and keyboard controls. Verify no clipping/dead zoom, accurate scale feedback, supported multi-sheet navigation, and stable board/context on Ask/detail return. Source inspection and visual navigation do not count as ERC or parity validation.

## 4. Ask fabPlane to identify the main chip from Schematic

Status: requested; investigation and implementation deferred until the main workflow reaches this item. User explicitly asked to record the task rather than investigate now.

Surface: the same imported project's Board → Schematic page as item 3.

Requested journey: open corner Ask fabPlane on that page and ask “Which is the main chip in this schematic?” The expected interaction is an answer coupled to the canvas: identify the actual component, open its sheet if needed, and automatically pan/zoom to a readable view with a clear temporary highlight or position marker. Text-only identification does not meet this request. This depends on item 3's inspectable schematic canvas.

Acceptance: provide the component reference and part name, explain its likely role using actual schematic/source evidence, and visibly focus/highlight that same component in the correct board and sheet without a separate manual search. Keep the answer available while showing the component; allow clearing the highlight and returning to the earlier view. If there are multiple plausible main chips, explain the ambiguity and offer candidates that focus their actual locations. Do not guess coordinates from the thumbnail, confuse another project's source, or claim a highlight/navigation action succeeded unless it actually happened. If semantic positions cannot be resolved, explain the limitation rather than zooming arbitrarily; record that as an unmet part of this task. Verify the complete question → answer → actual canvas focus behavior when the main workflow reaches this item.

## 5. Keep video export intermediates out of the default output library

Status: requested; investigation and implementation deferred. Collect this feedback while the main chat continues its walkthrough.

Surface: Outputs → Library after starting/exporting a product video. Before screenshot shows 6 saved files; later screenshot shows 154, including individual `frame-0143.png`, `frame-0142.png`, etc. The screenshot also shows MP4/GIF variants and a 0 B WebM with Preview unavailable while the header still indicates one active task. Do not infer that all encoding has completed from this screenshot alone.

Evidence:

- `codex-clipboard-0e136935-d68a-4229-b507-4e0a08e14b67.png` (retained local screenshot)
- `codex-clipboard-cf1d0527-97ea-4132-94aa-6698c58ed58d.png` (retained local screenshot)

Requested behavior:

- Default Library shows user-facing deliverables, not every temporary frame, encoder placeholder, cached preview, poster dependency or metadata file. Confirm actual file roles in the video pipeline before filtering; do not hide a user-created image simply because its name resembles a frame.
- Present a video as one understandable output with available format variants (for example MP4/GIF/WebM) in its preview/download actions or grouped details. Preserve independently created outputs and meaningful versions.
- Keep intermediate assets available through Files or explicit advanced/source details when useful; avoid adding every frame to the normal Images tab, output counts and Select all downloads.
- Represent running/partial/failed exports honestly. A zero-byte or unfinished file is not a completed playable output; expose relevant progress or recovery without a misleading play card. A failed optional format must not conceal valid completed formats.
- Preserve original user files and completed deliverables. Do not delete frames needed for active rendering; any cleanup must be limited to verified task-owned intermediates with safe lifecycle handling.

Acceptance: record the Library before export, during rendering and after completion; show a small, understandable set of final deliverables with working previews/download variants. Verify default counts/filters/bulk selection exclude internal frames, advanced access remains possible, and cancellation/failure/re-export does not leave ghost outputs or erase a previous valid result. Investigate the 0 B WebM state against the actual task outcome rather than assuming success or permanent failure.

## 6. Delete unwanted outputs individually and in bulk

Status: requested; investigation and implementation deferred. No files are authorized for deletion by recording this feature request.

Surface: Outputs → Library, including exported video variants, images and models.

Evidence: `codex-clipboard-f1ee5a04-0a1b-48b5-8898-b50d42037b79.png` (retained local screenshot).

Requested behavior:

- Provide an understandable Delete action for one output and a bulk Delete selected action using the existing multi-selection controls. Show the count and exact scope before removing resources; use existing trash/recovery support where available and state clearly if deletion is permanent.
- Determine deletion eligibility from actual ownership, protection and active-use information. Disable Delete for resources that cannot be deleted and explain the concrete reason (for example protected source, read-only location or an active task using the resource). Do not disable ordinary preview/download selection merely because deletion is unavailable.
- For mixed selections, clearly distinguish eligible and protected items. Offer deletion of the explicitly identified eligible subset without silently deleting dependencies or implying every selected item was removed. Disable bulk Delete when none are eligible.
- Coordinate with item 5's grouped outputs: distinguish deleting a format variant from deleting a whole output group. Explain any supporting assets included; do not unexpectedly delete other video variants, source boards, shared models or unrelated files.
- Recheck eligibility when executing, handle partial failures truthfully, and refresh selection/counts/previews after success. An output's removal must be reflected in affected views without fabricated freshness or validation success.

Acceptance: select several unwanted generated outputs on a disposable fixture, delete the confirmed eligible items, and verify they disappear after refresh/reopen. Test protected and in-use resources, mixed selections, cancel/confirmation and partial failure behavior. Verify source files and retained/shared dependencies remain unchanged. This is an implementation task, not a request to delete the currently pictured project files now.

## 7. Make board image rendering a prominent frequent action

Status: requested; investigation and implementation deferred.

Surface/evidence: same Outputs → Library screenshot as item 6. Render board images currently appears under the generic Create output menu. User reports the navigation is too difficult and explicitly identifies board rendering as an expected frequently used feature; prioritize its discoverability accordingly.

Requested behavior:

- Make Render board images directly visible and easy to reach from Outputs, rather than requiring discovery inside a generic creation menu. Keep less frequent creation options secondary; reuse the same rendering flow rather than creating duplicate pages or competing dialogs.
- Provide a short path from inspecting the active board to rendering that board, using its captured source context. In a multi-board project, clearly show which board will render and allow an explicit choice when needed.
- Use sensible remembered/default settings for quick rendering, with advanced controls folded away. Show prerequisites and useful recovery if the current board/model is unavailable; do not send the user through unrelated pages without a clear reason.
- After Render, show progress and the resulting image in a suitable preview with Download, Render again and optional settings adjustment. Keep the result discoverable through Library and Activity if the user navigates away.
- Keep terminology, icons and control placement consistent with the approved canvas UI. Avoid duplicate output creation, unnoticed source switches, or claiming that a render validates the design.

Acceptance: from Library and from an open board, a user can immediately find rendering, confirm the intended board, produce an image with minimal navigation, inspect/download it, and render again. Verify both single- and multi-board source ownership, prerequisite recovery, and background progress/result return. Review the actual click count and clarity during the main walkthrough.

## 8. Remove excessive top whitespace across popups

Status: requested; implementation deferred with the walkthrough change list.

Scope update: user reports this affects almost every popup, not only Render board image. Audit the shared dialog/action layout and its consumers, including image/video/model/file previews and tool dialogs. Preserve useful intentional content spacing.

Original surface: Render board image dialog. Screenshot shows a large empty band between the title divider and “Create an image from a saved PCB…”, with the Ask sparkle isolated at the right. The later video preview screenshot shows a similar action-only gap beneath its title.

Evidence: `codex-clipboard-2a413b81-a0e6-4a2b-85e6-538b9dd5f1aa.png` (retained local screenshot).

Requested behavior: remove the oversized empty band so the description sits beneath the header with normal dialog spacing. Place the contextual Ask icon in the header or the description row without a dedicated tall row. Keep room for a board selector only when needed, without reserving that space on a single-board project. Preserve clear separation between description, view controls, preview and footer, with the preview receiving the recovered space.

Acceptance: compare this same dialog before/after on the single-board project and check the multi-board selector, shorter viewport, keyboard focus and Ask access. No clipped footer/preview or overlapping header controls. Coordinate with item 7's simplified rendering flow; this is a layout fix, not a new rendering function.

Also inspect representative popup families at normal and shorter/narrower sizes. Use consistent compact header/action placement and body padding; do not fix one dialog with a blanket spacing change that clips content or disrupts others. Additional evidence: `codex-clipboard-2378e5f1-619e-4c3a-a7f7-b6dd62428f59.png` (retained local screenshot).

## 9. Keep popup tooltips readable at edges

Status: requested; implementation deferred. User asks to recheck tooltip display; screenshot shows “Ask about this out…” clipped by the video dialog's right boundary. Treat the observed cutoff as the defect to resolve.

Evidence: `codex-clipboard-2378e5f1-619e-4c3a-a7f7-b6dd62428f59.png` (retained local screenshot).

Requested behavior: position edge tooltips inward or flip placement so the complete short label remains visible within the viewport. Use a bounded width with wrapping for longer text, avoid clipping by dialog scroll/overflow containers, and retain correct layering. Apply consistently to hover and keyboard-focus labels without making a tooltip persist over unrelated content.

Acceptance: hover/focus the video preview's top-right Ask and folder actions, plus matching controls in other popups. Test right/left/top/bottom viewport edges and narrower sizes; all labels remain readable with no accidental cropping, unwanted page scroll or interference with dialog controls. Coordinate with item 8's relocated popup actions.

## 10. Separate per-card output actions from bulk selection actions

Status: requested; implementation deferred.

Surface: Outputs → Library selection bar and output cards. User does not want Play or Show file presented as multi-selection operations. Each card should offer small Show in Files and Download icons directly.

Evidence: `codex-clipboard-4da12294-aea0-4491-954d-f92de38a747e.png` (retained local screenshot).

Requested behavior:

- Keep the selection bar focused on genuine bulk actions: Download selected, Delete selected with item 6's eligibility rules, and Clear selection/count. Remove Play/Preview and Show file from that bulk toolbar; do not arbitrarily open just one of several selected files.
- Add small, consistent Show in Files and Download icon buttons on each card. Show in Files opens the app's Files page and reveals/focuses that exact file in the active project, rather than an unspecified folder or another project.
- Keep Play/Preview as a clear action on the individual card/thumbnail where supported, separate from its checkbox. Icon actions must not accidentally toggle selection or launch the card preview.
- Supply concise complete hover/focus labels and accessible names. Keep icons discoverable on keyboard/touch, and avoid overlap with selection checkboxes or media playback controls.
- Coordinate with item 5's grouped video variants: card/group actions must make clear whether they download a selected format or a group; file navigation must identify an actual file. Avoid one-item-only overflow menus when direct icons cover their actions.
- Clarify the card status “Recorded model inputs unchanged”, which the user finds confusing. Explain in plain language that the recorded inputs used to generate the video still match, without implying that the model matches the latest PCB, all dependencies were inspected, or engineering checks passed. Candidate short wording: “Model unchanged since video export”, only if the actual receipt supports that scope. Put checked inputs, generation time and unchecked dependencies in optional source details; use an actionable stale/unknown status when appropriate. Review equivalent technical status wording across output cards for the same problem.

Acceptance: select two or more outputs and confirm the toolbar offers only valid bulk operations. Independently Show in Files and Download from selected and unselected cards; verify exact file targeting, unchanged selection, keyboard access, and no unintended playback. Test all supported output types and grouped video formats.

## 11. Simplify BOM source coverage and use a Filters icon

Status: requested; implementation deferred.

Surface: Parts → Design BOM. Source coverage currently occupies a full-width disclosure, source card and technical explanatory line above the search/table. User requests a better presentation and an icon instead of the Filters text control.

Evidence: `codex-clipboard-f57e3aad-d921-4825-89e6-52bdd7e5ba2c.png` (retained local screenshot).

Requested behavior:

- Replace the bulky Source coverage presentation with a concise readable summary near the BOM heading or toolbar, for example “Parts from 1 of 1 board sources”, using actual coverage semantics and counts. Keep per-source details, inclusion/exclusion rules and technical limitations in an optional disclosure/popover.
- Missing, incomplete or unavailable sources must remain noticeable with a useful next action; do not tuck actionable problems away as if coverage were complete. Preserve distinctions between design sources, physical board quantities and project-level hardware. Explain any different item/part counts without crowding the default page.
- Do not imply that BOM coverage establishes schematic/PCB agreement or passed electrical checks. Keep that limitation available in context without making a long technical warning the main visual element.
- Retain main-report C07: distinguish grouped BOM lines from total component quantity so “73 items” and “77 listed parts” have clear, noncontradictory labels.
- Replace Filters text with a consistent filter/sliders icon button next to search. Provide a complete hover/focus label and accessible name, visible expanded state, and an active-filter indicator/count with a clear reset action when needed.

Acceptance: compare the single-source layout with this screenshot, then verify multi-source and missing-source cases. Source details and Ask remain accessible, search/filter/table receive appropriate space, quantities retain their meaning, and icon-only Filters works with mouse, keyboard and narrow layouts.

## 12. Give Export files Ask a deliberate, consistent position

Status: requested; implementation deferred.

Surface: Outputs → Export files. The isolated sparkle sits far from the page title and Saved outputs action, appearing to float in unused header space. User explicitly finds its placement awkward.

Evidence: `codex-clipboard-c6cc3e8c-c4bc-43e0-9eb8-f21a8867bb99.png` (retained local screenshot).

Requested behavior: remove the arbitrary floating position. Prefer the persistent corner Ask for page-wide export help, with the actual board, chosen format and visible options captured. If a separate contextual Ask shortcut is useful, align it deliberately in the page action group or export panel heading using the same placement/spacing pattern as other pages. Avoid two indistinguishable entry points for the same question. Keep distinct pre-prompt behavior only where it adds useful specific context, and make that purpose clear through a complete tooltip/accessibility label.

Additional user feedback: “Choose a board and the files you need. Saved outputs stay in the library.” is misleading for a single-board project with no selector. Use conditional copy: single-board “Choose the files to export from this board. Exported files appear in Library.” Show the actual board identity without an unnecessary selector. For multi-board projects, provide a real source/board selector and wording such as “Choose a board, then select the files to export.” Only describe choices that are present and usable. Board selection remains within the open project, consistent with item 2; it is not project switching. If no usable board is available, show the actual prerequisite/recovery instead of this instruction.

Acceptance: inspect Export files at normal and narrow widths, verify intentional alignment and no stray sparkle/overlap, and confirm corner/contextual Ask identifies the selected board and export settings without sending automatically. Coordinate with global popup/action spacing and tooltip items 8–9.

## 13. Sort output cards by most recently created/exported

Status: requested; implementation deferred. User first asked “sort by last exported”, then clarified “or last created”. Intent: the newest generated deliverable should be easy to find at the top.

Surface: Outputs → Library, including grouped Manufacturing files. Evidence: `codex-clipboard-f92d4ccf-2832-4c54-8b90-2de3d370c4b4.png` (retained local screenshot).

Requested behavior: default to newest created/exported first with a clear sort label. Use recorded output generation/export time where available; do not claim filesystem modification time is creation time when it is only a fallback. Regenerating an existing output should bring the newly completed result to the top; merely previewing/downloading/checking it should not. Apply the same chronological ordering to image/video/model cards and grouped manufacturing outputs instead of pinning a newly exported manufacturing group last. Use an appropriate recorded completed generation time for a group and deterministic ties; never invent dates for unknown legacy outputs. Keep group-internal file ordering separate from Library card chronology.

Acceptance: generate/export different output types in sequence, including a manufacturing group and a replacement of an existing output, and verify latest completed results appear first across All and filtered views after reload. Opening or downloading an older output must not reorder it as newly created. Preserve selection by stable identity when refreshed ordering changes. Coordinate with item 5's grouped variants and hidden intermediates so transient frames do not dominate the sort.

## 14. Replace the manufacturing-file upload/share-style icon

Status: requested; implementation deferred.

Surface: Outputs → Library → Manufacturing. Both large placeholder thumbnails and small file-type icons use an arrow rising from a tray, which reads as an upload/share action rather than an existing manufacturing file.

Evidence: `codex-clipboard-cb05fdb1-0eca-42d7-b2cd-47068d03da0b.png` (retained local screenshot).

Requested behavior: use an appropriate file/document or PCB-layer icon from the established icon set for Gerber/drill/manufacturing artifacts, with extension/layer labels for disambiguation. Update both thumbnail fallback and filename icon consistently. Keep Download a separate action using its directional action icon per item 10; do not substitute another action glyph as file identity. Do not imply a real geometry preview exists when only an icon is shown.

Acceptance: check representative Gerber, mask/paste, outline and drill files and grouped manufacturing outputs for consistent neutral file identity, readable format labels and distinct Show in Files/Download actions.

## 15. Keep selected imported board/version identity visible (main C04)

Status: observed in main click-only report; queued, not fixed. After choosing `versions/v4.1-controller-serial-bridge/board.kicad_pcb`, the workspace only prominently identifies the repository/Board. Keep the chosen board/version and exact source path discoverable through board identity/details; do not imply all repository versions are the same board. Coordinate with item 1 and the one-project workspace in item 2. Main capture05 is the existing evidence.

## 16. Audit inconsistent component model coverage (main C05)

Status: observed visual discrepancy, cause unconfirmed; correctness investigation queued, not fixed. Top PNG shows two lower connector models absent in the first 3D capture/video opening frame. Compare actual source revision, model inputs and component geometry across 3D/image/video before diagnosing or claiming parity. Explain missing geometry consistently; a recorded input-unchanged label is insufficient. Preserve sources and completed outputs. Main captures07/09 and video evidence apply.

## 17. Recheck video preview Close hit target (main C06)

Status: candidate issue, not confirmed; queued, not fixed. Main report records three coordinate clicks on the MP4 modal's visible X did not dismiss it, while backdrop dismissal did; other image-modal close worked. Recheck exact hit target, focus and concurrent-input/layout conditions in the actual UI before diagnosing. Coordinate with items 8–9. Do not claim a confirmed broken control from coordinate clicks alone.

## 18. Audit Gerber package completeness and direct download (main C08)

Status: observed missing visible drill entry; full package correctness unconfirmed; queued, not fixed. Gerber generation and a 22-file ZIP/native save succeeded, but no drill file was visible among layer entries. Inspect the actual generated package and drill-handling contract; successful ZIP download is not fabrication readiness. Provide a direct named package Download plus a readable manifest/completeness status after export, retaining individual-file and bulk ZIP access. Do not label missing required fabrication files as a successful complete package. Main captures13–15 and saved ZIP are existing evidence.


## 19. Make Overview readiness notes specific and actionable

Status: implementation started after user authorization; native acceptance pending.

Surface: Overview → Needs review · 2 readiness notes → Review → Checks.

User observation: Overview promises two readiness notes, but clicking it opens a generic Design checks page with “Start with a design check” and Run PCB checks / Run schematic checks. The destination does not identify the two notes or make clear what the user should focus on. Screenshots establish this navigation/clarity mismatch; the underlying note reasons have not been investigated and must not be invented.

Evidence:

- Overview badge: `codex-clipboard-af447f62-1f10-4c00-b19e-c07fed087c40.png` (retained local screenshot).
- Destination: `codex-clipboard-dfe36c17-8d9d-43af-8e8b-0b5fd22859c3.png` (retained local screenshot).

Requested behavior:

- Clicking the readiness badge reveals or navigates directly to the exact notes contributing to its count, in the same project and board scope. Focus/filter/highlight that list so it is immediately apparent why the user arrived.
- Each note states what needs attention, the affected board/source/output, why it matters and a concrete next action. Provide contextual Ask where useful without sending automatically.
- Distinguish checks not yet run, unavailable/missing prerequisites, stale results, source/output readiness and actual reported findings. Do not present “not checked” as a discovered design error or imply an available schematic has passed checks.
- Keep the Overview count and destination list consistent, with understandable counting/grouping semantics. If a note belongs in Updates or another surface, route to that specific issue or provide a focused readiness summary linking to it; do not send all notes to an unrelated generic Checks empty state.
- Preserve existing DRC/ERC coverage boundaries and honest statuses. Opening a note does not resolve it or run a check automatically. Handle changed/resolved notes by explaining the refreshed state rather than showing a stale unexplained count.

Acceptance: reproduce the pictured two-note state and click the badge; both actual reasons must be immediately identifiable with working next actions and correct board scope. Verify single/multi-board cases, not-run versus stale/failed/reported states, count refresh after a real resolution, and return navigation. No live checks, agent sends, app changes or fixes were performed while recording this item.
