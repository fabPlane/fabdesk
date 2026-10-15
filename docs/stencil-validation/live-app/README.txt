Live Windows desktop verification, 2026-10-15

Base: 7b7d0726a5bd860675502ae453492963569d46db (PR #286).
Follow-up change: FilesTab's project content is keyed by projectId, isolating
file selection and export state across project switches. Geometry unchanged.

Built with bun run build:desktop and launched the real Electron desktop app.
Used its documented app automation bridge: project selection through /ui,
observed selectors through /find, real input events through /click and /key,
and screenshots through webContents.capturePage. Test project creation/file
copying used the local core API. Stencil exports used the real UI, not a direct
call to buildSolderStencil or the export tool.

Successful UI exports and independent STL mid-plane checks against native
KiCad paste Gerbers:
  PS1 V1: 210 native / 210 STL openings.
  PS1 V4.0: 240 native / 240 STL openings.
  PS1 V4.1: 240 native / 240 STL openings.
  Rotation/margin fixture: 9 native / 9 STL openings.
All have zero missing native pad centres, watertight meshes, consistent winding,
and positive volume. Maximum boundary deviation <0.005 mm (curve tessellation).
Source PCB hashes were unchanged after exports.

Actual V4.0 default output: 78 x 70 x 0.15 mm, border 5 mm, 244 paste records
forming 240 openings, no skipped records, no alignment holes. STL SHA256:
adbee24c8384d56f70be83ce06c3ff5984c4bd71a8f6ad802956017310a0ef8d
Original V4.0 project PCB SHA256 (Windows checkout bytes):
b2cc3a1123a4df24954942d0b57a1613c5ff7946209aeaf1fc40d2588b273cc3

UI regression reproduced before the follow-up:
1. Select a project with no board.kicad_pcb and click Export stencil.
2. Observe the expected board.kicad_pcb not found error.
3. Switch to valid V4.0. The previous error incorrectly remains.
4. Ctrl+K -> Export solder stencil succeeds, but the unrelated error remains.

Repeated steps after rebuilding and reloading the renderer:
- Error appears for the empty project and clears on switching to V4.0.
- Palette export updates the STL, with an identical SHA256.
- Another button export again updates the STL with an identical SHA256.
- Unsupported custom F.Paste pads show an actionable error and create no files.
- Empty projects show an actionable error and create no files.

Validation: full workspace typecheck PASS; desktop build PASS;
93 UI tests / 333 assertions PASS; live UI regression/repeat-export checks PASS.

Screenshots are unaltered app captures. actual-stl-comparison.png is a measured
geometry diagram, not a screenshot or physical print result. JSON files contain
the independent geometry and live recovery measurements. No physical print or
paste transfer was performed. Files/palette exports use default options; the UI
has no thickness/nozzle settings dialog. The existing print profile is separate.

Automatic folder opening follow-up (2026-10-15):
- Files -> Export stencil opened Windows File Explorer at the actual
  ps1-v4-original/exports/stencil directory after the job completed.
- Closed that Explorer window; exporting the no-PCB project showed the expected
  error and did not open another folder.
- Ctrl+K -> Export solder stencil on V4.0 opened the same correct directory.
- The exported STL SHA256 still matches the value above.
- 207 client-core/UI tests (834 assertions), full workspace typecheck, and the
  desktop build passed. This includes Windows/POSIX output paths, failure and
  missing-path cases, remote/browser hosts, and file-manager opening failures.

Thickness dropdown follow-up (2026-10-15):
- Files now offers 0.10, 0.15, 0.20, 0.25, 0.30, 0.40 and 0.50 mm total thickness.
  The desktop UI defaults to 0.20 mm; the headless tool's default is unchanged.
- Selection is saved per project. The command palette shows and uses that value.
- Exported V4.0 through the real Files button at all seven settings and inspected
  binary STL vertex Z bounds: every measured thickness matches the selection.
  Every STL retained 240 openings and byte-identical X/Y vertex coordinates to
  the previously validated export. The source board was unchanged.
- Switched from V4.0 at 0.30 to V1 (default 0.20); set V1 to 0.10, returned to V4.0
  and reloaded: V4.0 remained 0.30. Palette exports at 0.30 and 0.20 produced the
  matching STL thickness. Left the PS1 V4.0 project selected at 0.20 mm.
- 93 UI tests / 333 assertions, full workspace typecheck and desktop build passed.
  See thickness-results.json, thickness-ui-checks.json and thickness-dropdown.png.
  These verify exported geometry/settings, not printability at every thickness.
