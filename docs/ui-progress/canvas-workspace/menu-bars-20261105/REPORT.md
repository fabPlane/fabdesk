# Workspace menu bars · 5 November 2026

The owner reported uneven top-bar controls and asked for better positioning across the app. This change standardizes the shared workspace bars and separates placement editing from file actions. It does not change engineering operations.

## Implemented

- One 36 px control height, centered icons/text, consistent spacing and picker treatment for the workspace selector, board picker, view tabs and top-bar actions.
- Shared toolbar rules cover Board, Routing, Mechanical, Review, Outputs, Parts and Files navigation. Existing page-specific tabs and available operations remain in their own areas.
- Assembly board headers occupy their real height instead of floating over the canvas. Wrapped controls reserve space; PCB, schematic and 3D pages use the same header structure.
- Placement editing keeps Back to PCB, Arrange, Resize, Layout checks and Ask together. The redundant general board-tools menu is omitted in this mode. Outside editing, its entry is named Edit placement.
- Placement status, Save layout and Create PCB copy occupy a separate row. Canvas filters and interaction guidance stay below that row. At narrower widths the task group wraps together and starts at the left of its content column.
- Long project names can shrink without squeezing the header actions. On narrow windows the connection dot remains while its redundant Local workspace label is hidden.

## Starting state and preservation

Actual fabPlane Dev, current integration branch based on 8ef10d6, existing fresh-user-flow-20261030 profile. VAIO multi-board acceptance validation was already open. This was a focused toolbar review, not a fresh-user or engineering-flow acceptance test. Existing unsaved mechanical and I/O placement changes were retained. No layout, board, enclosure, routing, connection, or export was saved or applied. Navigation/window resizing and dismissal of an automatic recovery notice were the only app actions.

## Human walkthrough

| Step | Visible action / path | Expected outcome | Actual result | Status | Evidence / friction |
| --- | --- | --- | --- | --- | --- |
| 1 | Inspect current Mechanical controls | Find navigation and task actions on a shared baseline | Different existing control dimensions/positioning confirmed during review; owner also supplied PCB and placement examples | Passed with friction | [Before](00-mechanical-before.png); owner screenshots remain in chat |
| 2 | Navigate to the I/O board PCB | Board picker, views and tasks share a bar | Baseline captured; an existing source inspection Retry state was also present | Passed with friction | [PCB baseline](01-board-before.png); source inspection is outside this presentation fix |
| 3 | Return to Mechanical after the shared sizing update | Aligned views and actions | Native capture shows the common control rhythm and spacing | Passed | [Mechanical](02-mechanical-after.png) |
| 4 | Open Edit placement | Clear exit/task group; save actions separate from status | Native wide-window capture shows the grouped mode controls and separate status/action row | Passed with friction | [Placement](03-placement-after.png) |
| 5 | Resize native window narrower | Groups wrap without covering one another | Wrapping occurred and the separate status/action row remained. Right alignment of the wrapped group and misplaced guidance prompted a final CSS adjustment | Passed with friction | [Narrow intermediate](04-placement-window-check.png) |
| 6 | Retest final narrow alignment and remaining pages | Fresh captures match the page being inspected | Native AX state advanced to PCB/Routing while captures retained the older placement frame, including after window restoration. Coordinate input also returned noWindowsAvailable. These captures cannot establish final visual correctness | Blocked | Later raw captures are preserved locally in work/menu-bars-20261105; not used as after evidence |
| 7 | Browser fallback | Independently inspect remaining page bars | Chrome automation failed before navigation; a separate in-app-browser opened the browser-client pairing screen, not the native workspace. No pairing or hidden state setup was performed | Blocked | No claim of native or browser acceptance from this fallback |

## Change list and retest plan

| Priority / issue | Adjustment | Current state | Retest criterion |
| --- | --- | --- | --- |
| P2: Board picker, view tabs, icon tools and buttons have different dimensions | Shared heights, centering and gaps | Implemented; representative native captures obtained | At wide and narrow widths all visible controls share a baseline, labels remain readable and menu popovers open without clipping |
| P2: Placement mode mixes navigation, editing, status and saving | Group mode controls; dedicated status/save row; omit redundant board-tools overflow | Implemented; wide layout captured | PCB → Edit placement → Back to PCB is discoverable; Save/Create copy remain in their separate row |
| P2: Wrapped placement row is right aligned; instruction text overlaps the drawing | Left-align wrapped task group and move guidance below filters | Implemented after intermediate capture; final visual check blocked | At 1100 px and below, task controls begin at the content column and guidance stays clear of the drawing |
| P2: Absolute assembly toolbar positioning requires page-specific guessed offsets | Use normal document flow, including schematic-specific override | Implemented; final schematic/3D visual check pending | Open PCB, Schematic and 3D; no empty spacer or status overlap when controls wrap |
| P2: Incomplete all-page visual coverage | Resume on a native window returning current frames | Not completed | Click Overview/Boards, Routing, Mechanical, Parts, Outputs, Review and Files; open each relevant dropdown and confirm placement, focus, hover and dismissal at wide/narrow sizes |

## Validation

- UI typecheck: passed.
- Full UI suite: 366 passed, 0 failed; 4,135 assertions across 80 files.
- Final desktop production build: passed in 28.66 seconds, including the schematic spacing selector correction.
- Final build contains zero source-map files; git whitespace check passed.

The implementation is complete for this toolbar increment. Full final native visual acceptance remains explicitly incomplete. No claim that every app flow, engineering result, hosted CI job or remaining roadmap item is complete.
