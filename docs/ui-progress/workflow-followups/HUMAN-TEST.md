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
