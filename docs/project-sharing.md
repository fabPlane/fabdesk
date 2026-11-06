# Project link sharing (desktop first)

The project header's **Share** action opens the Private / Anyone with the link dialog. The existing review ZIP is a separate secondary action. **Preview shared page** builds a local snapshot without publishing or requiring a cloud account.

Publishing and reading hosted links require the companion backend in [fabplane.com#185](https://github.com/TensorFleet/fabplane.com/issues/185). This desktop change does not deploy or implement that server. Missing endpoints fail visibly; a 404 must never be interpreted as confirmation that an existing share is private. No placeholder URLs or local-only sharing preferences are persisted.

## Contents

The `fabplane.project-share.v1` contract is defined in `packages/protocol/src/project-sharing.ts`. It contains the project name, capture time, declared board sources, PNG previews and summarized saved PCB checks. Board sources are not duplicated for repeated physical instances.

`prepareProjectShare` resolves independently owned native boards, reads only the known `renders/pcb.svg` and `reports/drc.json` for each available source, and rasterizes the drawing to PNG. It strips report descriptions, paths, credentials, native design files, notes and chat history by constructing an explicit allowlist. A missing report is not a claim that DRC never ran. A report is current only when its saved PCB hash matches; assembly reports must additionally match project/source/manifest identity. Image freshness remains unverified.

Publication rechecks source membership, PCB hashes, preview bytes and report bytes after capture. Changed files abort the operation. Preview images are capped at 6 MiB each, 20 MiB total before base64 encoding. The current contract does not publish models, BOMs, manufacturing outputs or native source archives.

## Companion API contract

Cloud calls live in `fabPlane/fabplane-cli`; the renderer calls the daemon, which retains the cloud token. No team or organization selection is required for sharing.

| Cloud endpoint | Behavior |
| --- | --- |
| `GET /v1/private/project-shares/:localProjectId` | Owner-scoped settings; returns `{visibility:"private"}` when sharing is disabled or absent. |
| `PUT /v1/private/project-shares/:localProjectId` | JSON `ProjectShareSnapshot`; atomically replaces the active snapshot after the whole request is validated/stored. |
| `DELETE /v1/private/project-shares/:localProjectId` | Revokes visitor access, idempotently returns `{visibility:"private"}`. |
| `GET /v1/public/project-shares/:shareId` | Anonymous, active unlisted snapshot only; returns `SharedProject`. |

A successful publish returns `{visibility:"unlisted", shareId, publishedAt, revision}`. The ID is opaque, 16–80 URL-safe characters. Owner routes must scope the desktop project ID to the authenticated owner, and verify ownership on every request. Public reads must enforce active sharing, avoid public discovery, and use `Cache-Control: no-store`. Failed publishes must preserve the last working snapshot. Allow approximately 28 MiB of JSON for the 20 MiB binary preview budget, plus metadata. Server-side limits and validation remain mandatory.

The server must enforce revocation for both page data and previews. Inline PNGs avoid permanent asset URLs in this initial contract. Previously downloaded copies cannot be recalled. A future revision may use separately authorized asset endpoints.

Local daemon routes are `/projects/:id/share` (GET/PUT/DELETE), `/projects/:id/share/preview` (POST), and `/shared-projects/:shareId` (GET). Owner mutations require a cloud account. Visitor reads deliberately construct an anonymous SDK client. All daemon routes retain the daemon's normal access control. Overlapping local publish/disable operations for one project return 409.

## Opening in the desktop app

The hosted viewer should offer `fabplane://share/<shareId>`. Electron validates the scheme, host and ID, queues cold-start links, and passes the ID to a dedicated read-only dialog. HTTPS links on the exact `https://app.fabplane.com/share/<shareId>` origin/path are also recognized when delivered to the app. Incoming links cannot select an arbitrary API origin or supply file paths.

The dialog fetches the public snapshot using the daemon's configured cloud origin, shows the published revision, and supports board details / All boards. It does not import a project, touch local boards, or allow editing. It does not persist snapshots, and a failed refresh hides previously loaded content. While open it rechecks access every minute; an already downloaded image cannot be recalled immediately.

Generated browser URLs use the app origin from the existing auth state's dashboard URL (production defaults to `https://app.fabplane.com`). The web route and its **Open in fabPlane** button remain work for the companion repository.
