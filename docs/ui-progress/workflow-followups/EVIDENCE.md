# Ticket evidence · 5 November 2026

These are actual application captures, not design concepts. Captures 01–07 came from native sessions; 08–11 show this branch's browser renderer with copied native projects and the isolated core. Test setup and limits are documented in [HUMAN-TEST.md](HUMAN-TEST.md). A screenshot of one state does not establish full issue acceptance.

## #411 · preserve native comparison outline segments

The native RH port source retains 12 independent outline paths through comparison composition. The pipeline diagnostic checks 24 rendered paths (both revisions) in each mode; original native hashes remain unchanged. Visible Review → Changes → Compare retest captured every mode.

![RH comparison Highlights](screenshots/09-rh-comparison-highlights.png)
![RH comparison Overlay](screenshots/10-rh-comparison-overlay.png)
![RH comparison Side by side](screenshots/11-rh-comparison-side-by-side.png)

## #412 · source-bound member and hierarchical focus

Implementation and installed-KiCad tests cover native sheet identity, repeated instances, source-bound choices and stale source rejection. **No completed human focus walkthrough or fixed-focus screenshot yet.** Do not use the #416 root canvas screenshot as proof of #412 acceptance.

## #416 · circuit canvas foundation

Explicit Open circuit view converted the copied project's native schematic to a transparent, frame-free, content-fitted preview. Native geometry and document exporters are preserved. Component/net selection, editing, linked views, multi-sheet UI acceptance and dark-theme contrast remain open.

![Current build native circuit canvas](screenshots/08-circuit-canvas-current-build.png)

## #417 · compact Activity and useful results

Native captures show the modeless panel, consecutive read grouping and navigation to an exact recorded model. Failed/running/cancel/keyboard journeys and #415 coordination remain unverified.

![Compact modeless Activity](screenshots/02-activity-theme-and-canvas-interaction.png)
![Grouped reads with individual history](screenshots/04-isolated-grouped-bom-reads.png)
![Exact saved model result](screenshots/06-isolated-activity-model-result.png)

## #418 · Parts origins, coverage and quantities

Actual native captures show incomplete multi-board coverage and exact source files; the single-board example distinguishes 5 BOM lines from 6 physical parts, with build quantity 5 yielding 30 parts. Hardware/repeated-source and Ask cases still need visible acceptance.

![Multi-board source coverage](screenshots/03-bom-origins-vaio-incomplete.png)
![Single-board quantities and source origin](screenshots/07-single-board-five-lines-six-parts.png)

## #394, #395, #415 · unfinished

No new fixed screenshots are available: these issues remain planned. Existing artwork modes/persistence and multiple chats are pre-existing partial functionality, not completed acceptance of these tickets. See [README.md](README.md) for scope and dependencies.

Before-state capture 01 and launch-limitation capture 05 are intentionally excluded from the fixed-state gallery; preserved originals remain available for audit.


## #425 · Parts sources and full-page table browsing

Native desktop captures on the current implementation. The 245-line project is explicitly synthetic layout-only data. `12` preserves the verbose before state; it is not a fixed-state capture.

![Compact source expansion with the real single-board test copy](screenshots/13-parts-sources-compact.png)
![Long table with sticky search and headings](screenshots/14-parts-long-sticky.png)
![Final row above the assistant](screenshots/15-parts-final-row.png)
![Active category while scrolling](screenshots/16-parts-filtered-sticky.png)
![Narrow enlarged layout, rightmost columns](screenshots/17-parts-narrow-horizontal.png)
![Same row and horizontal position after Files and Back](screenshots/18-parts-return-position.png)
![One actionable hardware read error with qualified cached counts](screenshots/19-parts-read-error.png)
![Multi-board missing-source reasons remain visible](screenshots/20-parts-multiboard-compact.png)


## Drawing controls and routing reference

Clear grouped zoom controls, fitted-view percentage, distinct Fit board / Fit width actions and a compact explanatory status instead of the faint footer. Expanded capture predates the final summary-width spacing adjustment; functionality was visibly tested, but the final expanded spacing capture was interrupted by manual input.

![Final routing controls and compact preview status](screenshots/21-routing-controls-compact.png)
![Expanded preview explanation and Open PCB action](screenshots/22-routing-preview-explained.png)
![Shared controls in narrow linked panes](screenshots/23-viewer-controls-linked-narrow.png)
