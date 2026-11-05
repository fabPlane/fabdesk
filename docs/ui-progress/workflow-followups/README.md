# Workflow follow-ups · 5 November 2026

User-authorized work on issues #394, #395, #411, #412, #415, #416, #417 and #418. Branch `feat/canvas-workflow-followups` starts at main `4ddd358` (merged #389). Existing projects and all earlier evidence are preserved. Implementation is authorized; close an already-resolved issue only after its full acceptance is verified. New fixes should reference issues in the eventual PR and close on merge. No merge, deployment, order or payment is authorized.

## Dependency order and current audit

| Issue | Existing coverage / remaining work | State |
| --- | --- | --- |
| #411 | Parser has separate outline paths, but snapshot composition drops them before comparison rendering. Reproduced with a full comparison regression; preserve paths through all modes. | Implemented locally; 23 board-diff tests pass; real-source diagnostic passes; native Changes walkthrough still required |
| #418 | Added labeled included-board/hardware section, exact read files, per-build vs line counts and scoped schematic/Ask actions; partial quantities no longer claim complete coverage. | Implemented locally; unit/type/build checks pass; multi-board native walkthrough recorded, single-board 5-line/6-part and Open schematic retest passed; repeated-instance/hardware and Ask retests remain |
| #417 | Labeled Activity entry, modeless compact panel, consecutive read groups, measured outcomes, exact file actions, expandable run detail and older-history access. | Implemented locally; grouped-read/restart/result-model native walkthrough recorded; running/failed/cancel/keyboard and shared updates remain |
| #412 | Extended focus with captured member scope, native UUID/page identity, repeated-instance annotations/multi-units, source-backed choices, complete hierarchy hashes and previous view restoration. | Implemented locally; packaged-KiCad/core/client/store checks pass; visible member/repeated-sheet focus and viewport retest remain |
| #416 | Added transparent frame-free circuit exports, geometric content fit without coordinate translation, Fit circuit labels and explicit conversion from saved document previews. Root circuit rendering captures/rechecks the full hierarchy and retains prior previews on changed sheets. Document exporters keep native paper metadata. | Framing foundation implemented locally; 75 focused registry/framing/publication tests pass and actual KiCad circuit-vs-document check passes. Source-aware root/member page controls and full-source receipt checks are implemented locally; component/net selection, edit integration, linked views and native UI acceptance remain |
| #394 | Project-owned artwork persistence and session drafts exist; applying saved artwork to a real existing board remains incomplete. Preserve native circuitry and keep ownership explicit. | Planned |
| #395 | Monotone/multicolor, source-colored halftone and recoloring exist. Validate persistence and visual/export behavior; current color ZIP explicitly requires external EasyEDA processing and is not a production package. Verify current manufacturing requirements. | Planned with #394 |
| #415 | Multiple conversations/background jobs exist. Audit shared project updates/constraints and write coordination before adding UI; integrate with Activity rather than a parallel task system. | Planned |

No issue is closed yet. Existing partial implementations do not establish full acceptance.

## Publication checkpoint · 5 November

The user requested a remote push and a PR description with per-ticket screenshots. The [evidence index](EVIDENCE.md) distinguishes actual native captures from the current-build browser retest. #411 now has a visible RH Changes walkthrough in all three modes. #416 has a visible explicit circuit-conversion walkthrough; the broader working-circuit requirements remain incomplete. #412 has no completed focus UI screenshot and is explicitly pending rather than presented as fixed. #394, #395 and #415 have no new fixed-state screenshots because they remain planned.

Fresh publication validation: desktop build passed after all current code changes; UI/tools/client-core/core typechecks passed; no `.map` files were found in `apps/desktop/out`. All 57 recorded original native files and all 57 corresponding copied native files retained their recorded SHA-256 hashes after the screenshot retest. Existing focused test results below remain applicable; no implementation code changed during publication.

New usability finding: transparent native schematic colors have poor contrast on the dark canvas. The evidence capture uses the isolated test profile's Light theme; dark-theme readability remains open. The installed fabPlane app and its current project were not restarted or changed.

## Validation log

- #411: new concave/unordered-outline + separate-cutout comparison regression failed on main because `outlinePaths` was undefined after source composition. After retaining PCB-owned paths: 23 board-diff tests passed, 150 assertions. Highlights, Overlay and Side by side must contain only native edge paths; schematic comparisons must not draw PCB outlines. Native sources are read only.

## Remaining acceptance

Use visible native clicks and normal typing for representative root/member/multi-sheet and art-first/circuit-first journeys. Keep actual captures and source-preservation hashes; distinguish code tests and diagnostic generated artifacts from human UI success. Earlier native window returned stale captures during toolbar review; use a safe isolated test surface if needed and do not discard user unsaved changes to recover it.

- #417/#418: full client-core suite passes with temporary local socket permission: 528 tests, 2,561 assertions. Sandboxed run could not bind its transport test server (520 pass, setup/cleanup failures); no production code was changed for that environment restriction. Focused UI/tool tests, UI/client typechecks and desktop build also passed; native evidence and remaining cases are in HUMAN-TEST.md.

- #412: exact selected-page export uses KiCad's native UUID path and page number, remeasures the captured hierarchy, and rejects ambiguous/missing pages. Nine owned-render tests pass including installed KiCad all-page and selected-child exports (48 assertions). The earlier 5-second native integration timeout was increased to 30 seconds; no production timeout changed.
- Core member-focus regression verifies qualified child/preview paths, native byte preservation, stale choice rejection and changed-member/changed-child rejection. Client/store regressions cover complete-source hashes, declared ownership, explicit ambiguous-sheet choices, cross-core rejection, Return and manual navigation. Desktop build passed with no source maps. These checks do not establish visible UI acceptance.

- #416 native integration caught a whole-page SVG background preventing content crop; circuit mode now uses KiCad’s supported `--no-background-color` and `--exclude-drawing-sheet` together. The actual CLI test verifies tight root-sheet bounds and unchanged root/child/project bytes; full document rendering keeps page bounds and metadata. Original source geometry is not translated or rewritten. Legacy saved previews offer an explicit Open circuit view action; no background conversion of the existing session was triggered.
- The final desktop build after the transparent-background adjustment passed (1m26s), as did the tools typecheck. Current API/type checks and focused tests remain distinct from native app acceptance.

- #416 page identity checkpoint: circuit exports select each actual KiCad page from its captured instance table, rather than guessing from sorted filenames. Root and member previews retain native sheet identity/path/page, root receipts compare all recorded native sources before/after page downloads, repeated instances stay distinct, and page refresh preserves the selected native instance. Root/member navigation shares one selector; the assistant receives the visible sheet context. Existing root-only comment pins are not shown on unrelated child pages. Native document export remains unchanged.
- Validation: 22 focused root/member preview/publication/output-date tests passed (78 assertions); 11 owned-render tests passed including all three installed-KiCad tests (66 assertions). UI/tools/client/kicad/core typechecks passed. Desktop bundle passed before the final small header/viewport-key layout adjustments; final native UI acceptance is still pending. No issue is closed.
- App cleanup requested by the user: the isolated Followups app is closed. A second, older Electron development instance was found blank/unresponsive, ignored Quit and SIGTERM, and was force-closed by its verified PID. Installed `/Applications/fabPlane.app` remains open with the user's PlayBridge project. Test profiles, project/native files and evidence remain on disk. Do not relaunch extra native instances.
