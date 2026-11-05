# Mechanical canvas integration — human-test, November 4, 2026

Placement commit `797dfdd` was pushed to PR #389 first. This branch, `feat/canvas-mechanical-integration`, starts at that exact head and includes PR #398 head `caaa61aa88b6b144fc2bc84731f257c19040a49b` through merge `d1932cb`. The supplied 56-second demo was reviewed at 2, 10, 27, 37, 48 and 55 seconds. Original concepts and screenshot iterations are preserved.

## Setup and resulting flow

Tested fabPlane Dev / Electron on macOS using the authorized existing `fresh-user-flow-20261030/profile`, Button light and VAIO acceptance projects. This was an existing-project integration test, not fresh onboarding. Non-UI setup: pinned dependency installation and owned development-app restarts. File/log/hash inspection was diagnostic only; no hidden routes, APIs or state mutation completed a UI step. Ask messages remained unsent.

Mechanical now uses the app's shared header, area menu, dot canvas and corner assistant. Assembly / Connections, Fit review, Export and the vertical overflow menu share one task row. Teammate geometry, preview, fit and archive functionality remain the foundation. Generator controls collapse. Saved settings reopen as a freshly computed **unapplied** preview, preserving earlier exports. Ask carries exact sources, model selection, dimensions, save/preview state and focused issue.

Explicit jailed source paths and captured PCB revisions drive project-owned display caches. Mechanical does not infer board membership. Canonical renders/native member edits retain explicit source/manifest guards. Mechanical root PCB editing is rejected for assemblies and its capability is withheld. Canvas mode avoids the duplicate legacy root enclosure status request.

## Visible walkthrough

| Step | Visible action | Actual result | Status / evidence |
| --- | --- | --- | --- |
| 1 | Board menu → Mechanical | One Mechanical workspace, shared header, corner Ask, Add enclosure entry | Passed — 01 |
| 2 | Generate → Preview, Button light | Actual case/lid/connector opening and explicit Preview · not applied / Cancel / Apply | Passed — 02 |
| 3 | Fit review → Show solution → Show in 3D | Named problem, next action and focused pointer; physical review still required | Passed with friction; pale callout text corrected — 03, 11 |
| 4 | Sparkle Ask → attached context | Unsent prompt includes source path, dimensions, focused problem and unapplied state | Passed — 04; no Send |
| 5 | Cancel | Original settings restored; native sources and earlier outputs preserved | Passed — source inventory |
| 6 | Collapse / expand generator | Form hides and returns, preserving canvas and preview actions | Passed |
| 7 | Preview → Apply → Download → native Save | Saved/Applied state and actual verified ZIP | Passed — 05 |
| 8 | Navigate to Board → Back → Mechanical | Saved case displayed as refreshed unapplied preview, without adopting old export freshness | Passed after fix — 06 |
| 9 | Home → VAIO → Mechanical | Initially blocked by old root scope guard; explicit-path adapter fixed it | Passed after fix; regression retains canonical/native fail-closed behavior |
| 10 | Around / Choose multiple boards | Initially five identical board.kicad_pcb labels and picker overlay; now source paths and separate multi-select action | Passed after fix — 07 before / 10 after |
| 11 | Select carrier + I/O → Done → Preview | Two real saved sources inside generated case/lid | Passed — 08 |
| 12 | Connections → select carrier → inspect ports | Remains in Mechanical, explicit ports/cable options and compatibility caveat | Passed with limited coverage — 09; no cable guide committed |
| 13 | Import 3D model → native picker | Picker opened; automation repeatedly lost Go to Folder text before file reached the app | Blocked by native dialog interaction; import/units/transforms not claimed passed |
| 14 | Reopen after clearing stuck picker → Generate | Unsaved two-board selection recovered with visible notice; preview works; revised chooser has clear checkboxes and no overlay | Passed — 10, 11 |

App left running on VAIO Mechanical with an **unapplied** two-board preview and focused fit guidance. No native PCB edit, Send, order, payment, deployment or merge.

## Artifact and source verification (diagnostic)

Download: 72,764-byte ZIP, SHA-256 `fb9b2037ac256c85cd578958bf7be31adc4b237ce868993c64dcdf40ccc8af32`. All 13 entries pass CRC and every manifest hash matches. Case STL/STEP, lid and print STL, PCB snapshot, design/fit/geometry reports, fit sample and review instructions are present. `reviewRequired: true`, `electricalDrcRun: false`. Native Save-panel selection friction produced a longer filename, recorded locally in download-verification.json; this is tool interaction evidence, not a product naming regression.

Complete before/after inventories show **no changed existing files**, including all PCBs, schematics, earlier outputs and VAIO assembly declaration. Expected additions: explicit root Apply archives/settings and isolated display caches. Shutdown removed native transient lock files, and KiCad created two VAIO .kicad_prl preference files. VAIO preview was cancelled before import and never applied. Source diff JSON is included beside this report.

## Validation

- Full root typecheck passed, including core, tools, client, UI and desktop.
- UI: **365 pass, 0 fail**, 4,128 assertions.
- Client: **522 pass, 0 fail**, 2,544 assertions. Sandboxed loopback binding first failed; authorized local-network rerun passed. Dedicated display-tool contract retest passed after adding its tool-name assertion.
- Assembly context, registry and cad-fit: **100 pass, 0 fail**, 1,374 assertions. Covers source path/revision rejection, path escape, unchanged sources and canonical/native fail-closed behavior.
- Six related tool suites: **36 pass, 0 fail**, 165 assertions. A macOS case-alias STEP/VRML duplicate was reproduced and fixed using canonical path deduplication after jailing.
- Thirteen native/geometry suites: **158 pass, 0 fail**, 1,165 assertions. Earlier runs hit the default five-second deadline in different real KiCad cases. Only packaged native integration cases now have a bounded 30-second allowance; assertions, production timeouts and unit-test deadlines are unchanged. Final run: 11.98 seconds.
- Desktop production build passed, zero packaged source maps; whitespace diff check passed.
- Hosted CI, mobile, installer packaging and every full backend suite were not run; no green CI claim.

## Change list / remaining retest

| Priority | Finding / adjustment | State and retest criterion |
| --- | --- | --- |
| P1 | Assembly root guard blocked project mechanical work | Fixed; explicit VAIO sources preview while canonical/native guards still reject unscoped work. |
| P1 | Saved enclosure disappeared on return | Fixed; saved settings recompute a visible unapplied case, preserving old exports. |
| P2 | Duplicate chrome/task organization and missing active-view Ask context | Fixed; one shared task row and unsent current-source prompt. |
| P2 | Indistinguishable board choices / overlay on multi-select | Fixed; source-qualified labels, separate action, styled checkbox rows; native retest passed. |
| P2 | Pale warnings, persistent controls, raw issue count | Fixed; readable callouts, collapsible generator, grouped count and Fit review naming. |
| P1 validation | Native import dialog could not complete through automation | Manual retest: STL/OBJ/GLB selection, units confirmation, move/undo, save/reopen and original-source hash. No hidden workaround used. |
| P1 validation | STEP conversion/modification needs real connected FreeCAD bridge | Not tested here. Test bridge failure/recovery and isolated STEP session before accepting native STEP path. |
| P2 validation | Narrow viewport, Windows, full advanced CAD | Not tested. Check reachable controls and overlap of preview actions/corner assistant. |
| P2 UX | Conservative port candidates included carrier D401 | Observed candidate-list friction. Distinguish likely connectors from uncertain candidates; do not infer hardware or electrical suitability. |

The demonstrated integration is ready for review with these limits. This does not declare the whole app, physical fit, electrical compatibility or manufacturing readiness complete.

## Integration resume checklist

- [x] Placement revision committed/pushed to existing PR389; native report retained.
- [x] New branch from797dfdd; PR398 demo and engine reviewed, merged with both sides' source guards preserved.
- [x] Mechanical shared chrome, contextual assistant and explicit assembly source adapter.
- [x] Root Apply/download and multi-source preview/recovery human-test; source hashes checked.
- [x] Scoped checks, root types and production desktop build passed.
- [ ] Manual STL/OBJ/GLB import/units/transform/save/reopen retest (native automation picker blocked).
- [ ] Connected FreeCAD STEP end-to-end, narrow viewport and Windows acceptance.

The unchecked items are disclosed validation gaps; the enclosing app roadmap remains separate.

November5 follow-up: connection creation is now separately exercised through Add/remove in the native UI. The missing-port guidance defect is fixed. See ../connection-guidance-20261105/REPORT.md; this does not close save/reopen or electrical/cable-path validation gaps.
