# #394 Board Art: support both art-first and circuit-first workflows

## Goal

Board Art should work regardless of whether the user starts with artwork or an existing circuit. The UI must support both paths as first-class workflows.

## Current UI issues (user-reported)

- After adding artwork, switching to another tab and returning to Board Art makes the artwork disappear. Users lose their working context during ordinary navigation.
- Board Art appears independent of the selected project or chat. It is unclear where the artwork belongs, where it is saved, and which circuit will receive it.
- Together, these behaviors make it hard to trust whether artwork is retained or associated with the intended board.

## Expected workflows

### Art first → circuit later

1. Start a new project and add/import artwork before a circuit exists.
2. Preview, configure, and save the artwork without having to generate a circuit first.
3. Create or add a circuit later in the same project.
4. Apply the saved artwork to the board while retaining the artwork and its settings.

### Circuit first → art later

1. Create or open an existing circuit/board.
2. Add/import artwork from the board UI.
3. Preview and adjust its placement on the existing board, then apply it without recreating the circuit.

## Acceptance criteria

- [ ] A clear Board Art entry point is available before a circuit exists and after a circuit has been created.
- [ ] Empty states explain the next action for each starting point; adding art is not blocked by the absence of a circuit.
- [ ] Artwork and its configuration persist when the user moves from art creation to circuit creation and back, including after reopening the project.
- [ ] Creating a circuit after adding art preserves the art and allows it to be applied to the resulting board.
- [ ] Adding or editing art on an existing board preserves the circuit and its layout.
- [ ] Both paths offer a clear preview and apply step, with a way to revisit and edit the artwork.
- [ ] Switching away from Board Art and back retains the imported artwork, preview, settings, and placement.
- [ ] The UI clearly identifies which project/board owns the artwork and explains how chat selection relates to it.
- [ ] Switching projects or chats does not silently discard artwork or show/apply artwork under the wrong project. Returning to a project restores its saved artwork.
- [ ] If artwork can be created before selecting a project, the UI clearly presents it as an unassigned draft and provides an explicit way to associate it with a project/board.
- [ ] Both end-to-end paths, tab switching, and project/chat switching are verified in the UI.

## Design coordination

Coordinate the entry points, empty states, and transitions with the UI redesign currently in progress. This ticket records the desired behavior; it does not request changes to the active redesign checkout.

---
# #395 Board Art: add monotone and multicolor modes with source-color matching and recoloring

## Goal

Let users choose whether Board Art uses a single ink color or multicolor silkscreen. In multicolor mode, automatically convert imported artwork to preserve the appearance and colors of the source image, with optional controls for recoloring it afterward.

The user reports that JLCPCB supports multicolor silkscreen and wants to use that capability from Fabdesk. Confirm the current supported manufacturing process and required deliverables during implementation.

## Desired experience

1. Import an image into Board Art.
2. Choose **Monotone** or **Multicolor**:
   - **Monotone:** convert the image to single-color artwork, retaining the existing threshold/halftone controls where applicable and allowing the user to choose the ink color for preview.
   - **Multicolor:** automatically retain or approximate the source image's colors for the supported color-printing process. Keep a source-faithful result as the initial conversion; recoloring is optional.
3. Preview the result on the board and compare it with the source image.
4. Optionally recolor the artwork through approachable visual controls, then apply/save it.

## User-provided source and target reference

The user explicitly identified these two images as a source/result pair for the intended multicolor behavior:

- **Source:** `genki-dama-goku-stance-intro.jpg` — Goku raising his arms beneath a bright white energy sphere, with a blue sky, skin tones, black hair, and orange clothing.
- **Desired board appearance:** `top-color-halftone-blue-leds-off.png` — the same image translated into a regular grid of colored halftone dots on a blue PCB, retaining recognizable source colors and shading. Components and readable reference labels coexist with the artwork.

Multicolor must support this source-colored halftone appearance: individual dots carry colors from the image, with dot size/coverage conveying detail and tonal variation and the board background visible between dots. Preserve the composition and recognizable color relationships; a single-color halftone with a global tint does not satisfy this reference. Optional recoloring/filter presets are a separate edit after the source-faithful conversion.

The reference shows the intended visual result, not proof that a specific manufacturing process can reproduce every detail. Validate print constraints and reflect them in conversion/export.

Uploaded visual references are available in the issue's **Visual references** comment:
- [Original source image](https://github.com/user-attachments/assets/93acc86b-2af1-4049-a813-a19468888697)
- [Desired multicolor halftone board appearance](https://github.com/user-attachments/assets/ab24c6c5-b188-4eb7-ab92-21f67825bf31)
- [Canva filter and recoloring UI reference](https://github.com/user-attachments/assets/a893e154-4e81-4cf3-94f2-d2d76660d93e)

## Recoloring design direction

The user supplied a Canva Filters screenshot showing a large artwork preview and a sidebar of visual preset thumbnails, including grayscale, Color Pop, and Duotone treatments. Use this as inspiration for discoverability and live previews, adapted to Fabdesk's new UI design.

Potential controls to explore:

- Preset thumbnails rendered from the user's own artwork, so the effect is visible before selection.
- A source/original-color option and one-click reset.
- Simple tint/duotone treatments with editable color swatches.
- Palette color replacement for more targeted recoloring, if feasible.
- An intensity control for effects where it makes sense.

These are design suggestions; the core requirement is an understandable way to recolor without requiring an external image editor.

## Acceptance criteria

- [ ] Users can explicitly select Monotone or Multicolor for imported artwork.
- [ ] Multicolor conversion initially aims to resemble the source image's colors, rather than applying an arbitrary palette or filter.
- [ ] Using the supplied source/target pair, verify that color halftoning retains recognizable composition, source-color relationships, and tonal detail on the selected board background.
- [ ] Users can preview and adjust recoloring, compare against the source, and reset to the original conversion.
- [ ] Color mode, source image, recoloring settings, and placement persist across tab navigation and project reopening.
- [ ] Both art-first and circuit-first workflows from #394 support these controls.
- [ ] The board preview represents artwork colors and the selected board/solder-mask background, with relevant manufacturing limitations explained where they affect a choice.
- [ ] Confirm current JLCPCB color-printing requirements and provide the corresponding artwork/export deliverables. Distinguish multicolor print output from conventional single-color silkscreen output; a colored app preview alone is insufficient.
- [ ] Verify both modes with representative source images and check that applying or recoloring artwork preserves the existing circuit/layout.

## Related work

- #394 — Board Art: support both art-first and circuit-first workflows, retain art across navigation, and make project/board ownership clear.
- Coordinate this feature with the new UI redesign in progress.

---
# #411 Review Changes: comparison drawing connects unrelated board outline segments

Observed during the canvas workspace walkthrough on feat/sketch-first-drafts (local HEAD 37ab084, implementation PR #389).

Reproduction:
1. Open a declared multi-board project and select the RH port source.
2. Review → Changes → Save comparison point.
3. Compare the saved point against Current files, including when the source is unchanged.

Actual: the comparison drawing contains large dark diagonal lines across the board, joining unrelated outline segments. The ordinary native PCB preview does not contain these diagonals. The comparison correctly reports no part or net changes for an unchanged board; that does not make its drawing visually reliable.

Expected: preserve separate outline segments in Highlights, Overlay and Side by side without fabricating connecting edges. Keep source files untouched. Add a representative concave/multi-segment outline regression fixture.

Local evidence: outputs/walkthrough-fixes-2026-10-30/99-member-revision-comparison.jpg. The capture is local and is not uploaded to this issue. Native source was preserved in an isolated acceptance project and saved comparison point a48a5701.

Deferred at the user's request to keep broader app workflows moving. This issue concerns visualization; no electrical, routing or fabrication approval is implied.

---
# #412 Extend source-bound schematic focus to member boards and hierarchical sheets

The canvas workflow in draft PR #389 now supports assistant-driven focus on a verified component in a complete saved root schematic. Native Playbridge validation identified U1 / ESP32-WROOM-32E and visibly focused the same saved symbol; Return restored the previous viewport. The implementation intentionally rejects member-board and multi-sheet focus rather than guessing coordinates or borrowing another board's source.

This leaves part of the requested Schematic → Ask “Which is the main chip?” → actual canvas focus journey unsupported for multi-board projects and hierarchical schematics. Logged separately at the user's request so the broader app workflow acceptance can continue.

Acceptance:
- Resolve the actual declared member source, hierarchy instance, sheet and component reference from saved native data, including repeated sheet instances and multi-unit symbols.
- Bind inspection/export/positions to the same immutable native and rendered revisions; reject stale, ambiguous and foreign-project requests.
- Open the correct board/sheet, focus and temporarily mark the component while retaining the corner answer. Return restores the previous sheet and viewport.
- If several candidates exist, expose source-backed choices rather than selecting arbitrarily. Missing sheets and unsupported coordinates must have clear recovery guidance.
- Validate root, member, repeated-sheet and source-changed cases with actual native UI evidence. This navigation must neither edit native sources nor imply ERC, parity or electrical validation.

Existing limits are intentional and disclosed; this is an extension request, not a claim that member/multi-sheet focus currently succeeds. No enclosure, part replacement or board resizing work is included.

---
# #415 Support parallel project chats with shared design updates and coordinated work

## Problem

In the canvas-first fabPlane workspace (#389), a user needs to keep several conversations about the **same project/design**. While one agent is working, waiting for a tool, or waiting for a decision, the user should be able to inspect another page and ask a different question in another chat without losing the first conversation.

Those conversations also need to share relevant project updates. If chat A changes the design or finishes a check, chat B must learn what changed before giving advice or continuing work. The user should not have to copy summaries between chats.

This is a requested product workflow, not a claim that every aspect is currently absent. Reuse the existing project conversations, Activity, background runs and source/freshness infrastructure; audit their current behavior before adding overlapping controls.

## Concrete journey from the current design test

Project: **Button light — beginner order test**.

1. Chat A works on the board or waits for an answer.
2. The user opens the schematic, Parts, 3D or manufacturing review and starts chat B to ask about the displayed details. Chat A remains available with its activity/waiting state visible.
3. Chat B can explain the circuit, component choices, missing models, quantities or manufacturing blockers while the other task remains in progress.
4. When chat A completes work, all relevant conversations receive a shared project update describing what changed, what succeeded/failed, and what remains blocked.
5. Before chat B continues dependent work, it refreshes the affected source/artifact context and handles any stale assumptions.

The current owner decision is **Basic-only; keep ordering blocked**. That decision must be shared across the project's conversations. Starting or switching chats must not treat the declined Extended connector exception as approved or restart blocked design work.

## Expected UX

- A discoverable **New chat** action and one consistent conversation switcher inside the project. Give chats recognizable titles and show Working / Waiting for you / Queued / Finished / Failed status.
- Switching chats preserves each conversation's draft, attachments, agent/model, history and pending question. Switching pages does not silently create another chat or attach a question to the wrong conversation.
- Show which project, board/source, page, selection or preview a new question refers to. Each chat retains its own task context while following the current shared design state.
- Background tasks continue while the user inspects other details. Completion or a required answer produces a compact notification with **Open chat**; it does not steal the current page or composer.
- Shared updates identify the originating chat/task and link back to its result or changed files. An unobtrusive “Project updated” indicator makes unread updates discoverable without repeating large banners throughout the app.

## Shared information between chats

Automatically publish a concise, durable completion/update record for relevant work:

- Originating conversation/task and outcome: completed, partial, failed or cancelled.
- Actual changed sources/files and affected board(s), with revision/hash or equivalent source identity where available.
- Generated or invalidated artifacts, checks run and their real results; older reports/exports must retain honest freshness.
- New findings, unresolved questions, blockers and dependencies.
- Explicit user decisions/constraints and their current applicability.

Other chats should receive relevant updates automatically and consume them before the next dependent action. A running chat should handle an incoming change at a safe boundary, revalidate its assumptions and pause/queue conflicting edits when needed. Idle chats should retain updates for their next turn. Avoid recursive agent-to-agent message loops or unnecessary runs merely to acknowledge updates.

Historical chat messages remain historical; distinguish shared saved facts and explicit decisions from suggestions or unverified claims.

## Concurrency and scope

Parallel conversation/inspection must not permit conflicting writes to the same source. Reuse or strengthen the current write coordination and revision guards: explain when an edit is queued or blocked and which task owns it. Preserve already saved work if another conversation's task fails or is cancelled.

Project updates stay within their owning project and appropriate board/source scope. A shared source used by multiple instances must not be represented as independent edits. Do not leak unrelated project conversations into this context.

## Acceptance criteria

- [ ] From an existing project's visible UI, create and switch between at least two chats without cancelling the first task.
- [ ] While chat A is running or waiting, use chat B to inspect/ask about another design detail. Verify that A's status and pending answer remain accessible.
- [ ] Drafts, attachments, selected agent/model, pending questions and displayed task context survive switching and reopening.
- [ ] A real change completed in A produces a visible, concise project update with source identity and a link to the originating work.
- [ ] B receives the relevant update automatically and demonstrates awareness of the changed source and any stale output/check before continuing dependent work; no manual copying is required.
- [ ] A user decision made in one chat is respected in the others, including the current Basic-only / ordering-blocked constraint.
- [ ] Simultaneous conflicting edits are safely coordinated; read-only questions remain usable. Failure, cancellation and stale results are reported honestly.
- [ ] Completion notifications preserve the user's current view and unsent composer contents.
- [ ] Human-test the complete flow through visible clicks, capture actual screenshots and log discoverability, confusing transitions and remaining limits.

## Related work

- #389 — canvas workspace redesign and current user journey.
- #93 — reported concurrent-agent / stopped-process write risks. Verify the current state rather than assuming the historical reproduction still applies.
- #91 — follow-up steering/queueing within a chat; related but distinct from communication across conversations.

This ticket records the requested follow-up. It does not request changes to the active implementation checkout or teammate-owned enclosure/replacement/resize work.


---
# #416 Make Board → Schematic a circuit workspace and move document presentation to export

## Goal

Redesign **Board → Schematic** as a working circuit canvas. The user wants to understand, inspect, discuss and work with the schematic here. Paper/document presentation should belong to **Outputs → Export files**, where a document can be generated when needed.

This is a UX/workspace request for the canvas-first design in #389. Reuse the existing native schematic sources, rendering, inspection and guarded editing capabilities; avoid creating a second schematic implementation.

## Problem to solve

A document-shaped sheet scaled to fit the whole page can make the actual circuit tiny, leave large areas of unused space and obscure what the user can do next. The working view should prioritize readable circuitry and useful interactions rather than paper margins, title blocks or a print-preview experience.

Moving document presentation out of this view must preserve the original native sheets and their export metadata. This request does not authorize silently rearranging the electrical drawing or removing information from source files.

## Reference

User-supplied reference: https://x.com/jlcjak/status/2115479821845143588

The attached reference screenshot shows a schematic alongside a PCB and a 3D view, with an assistant discussing the design. Use it to explore linked inspection and optional comparison views. Keep fabPlane's approved styling, navigation and corner assistant rather than copying the reference's entire interface.

The screenshot was reviewed; the linked X video could not be independently fetched/replayed. Specific interactions below are proposed requirements, not claims about the reference implementation.

## Proposed user journey

1. Open Board → Schematic and immediately see the actual circuit at a useful size.
2. Pan, zoom and fit the circuit, or navigate to the relevant sheet/function.
3. Select a component or net to inspect it, ask a contextual question or use an available native editing action.
4. Optionally compare with PCB or 3D and follow the same component across views without losing source or board identity.
5. Return to the working canvas, or use Outputs → Export files to create a document for sharing/printing.

## Expected working view

- **Circuit-first framing:** initial fit targets the circuit content rather than the paper rectangle. Keep labels, symbols and wires readable; avoid oversized print margins and title blocks dominating the default viewport.
- **Predictable navigation:** cursor-centered zoom, pan, Fit circuit, focus on selection and a way back to the previous viewport. Preserve the viewport while briefly switching tabs or opening tools.
- **Source-aware sheet navigation:** clear active board/source and sheet identity, usable hierarchy/breadcrumbs for multi-sheet designs, and honest recovery for missing or stale sources. Multi-board projects must not display another source's schematic as a fallback.
- **Useful selection:** identify the real component/reference, value, symbol and relevant electrical connections. Net selection should make its connected circuit understandable. Resolve repeated references and hierarchical instances from native data.
- **Contextual tools:** keep secondary details closed by default; show relevant inspect, Ask fabPlane, locate on PCB/3D, checks and supported edit actions near the selection or in a compact inspector. Every offered action must have a working path or a clear availability explanation.
- **Safe editing:** connect to the already supported native edit flow, with preview/Apply/Cancel and undo/recovery where supported. Do not present an SVG/raster preview as if it were an editable electrical model. Never claim a successful edit, synchronization or electrical check without evidence.
- **Contextual assistant:** the corner chat knows the visible source, sheet, selection and task. Answers that identify components can focus the actual schematic where supported. Preserve unsent questions while inspecting the circuit.
- **Consistent UI:** use the same typography, icons, colors, selectors, tool buttons, compact feedback and task organization as the other canvas pages.

## Optional linked views

Offer a discoverable comparison/split control for Schematic + PCB and, when useful, 3D. The normal default remains one main schematic canvas with secondary views closed.

Comparison panes should be resizable and closable, with a way to maximize one view. Cross-selection/highlighting must use verified component identities from the same board/source. Missing or partial models need an honest state rather than invented geometry. Returning to one canvas should preserve the user's schematic position.

A visually linked view is not proof of PCB↔schematic parity, ERC/DRC success or physical compatibility.

## Document export

Move document/print presentation to **Outputs → Export files**. Reuse supported exporters and expose any missing format as an explicit dependency.

Document exports should retain the actual native sheet hierarchy, annotations/title-block information and source identity. Exporting should not reset the working viewport or silently modify the schematic.

## Acceptance criteria

- [ ] Board → Schematic opens with the circuit readable and useful canvas controls; document framing no longer dominates the working view.
- [ ] Fit circuit, pan, cursor-centered zoom, select/focus and return-to-previous-view work through visible controls.
- [ ] Component/net inspection and contextual Ask reference the correct native source, sheet and selection.
- [ ] Existing supported edits are accessible with guarded application and recovery; inspecting or exporting does not edit source files.
- [ ] Optional linked PCB/3D inspection is discoverable, source-correct and resizable; closing it restores a usable single canvas.
- [ ] Multi-sheet/member-board, missing-source, stale-render and missing-model cases are handled explicitly.
- [ ] Document export is discoverable under Outputs → Export files and preserves native document information.
- [ ] Human-test single-board and representative multi-sheet/member-board journeys through visible clicks, including a beginner asking which parts do what. Capture actual screenshots and compare readability, canvas proportions and tool discoverability against the approved designs.
- [ ] Verify source preservation and report unavailable interactions honestly; no acceptance based only on static mockups or passing code tests.

## Related work / scope

- #389 — current canvas workspace.
- #412 — source-bound focus for member boards and hierarchical sheets; coordinate with this rather than duplicating its implementation.
- #415 — multiple project chats and shared design updates; schematic context must work with that conversation model.

This ticket records the requested design follow-up only. It does not request edits to the active checkout or teammate-owned enclosure, parts replacement or board resizing work.


---
# #417 Redesign Project activity with a clearer entry icon and compact, actionable task overview

## Problem
The current Project activity entry and panel are difficult to discover and scan. User-provided screenshots from the “Button light — beginner order test” project show:

- The header entry uses an icon resembling history/undo, with “Project activity” revealed only by its tooltip. Its purpose as an overview of background work is unclear.
- Recent tasks shows 27 entries, but large cards with substantial empty space allow only a few tasks to fit on screen.
- Two consecutive “Read project BOM” executions dominate the list. They have different timestamps; they should remain traceable, but repeated low-value reads should not obscure meaningful changes and results.
- Standalone sparkle actions and separated “Task details” rows feel disconnected from their task.
- “Completed” describes execution status without explaining the outcome. For example, finishing a DRC run does not mean the design passed its checks.
- The large modal obscures the work the user was viewing while trying to follow background activity.

These observations come from the supplied screenshots; the proposed behavior below still needs usability validation.

## Proposed improvement
- Make the entry clearly communicate project activity/background work. Use the shared icon and button styles, a clear accessible name and tooltip, and an understandable indicator for running work or items needing attention. Evaluate whether a short visible label improves discoverability.
- Replace oversized cards with compact, scannable rows or a timeline: task name, status, concise result, affected board/source or conversation, and useful time information.
- Prioritize active, waiting, failed and attention-required work. Keep recent successful history easy to browse, with appropriate grouping and filters when needed.
- Group or collapse repeated reads while preserving individual executions, timestamps and technical details. Do not silently discard history or assume separate attempts are duplicate records.
- Distinguish execution state from result: a completed check should summarize findings/pass status where available; an export should identify the resulting artifact; a read should say what was inspected.
- Put relevant actions together beside the result: open the exact output/check/conversation, inspect details, or ask about that task. Give icon-only actions meaningful accessible labels and task-specific context.
- Keep technical details expandable instead of reserving large empty areas in every row.
- Evaluate a nonblocking drawer or anchored panel so users can inspect activity without losing their working context. Preserve the underlying page, viewport and unsent message when opening/closing it.
- Reuse this overview for the parallel-chat work in #415: show conversation ownership, completion and relevant shared design updates without creating competing task/status interfaces. Work must continue while users navigate or inspect another task.

## Acceptance criteria
- A new user can discover background activity and distinguish it from undo/history.
- Empty, running, waiting, failed, completed and many-task states have clear, consistent presentations.
- The 27-task example is substantially easier to scan; repeated reads are compact while individual attempts remain inspectable.
- Check execution completion is not presented as proof of a clean or ready design.
- Result actions open the correct artifact, source, check or conversation; contextual Ask targets the selected task.
- Opening, closing and reopening activity preserves working context and displays current task status.
- Keyboard navigation, focus treatment, labels, contrast and icon sizing match the rest of the app.
- Validate through visible human-style navigation and capture actual screenshots, recording usability findings and follow-up changes.

## Related
- #415 — parallel project chats, shared updates and coordinated work
- #389 — canvas workspace and UI workflows

Scope: design and implementation follow-up ticket. No UI implementation is part of opening this issue.

---
# #418 Clarify Parts source details so users understand where the BOM comes from

## Problem
In Parts → Design BOM, the “Parts source details” section does not clearly explain its purpose or what a user should do with it.

The user-provided collapsed and expanded screenshots from “Button light — beginner order test” show:
- A disclosure labeled “Parts source details” and “1 of 1 native sources”. “Source” could mean supplier/sourcing or the design file used to build the parts list.
- Expanding reveals “Main board”, “1 board · 6 listed parts”, “Saved native schematic · BOM exclusions respected”, and a standalone sparkle action, without an obvious next step.
- A technical sentence about source coverage, schematic/PCB parity and electrical checks consumes space but does not first explain the section's practical purpose.
- The neighboring “Ask about sourcing”, saved supplier IDs, BOM line count and build quantities make the distinction between design origin, supplier data and quantity coverage harder to understand.

These are usability observations from the supplied screenshots, not verified failures in BOM calculation.

## Desired behavior
Help a beginner answer: **Where did this parts list come from? Which boards and extra hardware are included? Is anything missing or out of date? What should I do next?**

## Proposed changes
- Use a plain-language heading such as “Where this parts list comes from” or “Included boards and hardware”; validate the wording with users. Explicitly distinguish design sources from supplier sourcing.
- Keep the collapsed summary compact and meaningful, for example “Main board included” or “2 of 3 board sources read — 1 needs attention”, using actual known state. Avoid unexplained “native sources” terminology.
- In expanded details, identify the board and actual schematic/design file used, why it contributes to the BOM, and its read/freshness state where supported. Put advanced paths and implementation details behind secondary disclosure.
- Explain quantities consistently: BOM lines vs individual parts, board instances per complete build, off-board hardware and exclusions. Make it clear how they relate to the main table and build quantity; do not conflate file count with board count.
- Give missing, unreadable or stale sources a specific explanation and recovery action. Reuse the existing Refresh parts flow and correct-source navigation instead of adding competing refresh controls.
- Provide useful labeled actions such as opening the relevant schematic, viewing included parts, or asking about that board's contribution, where supported. Replace the isolated sparkle with an understandable contextual action.
- Put short, relevant limitations next to the state they qualify. Preserve the distinction between successfully reading a source, PCB/schematic consistency, electrical checks and supplier availability without leading with a dense disclaimer.
- Keep normal complete-source details visually secondary so the parts table remains the main working area. Surface actionable incompleteness without requiring expansion.
- Match the shared typography, spacing, icon, disclosure and feedback styles.

## Acceptance criteria
- [ ] A new user can explain the section's purpose and distinguish design-file origin from supplier sourcing.
- [ ] The current single-board example clearly explains the relationship between 5 BOM lines, 6 parts per build, board inclusion and zero off-board hardware.
- [ ] Multi-board/instance and project-hardware examples make inclusion and quantities understandable without double counting.
- [ ] Missing, stale, unreadable and excluded-source cases identify what is affected and offer an appropriate next step; do not claim readiness merely because sources were read.
- [ ] All visible actions reference the correct board/source and preserve working context. Expanding/collapsing does not change the BOM or quantity settings.
- [ ] Human-test through visible UI interactions and record actual screenshots, comprehension problems and remaining changes.

Related: #389 (canvas workspace), #416 (working schematic view). This is a requested UX follow-up ticket only; do not implement as part of issue creation.

