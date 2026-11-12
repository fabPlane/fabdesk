# Packaged startup and Flow 22 — November 12, 2026

Follow-up to [sharing acceptance #444](https://github.com/TensorFleet/fabdesk/issues/444), using the human-test skill. **Flow 22 remains partial.** Protocol handoff is not established by an automated queue test or by normal app launch.

## Build and setup

- Freshly fetched desktop main `39c55033fb1bbbf80b2b67cab35604ce76477ba7`; startup fix on `fix/packaged-cad-startup`.
- Website/API main `6276ce8ba364c9e70085bd4ca847951c4dfaf239` (PR #200 merged). Browser rebuilt and local API restarted from this main.
- macOS ARM64, Electron 44.1.1, internal-channel ad-hoc signed directory package, local API4202/browser5195, persisted synthetic QA database/storage. No production services were changed.
- Fresh Electron profile, fresh core home and empty project directory for first launch; then the existing isolated sharing Owner profile for navigation. Real user folders preserved.
- The QA entry sets only local API/browser origins, profile/home/project directories and internal test identity. Built main, preload, renderer and normal bundled-core/PCB resolution remain intact. **No optional CAD skip, installed-PCB path override, clipboard interceptor, filesystem shim or debug-console wrapper.**
- The core was compiled from desktop main for this run; the main-process startup fix is packaged separately with it. ASAR main matches the built output; zero source maps. Ad-hoc signature verification passed. This does not verify a downloaded/notarized DMG or a production release.

## Baseline and fix

A clean rebuild of unmodified main opened Home and the existing project without the earlier QA workarounds. The old instrumented artifact's stall could not be reproduced; its precise cause remains unproven. An initial sandboxed packaging attempt failed codesign and was discarded as acceptance evidence. Packaging was completed and signed before final UI testing.

The production bootstrap nevertheless awaited optional CAD discovery before creating the window or starting core. That discovery can scan a runtime and run macOS signature checks. It now starts after window/core startup. Explicit first CAD use and background discovery share one initialization, including verification and activation. Activation waits for the initial core handshake and checks shutdown before starting/restarting services. Signature checks and consent-gated downloads remain required.

## Human walkthrough

| Step | Visible action / path | Expected outcome | Actual result | Status | Evidence / friction |
|---|---|---|---|---|---|
| 1 | Launch completed signed package with fresh profile | Responsive Home without optional CAD | Home loaded, local core ready, empty projects | Passed | [Fresh Home](screenshots/03-fixed-fresh-home.jpg) |
| 2 | Home → New project → enter name → Create project | Core creates real local project | “Flow22 cold startup” opened | Passed | [Created project](screenshots/04-fixed-created-project.jpg) |
| 3 | Application menu → Quit; launch again | Saved project restores without hang | Same project reopened and navigation worked | Passed | [Restored project](screenshots/05-fixed-project-restored.jpg) |
| 4 | Disclosed empty invalid cached CAD app; cold launch → Mechanical → More tools → Advanced CAD | Invalid signature cannot block PCB or activate CAD | Project usable; CAD error shown, no Download button; Later/Close worked | Passed with friction | [CAD failure](screenshots/06-invalid-cad-stays-optional.jpg). Raw diagnostic text is verbose and assistant overlaps this unrelated CAD modal. Suggested separate CAD follow-up: concise error/expandable details and hide assistant behind modal. Empty fixture removed after quitting. This is not a valid CAD installation test. |
| 5 | Quit; select existing synthetic Owner profile; launch → Home → Alpha → Share | Existing data intact; sharing usable without workarounds | Five-board Alpha opened; invited access and aligned links shown | Passed | [Sharing dialog](screenshots/07-fixed-sharing-dialog.jpg) |
| 6 | Desktop Open shared page | Correct Alpha online destination; no access bypass | OS-default Chrome opened exact project; existing Outsider session was denied | Passed | Correct account required |
| 7 | Check your account → Sign out → local Owner sign-in | Original project preserved | Alpha Status opened as Owner | Passed with friction | [Destination](screenshots/08-native-link-owner-destination.jpg). Browser connection detached during initial email typing; incomplete entry was rejected. Re-entering complete fields worked. Local password failure left an auth_error query after recovery; third-party OAuth not tested. |
| 8 | Desktop Manage people online | Same project's access dialog, separate from published page | Projects opened with Alpha Share dialog, Owner/Viewer/Contributor controls | Passed | [People destination](screenshots/09-native-people-destination.jpg) |
| 9 | Private project page → sign out → local Viewer sign-in → Status → board → 3D → All boards | Correct project, read-only access, no unsupported editable handoff | Viewer returned to Alpha; board/check and honest no-model state; no file-management/publish/Open in fabPlane action | Passed | [Viewer Status](screenshots/10-private-viewer-status.jpg). Current Alpha snapshot has no saved models; interactive saved-3D coverage from the earlier 23-flow run is not re-claimed here. |
| 10 | Owner changes synthetic Alpha link access to Anyone with the link; Open public link | Public page offers desktop opening and download guidance | Correct public Status with Open in fabPlane and Get desktop app | Passed (affordances only) | [Public affordance](screenshots/11-public-handoff-awaiting-manual.jpg); protocol action itself not exercised by the agent |
| 11 | Public Open in fabPlane, app running | OS handoff reaches correct desktop project | Manual result pending; prior browser safety rejection prevents tool action | Blocked | No alternate-browser, shell protocol invocation or indirect bypass attempted |
| 12 | Public Open in fabPlane, app closed / unavailable | Cold handoff or appropriate download guidance | Not demonstrated | Blocked | App cold launch alone does not check these cases |

## Validation

- Desktop scoped typecheck and production renderer/main build passed; browser production build from main passed.
- Workspace suites: **2,973 passed, 38 skipped, zero failed**, including all 154 desktop tests and the two new concurrency/signature regressions.
- Full root command initially failed only the unrelated real macOS Python.framework signing fixture's 5-second timeout. Entire scripts suite rerun with `bun test ./scripts/test --timeout 20000`: **95 passed, zero failed**. Combined passing coverage: 3,068 tests /38 skips. No timeout change committed.
- Initial sandboxed CAD supervisor fixtures could not listen on loopback; repository suites were run with authorized local fixture access. Test-generated Python bytecode restored.
- Packaged app passed `codesign --verify --deep --strict`; ASAR main equals built main and contains no `.map` files. Signature trust for a real downloaded CAD engine, notarization, installation/update delivery and production OAuth/deployment remain untested.

## Remaining manual acceptance

- [x] Clean packaged startup with fresh profile and existing test profile, no CAD or PCB workaround.
- [x] Quit/reopen preserves a project.
- [x] Invalid optional CAD is rejected without blocking project use.
- [x] Desktop web destinations and project-preserving local sign-in.
- [x] Private Viewer browsing stays read-only and has no unsupported handoff promise.
- [ ] Supported public protocol handoff with app running.
- [ ] Supported public protocol handoff with app closed.
- [ ] App unavailable/not-installed outcome and download recovery.
- [ ] Downloaded, notarized installer acceptance / production deployment.

Keep #444 open and Flow22 unchecked until the protocol variants are observed. A manual click was requested because the earlier browser safety rejection remains in force.

## Final local state

One current packaged QA app remains on [Alpha Status](screenshots/12-final-native-status.jpg), using its bundled PCB engine. The fresh-profile invalid CAD fixture was removed. Existing test files were preserved. Native sharing visibility refreshed after the website change and correctly showed Anyone with the link.

The local synthetic Alpha public page is left open in Chrome for the optional manual protocol click; the separate in-app browser remains a Viewer on private project Status. This is loopback QA data, not an Internet publication. No manual handoff result had arrived at report time; all protocol boxes remain unchecked. The intermediate Chrome login tab was closed. No changes were made to project roles or editable-file permissions.
