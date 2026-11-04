# Placement integration analysis — November 4

## Merge result and scope

PR [#393](https://github.com/TensorFleet/fabdesk/pull/393) was merged into main as **052b3986** on November 4. Our canvas branch was based on earlier main **7a943f2**. This update merges current main into `feat/sketch-first-drafts`; it does not merge PR389 into main or deploy anything.

There were two conflicted files:

- `BoardPanel.tsx`: retain canvas/contextual Checks arguments and all existing destinations; add the lazy Placement destination from main.
- `stores/ui.ts`: retain idea-draft helpers, navigation history, comments/updates and existing shortcut indices; append Placement to the tab registry.

Additional integration glue registers Placement in shared workspace navigation/search and adds a Board tools → Placement draft entry. This makes tab restoration, Back and basic assistant page identification recognize the new view. The editor is still the upstream PR393 layout; the proposed compact design below has **not** been implemented in the app.

A source guard prevents the project-wide editor from guessing an assembly member while member-scoped drafts are not connected. The canvas currently routes assembly boards through ProjectOverview, so assembly placement is not newly exposed. Classic/direct Placement entry also refuses assembly mode. All incoming placement engine/catalog/license files and screenshots are preserved. Current-main CI changes from PR414 are included unchanged.

## What PR393 actually provides

| Capability | Reuse from PR393 | Boundary |
| --- | --- | --- |
| Drag/push, exact X/Y/angle, multiselect, locks/groups, anchors, align/spacing | PlacementCanvas, engine and worker actions | Draft footprint geometry; not connected-track repair on the saved PCB |
| Board resize and reserved regions | Numeric/pointer resize, adjust-placement toggle, area tools | Preview/apply to a placement session; geometry findings are separate from DRC |
| Footprint comparison and additions | 42-item KiCad library, local .kicad_mod, pin 1 and numbered-pad/net comparison | Matching pad numbers are not electrical equivalence. Added parts are unconnected. No supplier/BOM validation |
| Better placement / overlap cleanup | Existing worker suggestion/review/Apply/Cancel | Estimated connection length is a heuristic; not routed length or an electrical pass |
| Recovery, undo/redo, saved session | Existing history and project/device recovery | One draft/cache key per project today; no per-member/source or core-identity namespace |
| Native PCB export | Existing separate uniquely named placement/*-unrouted.kicad_pcb | Intentionally strips tracks/vias/zones. Does not activate the copy as the app’s canonical board |
| Placement enclosure export | Incoming isolated placement/ snapshot and case output code | Preserve it; avoid expanding or duplicating teammate Mechanical work in this pass |

## Focused human-test result

Start: native fabPlane Dev, existing **Button light — beginner order test**, preserved `fresh-user-flow-20261030/profile`, source PCB 30×20 mm / 6 footprints. Code inspection was separate from UI observations.

| Visible path | Result | Friction |
| --- | --- | --- |
| PCB → Edit placement | Passed with friction | Editor loads the actual board and states that the source is unchanged, but none of PCB/Schematic/3D remains selected. Mode is unclear. |
| Parts list → SW1 | Passed with friction | Geometry, X/Y/angle and neighbors appear. Selection auto-focuses at 200%; board context is partly off-screen. |
| Compare replacement footprint | Passed with friction | Library opens, 25/42 pad-number-matching footprints visible. It includes resistors/capacitors for a switch: matching pads cannot imply same function. No replacement applied. |
| Close comparison → Resize board | Passed with friction | Board inspector exposes dimensions, adjust-placement and preview. Inspector retains its scroll position and can open midway down the content. No resize applied. |
| Back from Placement | Passed | Returns to the saved PCB tab without saving or applying the draft. |

Actual captures are in this document’s sibling folder and the original local `work/placement-integration-20261104`. No source edit, Save draft, preview Apply, export, new check job or agent message was performed. Opening the existing editor writes its device recovery copy; the initial source import is labeled Unsaved draft even before a user edit.

### Observed UX issues to address

1. **P1 — too much permanent chrome.** Main navigation plus Placement header, notice, overview, tool strip, view strip, hint and footer reduce canvas space. Keep one task row; move options into contextual tools and one inspector.
2. **P1 — competing saved-PCB and draft tools.** Existing NativePartTools provides guarded position edits; PR393 edits a separate draft. Do not put indistinguishable Apply actions for both on one canvas. The active mode and destination of every save must be explicit.
3. **P1 — source/board context.** Automatic load prefers device recovery → shared project draft → first PCB in sorted file list. Session schema has board geometry/name but no source identity/hash receipt. Do not enable this for assembly members or silently assume the imported/selected version is its source.
4. **P1 — incomplete next step.** Export creates a separate unrouted file. Existing Routing still targets the canonical saved board. A new user needs an explicit candidate selection/handoff before routing/checks/outputs, rather than a misleading Continue button.
5. **P1 — replacement language.** Use Compare footprint. Display pad-number matching separately from function, pin mapping, BOM/stock and manufacturing compatibility. Keep explicit preview/apply.
6. **P2 — styles and density.** Replace raw select/input/checkbox controls with shared styled components; common icons, focus/disabled states and collapsible panels. Reset inspector scroll when opening a different tool. Avoid auto-zoom unless requested; preserve Fit/selection.
7. **P2 — assistant context.** Shared navigation currently identifies Board/Placement, but the editor does not attach selected references, source path/hash, dimensions, current preview, draft revision or geometric findings. Its Ask must describe the draft, not assert that the saved PCB changed.
8. **P2 — misleading initial state.** Distinguish No edits yet / recovered draft / unsaved edits / saved draft. Avoid warning about unsaved changes simply because a native source was opened.

## Proposed canvas integration

Open [the clickable UI proposal](placement-integration-20261104/proposal.html). It uses geometry parsed from the actual six-part test board. **All actions in this HTML are simulated**; it cannot save, resize, replace, validate or export project data. The browser tool refused local file URLs, so this prototype was not visually browser-verified in this pass; its embedded script passes a syntax check. Actual app captures below are separate evidence.

**Entry:** Board → PCB → Placement. PCB stays selected; Placement is a task mode alongside Routing, not a new top-level workspace. The existing Board selector remains the sole source selector. Show a small Placement draft / Source unchanged status on the canvas. Back exits the task and restores the previous view.

**Default canvas:** no permanent inspector. Click a footprint to open its contextual tools; one selected part has no redundant selector. Keep fit/pan/undo/redo in a compact bottom-left strip. Move snap, sides, nets, pushing and reserved-region tools into a styled options menu. Board outline selection or Resize opens board dimensions. A selected part opens X/Y/rotation/lock and Compare footprint. Multi-selection reveals group/align/spacing. Each panel collapses without losing draft or selection.

**Preview:** resize, footprint replacement and optimization share a bottom-center Preview — not applied strip with Cancel and Apply to draft. Before/after geometry, moved parts and actual geometric findings are shown; do not invent a success count. Retain PR393’s worker cancellation and undo. No Apply is described as updating the source PCB.

**Save and continue:** Save draft persists editable work. Export unrouted copy remains a separate action with its removal warning. Then show the exact candidate path and allow an explicit Use candidate / Open for routing flow only once the app can bind routing, DRC, models, outputs and order checks to that candidate. Every generated artifact records the candidate hash. No automatic source overwrite or claim that old outputs are current.

**Footprints:** reuse the existing comparison dialog and catalog. Show the target reference once, current/candidate shape and dimensions, numbered-pad/net mapping and pin-1. Describe unrelated package matches honestly. Put saved-board native edits behind an explicit advanced action until the single draft workflow can replace them safely; never run both editing semantics implicitly.

**Ask:** keep the existing corner assistant. Add a bounded surface containing core/project/source identity, original PCB hash, draft revision, selected refs, board dimensions, unapplied preview and relevant geometric findings. Prepare a useful unsent prompt such as “Review this resize preview and affected parts. Explain conflicts before applying.” Clear stale context on source/project changes. The prototype illustrates this.

**Other pages:** show placement sessions/unrouted candidates under Outputs → Models & files, with the actual source relationship. Surface draft changes in Review only after there is a real persisted comparison. Geometric placement findings belong to the draft; Review → Checks remains electrical DRC/ERC on an explicit saved source. Keep enclosure controls in the teammate Mechanical integration; preserve PR393’s isolated generator without creating a second top-level enclosure UI.

## Implementation order / acceptance

1. **Source adapter first.** Key draft/cache/recovery by core + project + stable source ID; record PCB path/hash and draft revision. Migrate project-wide drafts explicitly; do not silently attach one to a new board. Test project/core/member switching, missing sources, source changes and corrupt recovery.
2. **Canvas shell.** Extract/reuse PlacementCanvas, inspector sections and worker jobs. Consolidate navigation and legacy entry points; styled controls and collapsed tools. Retest root and member navigation, one/many parts, fit, collapse, Back and unsent Ask.
3. **Draft actions.** Wire resize/replacement/optimization preview→cancel/apply→undo/save/reopen with source-preservation checks and original net/UUID assertions. Distinguish pad matches from functional compatibility.
4. **Candidate handoff.** Explicit unrouted-copy activation bound to source selection; route→DRC/ERC→3D/image/video→Gerbers/order uses that exact candidate. Failures retain prior source/output bytes. Test the complete beginner journey before calling this integrated.
5. **Mechanical last.** Reconcile PR393’s placement enclosure exports with PR398 once its owner’s integration is ready; do not duplicate or promise fit checks.

## Merge verification

- Client-core **420 pass / 1,929 assertions**, including incoming placement/recovery tests; local-server fixtures allowed.
- UI **299 pass / 1,299 assertions**. First run caught an old “Updates must be last” assertion; updated it to check Updates at its unchanged index and Placement appended, preserving existing shortcuts. Rerun passed.
- Tools CAD/enclosure **13 pass / 72 assertions**, including incoming isolation tests. This is unit coverage, not a new native enclosure test.
- UI, client-core and tools typechecks passed.
- Production desktop build passed in 1m48s on the final rerun, zero `.map` files. `git diff --check` passed; no unresolved conflict entries.
- Full monorepo/mobile/packaged-installer acceptance and new mutation/export walkthroughs were not run. Do not substitute PR393’s historical validation for new UI acceptance.

![Current merged placement editor: several stacked tool rows](placement-integration-20261104/02-current-editor-selected.png)
![Current footprint comparison](placement-integration-20261104/03-footprint-compare.png)
![Current resize inspector](placement-integration-20261104/04-current-resize-panel.png)
