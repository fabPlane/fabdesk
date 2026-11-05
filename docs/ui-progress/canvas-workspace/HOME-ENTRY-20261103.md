# Direct Home entry points · November 3, 2026

The user could not find the earlier Home → Projects → New project → art-board path. Add **New project** to the first Home header, beside Projects, using the existing setup dialog. Add **Start with artwork** beneath the Home composer, beside the sketch/image/import choices. It uses the existing artwork-project creation path, including the in-flight navigation guard and visible pending/error states. Existing project Start artwork access remains available. No engineering or teammate functionality changed.

## Human walkthrough

Actual Electron development app at localhost:5173, existing isolated test profile, 15 existing workspaces preserved. Navigated from Projects via its visible Home button, then tested the first Home without a project open. All journey interactions used visible controls; screenshots are unaltered. No route/API/state injection or agent request prepared the outcome.

| Step / visible action | Expected | Actual | Status / evidence |
| --- | --- | --- | --- |
| First Home, before change | Find project/artwork entry immediately | Neither entry was directly available | User-reported and reproduced; before-home.png |
| First Home, after change | Both entries visible without scrolling or Projects detour | New project in header; Start with artwork beneath composer | Passed; home-actions.png |
| New project | Open project setup | Existing name/location form opened; Create disabled for blank name | Passed; new-project-dialog.png |
| Cancel setup | Preserve Home and projects | Returned to Home, no project created | Passed |
| Start with artwork | Create an owning project and open Artwork | Pending label then Untitled art board opened on Artwork with upload, examples, saved-sketch area and corner assistant | Passed; artwork-opened-from-home.png |
| Ask fabPlane | Keep project/page context | Assistant opened; context label Boards / Artwork | Passed for opening/context label only; no message sent |
| Home → Close project | Return Home and retain project | Test art project appears in recent work; both new buttons remain visible | Passed; returned-home.png |

One empty test project was created by the real Artwork button and retained. Existing projects/files were not deleted or edited. New-project submission, artwork upload/edit/save, generation, exports and agent replies were not retested in this entry-only follow-up. No narrow-window or alternate-theme acceptance claimed.

## Change list / limits

- HE1, Home project discoverability: addressed; direct setup entry and Cancel checked.
- HE2, Home artwork discoverability: addressed; direct creation and Artwork destination checked.
- Native visual review caught a primary button rendered white-on-white by the header background rule during implementation. Using the standard header button treatment restored the readable label; the captured final Home confirms it.
- Follow-up observation: after entering the new project and returning Home, this profile showed Choose model rather than the initial Opus 5 label. No model preference was edited or message sent. Investigate selection lifetime against saved defaults separately before claiming agent-send acceptance; this follow-up does not establish its cause.

## Checks / publication

UI typecheck passed. UI tests: **282 passed, 0 failed, 1,199 assertions**. git diff --check passed. No production build or hosted CI rerun for these entry links. Existing CI credential-checkout failure remains separate (local work/BUILD-FAILURE-20261103.md).

Evidence: [home-entry-20261103](home-entry-20261103/) and SHA256SUMS. Local commit only; remote PR remains at 8e294df. App left on first Home with no project open. Broader roadmap and teammate exclusions remain unfinished/separate.
