# Human walkthrough · 5 November 2026

This is a focused implementation retest, not full app acceptance. Two projects were copied from the earlier disposable acceptance workspace to `work/workflow-followups-20261105/projects`; only project registration and terminal job history were seeded into a separate core DB, with absolute result paths remapped to the copies. No chats, credentials, or active jobs were copied. Setup is not counted as a UI import journey. Original native file hashes are checked in `source-preservation.json`.

The first native binding selected the existing VAIO app. Only read-only Activity/Parts navigation was used; no design changes or unsaved work was discarded. Actual screenshots `01`–`03` are from that existing session. A distinct local test app bundle then allowed explicit selection of the isolated profile; screenshots `04` onward are from the labeled copy. Native coordinate scrolling initially targeted the background canvas (zoom changed); AX-scoped scrolling correctly scrolled the task panel. This is tool targeting friction, not evidence of a broken scroll panel.

| Step | Visible action | Expected | Actual | Status / evidence |
| --- | --- | --- | --- | --- |
| Activity discovery | Click labeled Activity in header | Inspect work without leaving canvas | Compact right panel, no backdrop, underlying Fit sheet still usable | Passed; `02-activity-theme-and-canvas-interaction.png` |
| Visual consistency | Open Activity | Same workspace palette | First portal version inherited the old app palette; moved inside workspace theme and retested | Fixed after observed friction; `01` before / `02` after |
| Partial BOM | Workspace menu → Parts → expand Included boards & hardware | Identify quantities and affected boards | 14 lines / 22 included parts, five of six designs need attention, I/O native files explicitly listed | Passed with initial wording friction, corrected; `03-bom-origins-vaio-incomplete.png` |
| Result navigation | Home → labeled VAIO copy → Activity → Open parts | Open Parts | Parts opens and reads source coverage; no design write | Passed in isolated app; earlier hot-reload session did not navigate on first AX activation, so that attempt is not a pass |
| Read grouping | Activity → expand Read project BOM | Inspect each real attempt | Two consecutive reads remain separately timestamped with individual actions/details | Passed; `04-isolated-grouped-bom-reads.png` |
| Restart | Restart only isolated app, reopen Activity | Keep recorded tasks and groups | 24 terminal tasks still available and reads still grouped | Passed; native AX observation |
| Exact artifact | Activity → first model task → Open saved file → Preview model | Correct GLB, real viewer | Exact recorded UUID GLB selected in Files and opened | Passed; `06-isolated-activity-model-result.png` |
| 3D launch configuration | First test app had `--disable-gpu` | Display model | WebGL could not initialize; this test-launch restriction was removed, normal graphics renders actual GLB | Test environment limitation resolved; `05` limitation / `06` successful rendering |

## Remaining tests / change list

- #418: single-board five-line/six-part example, repeated instances plus hardware, correct-source Open schematic and Ask context, collapse/reopen quantity preservation still need native retests. Missing hardware error in the hot-reload original app did not recur in the fresh built test process; no production 404 behavior was changed on that evidence alone.
- #417: failed/queued/running/waiting/cancel states and keyboard restoration need native retests. Exact path, foreign project rejection, invalid path rejection and grouping scope are covered by client tests, not claimed as completed UI journeys. Shared updates/conversation coordination remain #415 work.
- #411: synthetic concave/cutout regression and actual RH source full comparison pipeline passed all three modes. UI revision-comparison retest remains; diagnostic evidence is explicitly labeled.
- #412/#416, #394/#395 and #415 remain unfinished. No issue has been closed and no complete-app claim is made.

## Follow-up checkpoint

- Single-board copy: Home → Button light → Parts → Included boards & hardware displayed **5 lines / 6 on-board parts / 1 board / 0 hardware**. Build quantity 5 displayed 30 parts. Native schematic and project metadata were explicitly listed. **Open schematic** selected the same root schematic. Passed; `07-single-board-five-lines-six-parts.png`.
- The separate **FabPlane Followups** test process was stopped at the user's request to keep one app. Its profile, copied projects, terminal task history and evidence remain on disk. The existing main Electron app was left running with its open work preserved; app inventory verified the test app was no longer running.
- Main app's long-lived hot-reload session still has the earlier hardware-file 404 notice and a source action focused without navigating. A clean built copy previously completed that action. These attempts are not counted as successful navigation and are not proof of a production failure. Do not reload/discard the main session's unsaved work to conceal the observation.
- #412 implementation has automated source-scope/choice/return checks and actual packaged-KiCad page-export checks, **not yet a completed human focus walkthrough**. Member/repeated-sheet focus, choice buttons, prior-sheet/viewport restoration and changing a child sheet while focus is open must still be exercised visibly in a clean app session. The current main process has not been restarted onto the updated core.


### User-requested single-app cleanup

Native inventory confirmed the isolated Followups app was stopped, but also showed an older Electron development app and installed fabPlane. The installed app showed `PlayBridge V3.0 PS1 serial harness` in Parts. The development window was blank; menu Quit and SIGTERM did not exit it. Its exact main PID was verified and force-closed. A subsequent native inventory showed installed fabPlane running and neither Electron nor Followups running. No saved profile/project files were removed. This is environment cleanup, not a passing schematic journey.

The new native-page selectors, complete root preview receipts, child-sheet assistant context and stale-source recovery have code/native-export tests, but have **not** yet passed a visible UI journey on this branch. The installed app is an older build and was not modified to claim a test pass.

## Publication retest · current branch renderer

To honor the request to keep one native app, this retest used the current branch's browser renderer connected to the existing isolated developer core/profile on loopback. The test setup is not a fresh-user import test. No credentials/chats were copied. The installed app was untouched. Screenshots contain the app content only, without the temporary test connection URL.

| Journey | Visible actions and result | Evidence / limit |
| --- | --- | --- |
| #416 root circuit canvas | Home → copied Button light project → Schematic → Open circuit view. Native render completed, status became “Saved native sheets match this drawing”, viewport fitted circuitry, and paper frame was absent. | `08-circuit-canvas-current-build.png`; passed this limited root conversion flow. No component/net editing or multi-sheet focus acceptance implied. |
| #411 real member comparison | Home → copied VAIO project → RH port → Open board → Review → Changes → Compare → Highlights / Overlay / Side by side. Actual saved comparison and native RH outline displayed in every mode. | `09`–`11`; complements the full-pipeline native-path diagnostic and regression tests. No part/net edits were introduced for screenshots. |
| #412 native focus | No assistant focus request was submitted during publication. | Still requires visible repeated-sheet choices, focus navigation, Return/viewport restoration and stale-child tests. No fixed-focus screenshot is claimed. |

Usability/change-list finding: native transparent circuit colors are difficult to read on the dark canvas. Switched only the isolated profile through Settings → Appearance → Light → Save for readable evidence. Dark-theme schematic contrast needs a dedicated follow-up; this is not treated as resolved by changing the screenshot theme.

After these actions, all 10 VAIO and 47 Button light original native files and their copied counterparts matched the setup hashes. Rendering/comparison produced artifacts only. The source-preservation receipt was refreshed. The final desktop build and fresh typechecks passed; no shipped source maps were found. This remains focused acceptance rather than a complete-app test.


## Parts sources and long-table follow-up · #425

Setup (not a human import test): created a disposable project through the local project service, copied three unchanged Button light KiCad files and added 240 clearly labeled synthetic hardware rows. The resulting 245 BOM lines / 726 parts per build are layout data, not supplier or engineering acceptance. Only that fixture's hardware file was temporarily made malformed for recovery testing. Existing project/native files were not edited.

The current branch was built and run as the single native Followups desktop app. All test navigation used visible native clicks, ordinary typing, scrolling and the visible View menu. No hidden route or API counted as a user journey.

| Journey | Actual result |
| --- | --- |
| Long list | Scroll from header through 245 rows; intro/build/source sections scroll away, search/filters and column headings stay visible. Final H240 is reachable with clearance above the assistant. Passed. |
| Category | Fasteners shows 80 of 245 lines. Category chips stay available while scrolling. Passed. |
| Empty result | A nonmatching query produced a clear empty state. Show all parts cleared both query and category and returned the complete 245-line table. Passed. |
| Keyboard | Tab from Search BOM focused Filter parts. Native AX exposed one actual data table with column headers; visual sticky copy is hidden from accessibility. Screen-reader speech was not tested. |
| Leave/return | In the initial native retest, query TEST-0240 and build quantity 12 survived Files → Back. Page/horizontal restoration receives an additional final-build retest below. |

Observed friction corrected during testing: multi-digit row numbers wrapped; old toolbar padding left an empty gap beneath sticky headings; native right-arrow scrolling could also shift the outer page; two failures for the same unreadable hardware source produced redundant banners. The implementation now prevents wrapping/gaps, confines keyboard horizontal movement to the table and combines hardware recovery feedback. Some CUA actions were interrupted by detected manual input and retried only after refreshing current state; interrupted attempts are not passes.

Limits: this is focused Parts acceptance, not full app/order readiness. Repeated physical board instances have calculation tests but no new native fixture walkthrough. No real supplier sourcing, manufacturing export, native design edit, payment or order was performed. Session state retention does not imply retention after a full app restart.


Final retest:
- Native window narrowed to approximately 990 × 735 at 110% interface scale. Right-arrow navigation in the focused table reached part-number/remove columns while the search/filter toolbar stayed fixed. Headings remained aligned. Files → Back restored the same H17 vicinity and horizontal offset (`17`, `18`). Desktop chrome did not scroll horizontally. Standard-scale 1440 × 920 browsing and final row were captured separately (`14`, `15`).
- Hardware failure: temporarily malformed only the disposable fixture file. One compact warning showed the affected file, paused editing, Retry and collapsed technical details; cached counts were explicitly marked Last read (`19`). Clicking Retry visibly started Reading sources and did not suppress the failure. Restoring the original fixture file let the watcher re-read it: warning cleared, 245 lines/726 parts and export availability returned. This is watcher recovery, not a claim that Retry repaired a file.
- Single board: 5 BOM lines / 6 parts, 5 builds → 30 parts. Expanded Parts sources has one Main board row, Schematic read, Source files, Open schematic and contextual Ask; hardware reads None added (`13`). Source files exposed the actual board.kicad_sch and board.kicad_pro. Ask opened an unsent question with Parts / Main board attached context. No agent message sent. Open schematic reached the native root drawing; Back returned to expanded Parts sources. Quantity remained 5.
- Multi-board: 6 boards / 5 need review; affected boards appear first, with specific missing schematic/netlist or unresolved-source explanations and Get help (`20`). Complete-build coverage was not claimed. These boards were not invented or repaired for testing.

All original 10 VAIO and 47 Button light native files and their copied counterparts remained byte-identical. The synthetic fixture's three native files remained unchanged, and its hardware file was restored byte-for-byte from backup. Desktop build, UI typecheck and 10 focused BOM/state checks passed. No packaged source maps were found. See the later full UI test result in the publication checkpoint.


Validation: desktop production build passed; UI typecheck passed; all 369 UI tests passed (0 failures), plus the focused BOM-origin checks (10 combined BOM/state checks passed). No packaged source maps; git diff --check clean. Native evidence includes narrow/110% layout, filters, empty recovery, final-row clearance, navigation/Back, source actions and malformed-hardware recovery.
