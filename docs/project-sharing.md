# Project link sharing (desktop first)

The project header's **Share** action opens the Private / Anyone with the link dialog. The existing review ZIP is a separate secondary action. **Preview shared page** builds a local snapshot without publishing or requiring a cloud account.

The header uses one compact control: **Share** for a private project, or **Shared** with a subtle green treatment when a link is active. Both open the same sharing settings. The tooltip and accessible name describe actual saved visibility; pending checks show a spinner and failed checks show a warning icon. The control updates after a successful save and on the existing background access check; unsaved dialog choices do not change it. A successful copy changes the dialog's copy button to a green checkmark and **Copied!** for three seconds, with an accessible announcement.

The compact dialog uses a **Who can view** dropdown and makes **Copy link** the primary action for an existing link. **More options** contains the local preview, review ZIP and publication details. Creating a link, updating its saved snapshot or disabling access remains explicit; choosing Private does not revoke until **Save changes** succeeds.

Publishing and reading hosted links require the companion backend in [fabplane.com#185](https://github.com/TensorFleet/fabplane.com/issues/185). This desktop change does not deploy or implement that server. Missing endpoints fail visibly; a 404 must never be interpreted as confirmation that an existing share is private. No placeholder URLs or local-only sharing preferences are persisted.

## Contents

The `fabplane.project-share.v1` contract is defined in `packages/protocol/src/project-sharing.ts`. It contains the project name, capture time, declared board sources, PNG previews, optional sanitized saved GLB geometry and summarized saved PCB checks. Board sources are not duplicated for repeated physical instances.

`prepareProjectShare` resolves independently owned native boards, reads only the known `renders/pcb.svg` and `reports/drc.json` for each available source, and rasterizes the drawing to PNG. It strips report descriptions, paths, credentials, native design files, notes and chat history by constructing an explicit allowlist. A missing report is not a claim that DRC never ran. A report is current only when its saved PCB hash matches; assembly reports must additionally match project/source/manifest identity. Image freshness remains unverified.

Publication rechecks source membership, PCB hashes, preview, model and report bytes after capture. Changed files abort the operation. PNG previews are capped at 6 MiB each and models at 10 MiB each; the combined decoded budget is 20 MiB. Only the known `renders/board.glb` is captured. GLB JSON is rebuilt from static geometry/material allowlists, removing names, extras, textures and external resources. Missing models are allowed; publishing does not generate them. BOMs, manufacturing outputs and native source archives are excluded.

## Companion API contract

Cloud calls live in `fabPlane/fabplane-cli`; the renderer calls the daemon, which retains the cloud token. No team or organization selection is required for sharing.

| Cloud endpoint                                      | Behavior                                                                                                          |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `GET /v1/public/project-shares/:shareId/status`     | Anonymous active revision metadata, or 404 after revocation.                                                      |
| `GET /v1/private/project-shares/:localProjectId`    | Owner-scoped settings; returns `{visibility:"private"}` when sharing is disabled or absent.                       |
| `PUT /v1/private/project-shares/:localProjectId`    | JSON `ProjectShareSnapshot`; atomically replaces the active snapshot after the whole request is validated/stored. |
| `DELETE /v1/private/project-shares/:localProjectId` | Revokes visitor access, idempotently returns `{visibility:"private"}`.                                            |
| `GET /v1/public/project-shares/:shareId`            | Anonymous, active unlisted snapshot only; returns `SharedProject`.                                                |

A successful publish returns `{visibility:"unlisted", shareId, publishedAt, revision}`. The ID is opaque, 16–80 URL-safe characters. Owner routes must scope the desktop project ID to the authenticated owner, and verify ownership on every request. Public reads must enforce active sharing, avoid public discovery, and use `Cache-Control: no-store`. Failed publishes must preserve the last working snapshot. Allow approximately 28 MiB of JSON for the 20 MiB binary preview budget, plus metadata. Server-side limits and validation remain mandatory.

The server must enforce revocation for both page data and previews. Inline PNGs and GLBs avoid permanent asset URLs. Previously downloaded copies cannot be recalled. A future revision may use separately authorized asset endpoints.

Local daemon routes are `/projects/:id/share` (GET/PUT/DELETE), `/projects/:id/share/preview` (POST), and `/shared-projects/:shareId` (GET). Owner mutations require a cloud account. Visitor reads deliberately construct an anonymous SDK client. All daemon routes retain the daemon's normal access control. Overlapping local publish/disable operations for one project return 409.

## Opening in the desktop app

The hosted viewer should offer `fabplane://share/<shareId>`. Electron validates the scheme, host and ID, queues cold-start links, and passes the ID to a dedicated read-only dialog. HTTPS links on the exact `https://app.fabplane.com/share/<shareId>` origin/path are also recognized when delivered to the app. Incoming links cannot select an arbitrary API origin or supply file paths.

The dialog fetches the public snapshot using the daemon's configured cloud origin, shows the published revision, and supports board details / All boards and PCB/3D views. It does not import a project, touch local boards, or allow editing. It does not persist snapshots. While open it rechecks active revision metadata every five seconds, including in background windows; failure clears loaded content. Previously downloaded copies cannot be recalled.

Generated browser URLs use the app origin from the existing auth state's dashboard URL (production defaults to `https://app.fabplane.com`). `FABPLANE_APP_ORIGIN` overrides this for local/staging integration. The companion browser PR adds this route, saved board 3D, existing app navigation/auth and an owner-only Projects page with Make private. Desktop settings refresh after browser revocation.

## Integration evidence

A normally packaged Electron app with a unique test identifier and ad-hoc signature was exercised through visible UI with the real compiled core. Chrome's Open in fabPlane launched the closed app into the matching read-only snapshot; its saved board model rendered. Browser Make private then removed the model from the open native viewer. The earlier manually assembled Electron bundle failure did not reproduce with the repository packager. Test-only origin/profile setup remains outside tracked source. Notarized installers and deployed staging remain release checks.

The companion API's full suite passed on a fresh PostgreSQL 17.6 server with pgcrypto (380 passed, 4 skipped), including sharing revocation and concurrent database tests. Deployed staging validation was blocked by missing/offline GitHub runners; the task-owned queued deployment was cancelled without changing staging.

Publication/copy confirmations are scoped to the server sharing revision. External revocation or a newer publication hides an obsolete confirmation. Both visitor access checks and owner settings refresh in the background, so returning to an occluded window does not rely only on a focus event.
