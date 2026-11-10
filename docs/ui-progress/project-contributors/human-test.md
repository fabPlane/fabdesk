# Contributor MVP: human walkthrough

Tested 2026-11-10 with CUA in a separately packaged fabPlane profile, copied three-board fixture and disposable local API4200/browser5193/PostgreSQL55441. All accounts and boards were synthetic. No production services, real invitations or user design projects were changed. Fixture provisioning was separate from UI steps. Desktop source became e3f4fd78; backend base15513f1 plus8a4021d/54dc4e0; SDK a40a0d0. UI captures come from the actual built app, not generated mockups.

| Step | Visible action / path | Expected outcome | Actual result | Status | Evidence / friction |
| --- | --- | --- | --- | --- | --- |
| Baseline | Existing #434 desktop Share / web Share | Preserve current UI | Actual baseline dialogs captured | Passed | before-desktop-share.png, before-web-access.png |
| Restricted publication | Home → copied project → Share → Invited people → Publish | Three-board member-only snapshot | Restricted link and web project list confirmed | Passed | No prepublication API setup |
| Editable opt-in | Share → More options → Editable boards → Main controller → Confirm | Only one native board shared | Publisher/time and Publish update shown;2boards remain unshared | Passed | after-desktop-editable-boards.png |
| Invitation | Web Projects → Share → email + Contributor → Invite → Copy | Manual verified-email invitation | Contributor pending;7day/email guidance; Copied! | Passed | No email delivery is implemented or claimed |
| Acceptance | Open copied invitation → normal sign-in → Accept | Scope explained before joining | Explicit Contributor rights and restrictions; published project opens | Passed | after-contributor-invitation.png |
| Desktop identity | Settings → Account → Leave local mode → Sign out → staging/local password login | Invited account used by desktop | Contribution QA contributor signed in | Passed with friction | CUA stale/offscreen indices resolved by rebinding exact test app; no code/auth bypass |
| Shared library | Home → Projects → Shared projects | Only permitted editable copies | Main controller enabled;2unshared boards disabled | Passed | after-desktop-shared-projects.png |
| Local copy | Open editable copy | Fresh local project, existing files kept | Separate project created; saved PCB preview generated; placement workspace opens | Passed | Canonical PCB editing itself was not exercised; placement is a separate draft, file preview read-only |
| Native download | Web Editable boards → Download KiCad files | Usable native archive | Actual Downloads/fabplane-board.zip; CRC/native header/filename allowlist verified afterward | Passed | This fixture has a PCB only; optional schematic inclusion also unit-tested |
| Contributor publish | Copy toolbar Publish → Publish update → Confirm | Only that board advances | Contributor shown as publisher; other boards/access preserved | Passed | after-desktop-contributor-published.png; published unchanged native contents, not a claimed new layout edit |
| Encrypted round trip | Shared projects → Open editable copy after publication | Authorized encrypted source read | Second copy downloads and produces PCB preview | Passed | QA server restarted explicitly to load encryption; disposable memory cache reset; new publication repopulated encrypted artifact |
| Stale revision | Publish second copy → reopen first → Publish | No overwrite of newer revision | No Publish action; newer-copy message and Get latest copy | Passed | after-desktop-stale-copy.png |
| Recovery, original | Get latest copy | Open fresh project safely | Copy saved but existing switch guard led to Home | Failed, then fixed | Added explicit open-copy confirmation using existing unfinished-edit guard |
| Recovery, retest | Get latest copy → Open downloaded copy | New project opens, old stays intact | Opens new Main controller PCB workspace directly | Passed | after-desktop-open-new-copy.png;4separate IDs/folders; original base and PCB hashes unchanged |
| Role downgrade | Owner web role → Viewer; native copy Publish | Remove future editable access | Native Viewer explanation, no download/publish actions; Contributor restored afterward | Passed | Backend also tests remove/unpublish, mid-upload and mid-download revocation |
| Shared with me | Web Projects → Shared with me | Contributor projects listed | Correct role/owner/publication displayed | Passed | after-web-shared-with-me.png |
| Mobile role field | Share dialog at405×900 | Arrow contained in field | Initial detached chevron; width fix retested aligned | Passed after fix | before-mobile-role-arrow.png, after-mobile-role-arrow.png |
| Unchanged board | Published project → Power & USB-C →3D | Other board unaffected by publication | Saved3D model renders | Passed | No project-wide overwrite |
| Browser desktop handoff | Open in fabPlane desktop | OS custom app link | Browser-tool security blocked navigation | Blocked | No workaround attempted; validated ID-only intent with unit tests and native flow separately |
| Deployment | Real staging/production auth and storage | Deployed integration | No deployment performed | Not tested | Requires migrations0016/0017 and stable server-only PROJECT_SOURCE_ENCRYPTION_KEY |

## Findings and fixes

- P1: recovery created the copy but lost the intended navigation at the Home guard. Fixed with an explicit Open downloaded copy dialog; unfinished-edit checks remain enforced. Retest reached the new PCB workspace and artifact verification confirmed old copies/base receipts stayed intact.
- P1: imported copies initially inherited owner-only Share settings, hiding contribution publication. Their toolbar now says Publish and opens per-board publication directly. Verified with a real accepted Contributor account.
- P2: Viewer downgrade still offered Get latest copy. Removed that action and added a clear Viewer explanation. Live role-change retest passed.
- P2: View only and owner-only update wording confused Contributor rights. Replaced with Published snapshot and owner/Contributor update wording.
- P2: schematic-only download action could fail when no schematic existed. Replaced with one native ZIP containing exactly the available allowed files; actual browser download and independent ZIP validation passed.
- P2: mobile invite-role chevron sat outside the select. Made its select fill the stacked field; actual405px before/after captures verified alignment.

## Verification and limits

SDK184tests passed. Backend/API/config/browser ZIP regression161tests passed; subsequent focused encrypted-source suite10tests/120assertions passed (including missing-key fail-closed and mid-download revocation). Desktop sharing/source/deep-link suite26tests/104assertions and navigation-store36tests/247assertions passed. API, browser, core and desktop typechecks/builds checked separately; exact logs are in the local run directory/checkpoint. The initial SDK sandbox run could not bind loopback; the permitted full rerun passed184/184.

No realtime collaboration, forced overwrites, project-wide merging, history browsing UI or automatic pull into original multi-board working folders is included. Latest remote boards open as separate local projects. Source bundles contain a KiCad PCB and optional saved schematic, not custom libraries, native project settings, external3D assets, scripts or chats. Saved outputs missing from a publishing copy are not carried over. Already downloaded copies cannot be recalled.

Remaining acceptance: real staging provisioning/storage/auth; browser-to-installed-app handoff on a browser that permits it; deployment/production smoke only after explicit production approval. Canonical native editing was not a human-tested step here; automated tests cover changed file bytes and source mutation during capture. A generated preview and opened placement workspace do not claim a new canonical layout edit.
