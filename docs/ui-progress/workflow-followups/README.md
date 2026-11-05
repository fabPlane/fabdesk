# Workflow follow-ups · 5 November 2026

User-authorized work on issues #394, #395, #411, #412, #415, #416, #417 and #418. Branch `feat/canvas-workflow-followups` starts at main `4ddd358` (merged #389). Existing projects and all earlier evidence are preserved. Implementation is authorized; close an already-resolved issue only after its full acceptance is verified. New fixes should reference issues in the eventual PR and close on merge. No merge, deployment, order or payment is authorized.

## Dependency order and current audit

| Issue | Existing coverage / remaining work | State |
| --- | --- | --- |
| #411 | Parser has separate outline paths, but snapshot composition drops them before comparison rendering. Reproduced with a full comparison regression; preserve paths through all modes. | Implemented locally; 23 board-diff tests pass; real-source diagnostic passes; native Changes walkthrough still required |
| #418 | Added labeled included-board/hardware section, exact read files, per-build vs line counts and scoped schematic/Ask actions; partial quantities no longer claim complete coverage. | Implemented locally; unit/type/build checks pass; multi-board native walkthrough recorded, single-board 5-line/6-part and Open schematic retest passed; repeated-instance/hardware and Ask retests remain |
| #417 | Labeled Activity entry, modeless compact panel, consecutive read groups, measured outcomes, exact file actions, expandable run detail and older-history access. | Implemented locally; grouped-read/restart/result-model native walkthrough recorded; running/failed/cancel/keyboard and shared updates remain |
| #412 | Extended focus with captured member scope, native UUID/page identity, repeated-instance annotations/multi-units, source-backed choices, complete hierarchy hashes and previous view restoration. | Implemented locally; packaged-KiCad/core/client/store checks pass; visible member/repeated-sheet focus and viewport retest remain |
| #416 | Added transparent frame-free circuit exports, geometric content fit without coordinate translation, Fit circuit labels and explicit conversion from saved document previews. Root circuit rendering captures/rechecks the full hierarchy and retains prior previews on changed sheets. Document exporters keep native paper metadata. | Framing foundation implemented locally; 75 focused registry/framing/publication tests pass and actual KiCad circuit-vs-document check passes. Source-aware root page controls, component/net selection, edit integration, linked views and native UI acceptance remain |
| #394 | Project-owned artwork persistence and session drafts exist; applying saved artwork to a real existing board remains incomplete. Preserve native circuitry and keep ownership explicit. | Planned |
| #395 | Monotone/multicolor, source-colored halftone and recoloring exist. Validate persistence and visual/export behavior; current color ZIP explicitly requires external EasyEDA processing and is not a production package. Verify current manufacturing requirements. | Planned with #394 |
| #415 | Multiple conversations/background jobs exist. Audit shared project updates/constraints and write coordination before adding UI; integrate with Activity rather than a parallel task system. | Planned |

No issue is closed yet. Existing partial implementations do not establish full acceptance.

## Validation log

- #411: new concave/unordered-outline + separate-cutout comparison regression failed on main because `outlinePaths` was undefined after source composition. After retaining PCB-owned paths: 23 board-diff tests passed, 150 assertions. Highlights, Overlay and Side by side must contain only native edge paths; schematic comparisons must not draw PCB outlines. Native sources are read only.

## Remaining acceptance

Use visible native clicks and normal typing for representative root/member/multi-sheet and art-first/circuit-first journeys. Keep actual captures and source-preservation hashes; distinguish code tests and diagnostic generated artifacts from human UI success. Earlier native window returned stale captures during toolbar review; use a safe isolated test surface if needed and do not discard user unsaved changes to recover it.

- #417/#418: full client-core suite passes with temporary local socket permission: 528 tests, 2,561 assertions. Sandboxed run could not bind its transport test server (520 pass, setup/cleanup failures); no production code was changed for that environment restriction. Focused UI/tool tests, UI/client typechecks and desktop build also passed; native evidence and remaining cases are in HUMAN-TEST.md.

- #412: exact selected-page export uses KiCad's native UUID path and page number, remeasures the captured hierarchy, and rejects ambiguous/missing pages. Nine owned-render tests pass including installed KiCad all-page and selected-child exports (48 assertions). The earlier 5-second native integration timeout was increased to 30 seconds; no production timeout changed.
- Core member-focus regression verifies qualified child/preview paths, native byte preservation, stale choice rejection and changed-member/changed-child rejection. Client/store regressions cover complete-source hashes, declared ownership, explicit ambiguous-sheet choices, cross-core rejection, Return and manual navigation. Desktop build passed with no source maps. These checks do not establish visible UI acceptance.

- #416 native integration caught a whole-page SVG background preventing content crop; circuit mode now uses KiCad’s supported `--no-background-color` and `--exclude-drawing-sheet` together. The actual CLI test verifies tight root-sheet bounds and unchanged root/child/project bytes; full document rendering keeps page bounds and metadata. Original source geometry is not translated or rewritten. Legacy saved previews offer an explicit Open circuit view action; no background conversion of the existing session was triggered.
- The final desktop build after the transparent-background adjustment passed (1m26s), as did the tools typecheck. Current API/type checks and focused tests remain distinct from native app acceptance.
