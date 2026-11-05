This follow-up branch starts from main after #389. It fixes disconnected PCB outline paths in revision comparisons, adds source-bound native schematic focus and circuit-framed previews, and improves Activity results and Parts provenance. It preserves original native design files and keeps document-style schematic exports separate from the working canvas.

## Implemented scope and remaining acceptance

| Ticket | Included here | Remaining |
| --- | --- | --- |
| #411 | Retain independent native PCB outline paths through snapshot composition and all comparison modes. | Real RH comparison captured in all three modes; synthetic concave/cutout regressions pass. |
| #412 | Board-owned hierarchy capture, exact UUID/page identity, repeated-sheet/multi-unit choices, stale choice rejection and previous-view restoration. | Full visible member/repeated-sheet focus and Return/viewport walkthrough; no fixed-focus screenshot claimed. |
| #416 | Explicit frame-free circuit preview, content fit without translating geometry, root/member native page navigation, complete source receipts and visible-sheet assistant context. | Component/net selection, native edit integration, linked PCB/3D views, multi-sheet UI acceptance and dark-theme contrast. |
| #417 | Labeled modeless Activity, compact read groups, individual timestamps/details, older history and exact validated result actions. | Running/failed/waiting/cancel/keyboard acceptance and coordinated project updates. |
| #418 | Included boards/hardware, exact BOM source files, partial coverage and clear BOM-line/physical-part/build quantities. | Repeated-source/hardware and Ask UI acceptance. |
| #394 / #395 / #415 | Audited and recorded dependencies only. | Artwork workflows/modes validation and shared chat coordination remain unfinished. |

No ticket is closed by this draft. Existing partial functionality and passing tests are not full-app acceptance.

## Screenshots by ticket

Actual app captures below; no generated mockups. Native captures are identified separately from the current-branch browser renderer, which used copied projects and an isolated local core to keep the installed app untouched.

### #411 · native RH outline in Changes

Current-branch browser renderer; Review → Changes → Compare → Highlights / Overlay / Side by side. No source edits were made for these screenshots.

![RH outline comparison](https://github.com/TensorFleet/fabdesk/blob/feat/canvas-workflow-followups/docs/ui-progress/workflow-followups/screenshots/09-rh-comparison-highlights.png?raw=true)

<details><summary>Overlay and Side by side</summary>

![RH overlay](https://github.com/TensorFleet/fabdesk/blob/feat/canvas-workflow-followups/docs/ui-progress/workflow-followups/screenshots/10-rh-comparison-overlay.png?raw=true)
![RH side by side](https://github.com/TensorFleet/fabdesk/blob/feat/canvas-workflow-followups/docs/ui-progress/workflow-followups/screenshots/11-rh-comparison-side-by-side.png?raw=true)

</details>

### #412 · native focus — UI acceptance pending

Code and installed-KiCad tests cover source-bound sheet choices and page exports. There is no completed human focus screenshot yet; the root circuit capture below is not presented as proof of this ticket.

### #416 · circuit-first schematic framing foundation

Current-branch browser renderer; Home → copied Button light project → Schematic → Open circuit view. Status confirms recorded native sheets match the drawing. Native geometry and ordinary document exports remain unchanged. Dark-theme native-color contrast needs follow-up; capture uses Light theme.

![Native circuit canvas](https://github.com/TensorFleet/fabdesk/blob/feat/canvas-workflow-followups/docs/ui-progress/workflow-followups/screenshots/08-circuit-canvas-current-build.png?raw=true)

### #417 · compact Activity and exact result navigation

Actual native session: the modeless panel keeps the canvas available. Consecutive reads retain individual history and actions.

![Compact Activity](https://github.com/TensorFleet/fabdesk/blob/feat/canvas-workflow-followups/docs/ui-progress/workflow-followups/screenshots/02-activity-theme-and-canvas-interaction.png?raw=true)

<details><summary>Grouped reads and exact saved-model result</summary>

![Grouped reads](https://github.com/TensorFleet/fabdesk/blob/feat/canvas-workflow-followups/docs/ui-progress/workflow-followups/screenshots/04-isolated-grouped-bom-reads.png?raw=true)
![Exact saved model](https://github.com/TensorFleet/fabdesk/blob/feat/canvas-workflow-followups/docs/ui-progress/workflow-followups/screenshots/06-isolated-activity-model-result.png?raw=true)

</details>

### #418 · BOM origins and physical quantities

Actual native sessions: incomplete multi-board coverage is named; the root example distinguishes 5 BOM lines from 6 physical parts, with quantity 5 yielding 30 parts.

![Multi-board source coverage](https://github.com/TensorFleet/fabdesk/blob/feat/canvas-workflow-followups/docs/ui-progress/workflow-followups/screenshots/03-bom-origins-vaio-incomplete.png?raw=true)
![Single-board parts and source files](https://github.com/TensorFleet/fabdesk/blob/feat/canvas-workflow-followups/docs/ui-progress/workflow-followups/screenshots/07-single-board-five-lines-six-parts.png?raw=true)

### #394 / #395 / #415 · not fixed yet

No fixed-state images are claimed for unfinished tickets. Their accepted requirements remain in the backlog.

## Validation

- Fresh final desktop build passed; no `.map` files found in `apps/desktop/out`. Fresh UI/tools/client-core/core typechecks passed; KiCad typecheck passed at the implementation checkpoint.
- Board-diff suite: 23 tests / 150 assertions; tool comparison tests: 10 / 48. Real RH diagnostic retained 12 native outline paths and 24 rendered revision paths per mode.
- Full client-core suite: 528 tests / 2,561 assertions with local socket permission. The sandbox-only transport bind failure is recorded separately rather than treated as a production failure.
- Root/member preview and publication checks: 22 tests / 78 assertions. Owned schematic rendering: 11 tests / 66 assertions, including 3 installed-KiCad tests. Focus/ownership/store tests also cover stale or foreign sources and previous-view restoration.
- Original and copied native design bytes preserved: 10 VAIO + 47 Button light files checked in each location, all hashes unchanged after the visible retest.
- Human acceptance is deliberately scoped. No manufacturing readiness, electrical parity, external-library completeness, complete-app acceptance, merge or deployment is claimed.

[Per-ticket evidence index](https://github.com/TensorFleet/fabdesk/blob/feat/canvas-workflow-followups/docs/ui-progress/workflow-followups/EVIDENCE.md) · [Human walkthrough and outstanding cases](https://github.com/TensorFleet/fabdesk/blob/feat/canvas-workflow-followups/docs/ui-progress/workflow-followups/HUMAN-TEST.md) · [Implementation/resume checklist](https://github.com/TensorFleet/fabdesk/blob/feat/canvas-workflow-followups/docs/ui-progress/workflow-followups/README.md) · [Source-preservation receipt](https://github.com/TensorFleet/fabdesk/blob/feat/canvas-workflow-followups/docs/ui-progress/workflow-followups/source-preservation.json)
