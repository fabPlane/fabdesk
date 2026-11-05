# Artwork entry and dropdown consistency · November 3, 2026

This scoped follow-up addresses the user's two screenshots: the isolated Artwork card looked unrelated to the workspace, and dropdown option lists used the operating system's default appearance. It does not establish completion of the wider app roadmap.

## Changes and audit

- Replace the centered star-to-board example with the same page header/content rhythm used by Outputs and Review. Present a clear image upload/drop area beside actual saved project sketches, including authenticated thumbnails, filenames, count and an explicit “Use as artwork” action. Show an honest empty sketch state. Keep the existing upload, sketch loader, draft persistence and artwork editor.
- Audit all React desktop UI selectors: 49 static shared Select call sites across 28 files. Migrate one-off selectors in 19 files to the shared component without changing their values, options or handlers. This covers source/scope filters, checks, comments, files, parts, models, exports, sketch choices and project setup.
- Style picker surfaces, option spacing, hover/focus, selection checkmark, disabled states, scrolling, chevrons and viewport bounds using the app's existing theme tokens. Real select/option semantics remain intact. The two raw selectors in teammate-owned MechanicalWorkspace inherit global styling; that file's implementation is unchanged.
- Replace Settings' native model datalist with the same styled picker and a separate “Custom model ID…” input. Preserve arbitrary saved model IDs. Reset restores both the saved model value and the UI mode.
- Keep Escape within an open selector: it dismisses the picker before the containing dialog. Preserve the browser's normal keyboard selection behavior.

The desktop uses Chromium's customizable select implementation ([official documentation](https://developer.chrome.com/blog/a-customizable-select)). Older paired browsers without that capability retain a usable native fallback. No assertion of identical popup rendering in every browser. Native OS file dialogs stay native. Standalone MCP App HTML documents are outside this desktop stylesheet and are unchanged.

## Human walkthrough

Used the actual Electron 44.1.1 development app, visible controls and normal typing. Started at Home with existing test data preserved. Existing synthetic project “a” was used for Artwork; no hidden route, injected UI state or backend mutation prepared the page. Accessibility labels located controls; actual screenshots assessed layout. Tool-driven clicks do not necessarily animate the desktop cursor.

| Step / visible path | Expected | Actual result | Status / evidence |
| --- | --- | --- | --- |
| Settings → Default agent / permission picker | Branded option list, clear selection | App-colored bounded panel, selected checkmark and normal disabled/focus treatment | Passed; settings-select.png |
| Open Settings picker → Escape | Close only picker | Initial implementation also closed Settings. A direct active-element check missed the focused option; checking its owning select fixed it. Retest kept Settings open | Initially failed → fixed and passed; settings-escape-preserves-dialog.png |
| Picker → Space, End, Home, Enter, Tab | Normal keyboard navigation | Opened, moved to last/first choices, selected and closed, then tabbed to the next field | Passed; no Settings Save clicked |
| Home → project a → Start → Create an artboard | Clear artwork starting choices | Header, upload area and “No saved sketches yet” state appeared with the corner assistant retained | Passed; artwork-empty.png |
| Choose image → native file dialog → Cancel | Return without changing artwork | Existing file chooser opened and cancellation returned to the same empty page | Passed; actual image upload through this button not completed |
| Corner assistant → Upload an image → Sketch or image → choose existing synthetic PNG → Save and attach | Save an image in this test project | Existing saved-image flow added a project sketch; removed its unsent chat attachment. No message sent | Passed with friction: this existing path opens chat; no new Draw button was added to Artwork that would disguise that behavior |
| Artwork entry → project sketch thumbnail | Recognize image and load it | Actual thumbnail/count/filename appeared; “Use as artwork” opened existing artwork preview and draft controls | Passed; artwork-project-sketches.png |
| Artwork tools → Use another project sketch | Consistent picker at window edge | Long filename wrapped inside the bounded picker without escaping the viewport | Passed; artwork-sketch-select.png |
| Board settings → Shape | Styled selection and responsive preview | Rounded rectangle reflected in the preview; a pointer click restored Rectangle and closed the picker | Passed; no explicit Save artwork or circuit Apply |
| Settings → Codex model → Custom model ID → type test ID | Custom value remains editable | Input appeared and enabled draft Save/Reset; no request or saved setting changed | Passed; settings-model-picker.png |
| Custom model → Reset | Restore saved choice and hide custom input | First attempt cleared value but left custom mode visible. Remount on explicit Reset fixed this; final native retest showed Agent default, no custom field and disabled Save/Reset | Initially failed → fixed and passed; settings-custom-model-reset.png |
| Close Settings → Home → Close project | Preserve files, return to first page | Home shown with no project open and no test agent task started | Passed |

A saved copy of the existing synthetic Downloads PNG and an artwork working draft now belong to test project “a”. No project was deleted, Settings Save was never clicked, and no circuit/native editing, fabrication, supplier action, enclosure, replacement or board resize integration was performed. These checks do not establish electrical, fabrication or physical compatibility.

Screenshots in [artwork-dropdowns-20261103](artwork-dropdowns-20261103/) are unaltered; user-before-* files are the user's supplied baseline images, the rest are actual native captures. SHA256SUMS identifies every image. AX option invocation sometimes retained the picker after changing its value; a real pointer click was separately verified and closed it correctly. This automation distinction is not reported as an app failure.

## Change list and coverage

| ID | Issue / impact | Resolution and retest criterion | State |
| --- | --- | --- | --- |
| AD1 | Artwork entry lacked hierarchy and hid available sketches in a dropdown | Page header plus upload and thumbnail choices; open empty and populated states and load a sketch | Addressed; native verified |
| AD2 | Native selector menus broke the desktop visual language | Shared theme-token picker styling and one-off migration; inspect selection/keyboard/edge behavior | Addressed; static audit covers every desktop selector, representative native checks above |
| AD3 | Escape dismissed the enclosing task while choosing an option | Let the picker consume Escape first; parent remains open | Addressed; native verified |
| AD4 | Model datalist retained native options; arbitrary model IDs must still work | Shared picker plus explicit custom input; choose, type and Reset | Addressed; native verified |
| AD5 | Model Reset left an empty custom-mode field | Remount local choice state on explicit Reset; saved selection and disabled Save restored | Addressed; native verified |

Not tested in this follow-up: every option of all 49 static call sites, dark/high-contrast themes, small-screen layout, drag/drop upload, upload validation errors, long multi-sketch collections, paired-browser popup rendering, teammate enclosure controls or downstream engineering actions. Responsive stacking and forced-color rules are implemented but not claimed as human-accepted. The wider user journeys and deferred teammate integrations retain their prior status.

## Validation

Final UI typecheck passed. UI suite: **279 passed, 0 failed, 1,185 assertions across 57 files**. Final desktop production build passed (renderer 59.12 seconds); zero emitted .map files. Existing Zod annotation and large-chunk warnings remain. git diff --check passed. Native acceptance used the development app; production artifact was built, not launched as a packaged distribution. No full engineering suite or hosted CI was rerun for this styling follow-up; the previous merge report's telemetry timeout remains separately disclosed.

Work is committed locally after these checks. This follow-up does not push or alter the remote PR; the previous explicitly authorized conflict-resolution push remains ca9ea80.


## Inspiration follow-up · November 3

User requested example images on the empty Artwork page. Replace the oversized image icon with three compact, original vector illustrations: a sun/bold mark, mountain line art and a halftone motif. Label the group “A little inspiration / Illustrative examples”; keep the upload action prominent, with saved project sketches in their separate panel. These are static inspiration, not sample buttons, project artifacts, native-source previews or fabrication claims. No network images, image-generation dependency or new artwork-generation workflow was added.

Human retest: Home → Projects → existing test1 → Start → Create an art board. The project initially showed its transitional board toolbar before Start settled; a stale AX target was refreshed and the visible Start action used. Actual page shows all three labeled images with no clipping at the current desktop size. Choose image opened the native file picker; Cancel returned to the same empty state. No image selected, no new project created, no source/artwork file saved and no agent request sent. Close project returned to Home; opening recency may update normally. Narrow-window and alternate-theme rendering not retested here.

User baseline and unaltered actual native capture are in [inspiration-20261103](inspiration-20261103/), with SHA256SUMS. UI typecheck and all282UI tests/1199assertions passed; git diff --check passed. No new full engineering suite or production build is claimed for this small vector/CSS addition. Prior feedback build remains separately recorded. Local commit follows; no push or remote PR update.


## Inspiration caption alignment · November 3

User identified the two floating labels above the examples. Replaced them with one muted, centered caption: “Artwork inspiration · illustrative examples”. Its width and typography override the generic upload paragraph rule, so the caption aligns with the three-image group. Actual native Artwork screen confirmed the corrected alignment; capture: inspiration-20261103/centered-caption.png (SHA256SUMS updated). No project files changed. git diff --check passed; no new test suite/build needed for this copy/CSS-only adjustment. App remains on the existing Untitled art board Artwork page. Local commit only; no remote update.
