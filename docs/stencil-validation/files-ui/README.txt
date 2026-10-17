Files explorer and export dialog — 2026-10-15

The Files tab previously displayed full paths in a flat text list. It now groups
files into collapsible folders, shows file-type glyphs and labels, filters by
path, and displays the selected path/type/size above a preview. SVG and raster
images render as images. Known text/code/manufacturing formats remain readable;
binary/unknown formats show an explanatory state rather than corrupted text.
DXF is identified as a drawing; a graphical DXF/3D preview is not implemented.
Folder entries are inferred from the existing API's file paths; empty directories
are not supplied by that API. Search expands matching ancestors automatically.

A single Export button opens a dialog with stencil, Gerbers and BOM choices.
Only stencil shows the saved thickness setting. The default remains 0.15 mm;
the PS1 V4 project retains its explicit 0.20 mm. Existing export tools are called by their registered names.
The stencil backend and automatic output-folder opening remain in PR #286.

Design references:
https://code.visualstudio.com/docs/editing/getting-started/userinterface
https://code.visualstudio.com/api/extension-guides/file-icon-theme
https://claude.com/resources/articles/claude-code-desktop-redesign
Applied patterns: folder hierarchy, recognizable icons, file preview workspace,
and secondary settings shown within the relevant task.

Validation:
- UI tests: 101 pass, 0 fail, 364 assertions.
- UI TypeScript check passes. Desktop production build passes.
- Live Electron input through the app automation bridge: expand/collapse, search,
  clear search, text/code/PNG/SVG previews, binary preview guard, all export choices,
  Escape/focus restoration, missing-PCB error, project-switch error reset,
  0.15 default and PS1 0.20 preference, narrow pane layout/no horizontal overflow.
- Actual stencil export from the new dialog: 240 apertures; byte-identical STL
  against the previously verified PS1 0.20 mm export. SHA-256 is in results.json.
- BOM/Gerber options were checked in the UI; their generation is unchanged and
  was not rerun for this UI-only change.
- Screenshots are captures of the running Electron app using the actual PS1 files,
  cropped at capture time to the Files pane or export dialog. No mocked page.
- No new physical print or solder-paste transfer trial was performed.

PR split:
- This branch starts directly from main; it contains only UI code and evidence.
- No packages/kicad, packages/tools or packages/client-core changes are included.
- The stencil option is gated on export_stencil in the connected tool manifest.
  Main without that backend offers Gerbers/BOM; PR #286 supplies the exporter.
  This prevents an unavailable stencil action when the UI is merged first.
- The saved thickness UI preference uses the same schema as PR #286 so existing
  preferences survive. No geometry implementation is copied into this branch.
- Live tests after the split used this branch's built renderer with the already
  running PR #286 core. The absent-exporter case is covered by unit tests.
- Integration note: both PRs touch FilesTab.tsx. When merging the second PR,
  retain this branch's explorer/dialog and PR #286's backend/client behavior.
