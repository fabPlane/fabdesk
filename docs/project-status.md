# Project Status

Open **Status** from the project workspace menu or the project overview. A compact list shows one row per declared source design, with **Board**, **Saved PCB checks** and **Saved 3D** columns. Repeated physical instances share one source-status row. Status inspection reads saved files only: it does not run checks, render previews, export models, contact the cloud or upload design files.

The board subtitle distinguishes an available PCB, a schematic-only source, a missing PCB and unavailable source ownership. Missing reports say there is no saved report; that does not mean checks have never run. Verified reports show saved findings or no listed findings. Reports without a valid source receipt remain unverified. A source change invalidates the saved comparison.

Saved models have independent input/artifact receipts. “Saved · PCB unchanged” requires matching PCB and model hashes and, for assembly members, matching project/source/declaration identity. A changed model is unverified even if its PCB still matches. Missing or invalid receipts never imply freshness. External component models, physical fit and connection compatibility remain unverified.

Select a board or status item to open its existing board/check/model view. Parts & BOM and the connection map remain supporting destinations; no persistent inspector, approval workflow or completion percentage is added.

## Published Status

The website uses the same three columns and labels for invited viewers, Contributors and public-link visitors. It describes saved information **at publication time**, not live local work. Owners update the shared page explicitly; Contributors publish individual board revisions. Access and anonymous-link revocation remain enforced by the existing authenticated/public snapshot routes.

`GET /projects/:id/status` is local metadata inspection. It reuses the strict snapshot metadata contract but omits preview/model bytes. Source/model states contain no paths, hashes, raw reports, chats or credentials. File events invalidate the local query. Read failures hide cached status and offer Retry.

Published snapshots add optional `sourceState` and `modelState` fields. Older snapshots remain readable and their model freshness is unverified. Deploy the matching API/browser schema before releasing the desktop publisher; older strict servers reject the new fields instead of silently accepting incomplete data.

Sharing state is separate from board progress. Projects have Not shared / Invited people / Anyone with the link; board design files have Not shared / Shared with Contributors. Warnings and publishing messages are not additional publication states.
