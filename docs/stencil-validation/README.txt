PR #286 stencil fixes — validation, 2026-10-14

The fixed desktop app exports the unchanged PS1 NewPlayBridge2 V4.0 board with
240 physical paste openings, zero skipped records and no added alignment holes.
The PCB has 244 paste-pad records: four coincident records share openings.
The original PCB file was not edited.

WHAT CHANGED
1. Coincident USB pad records no longer look like zero-pitch pins to the optional
   fine-pitch filter. Footprints with repeated reference names stay separate.
2. Local positions use KiCad's Y-down rotation; pad angles are already absolute.
   Saved bottom footprints are not mirrored a second time.
3. Defaults preserve paste: extra shrink 0, minimum aperture 0, fine-pitch filter
   off, alignment none. The previous filters remain available explicitly.
4. Native pad/footprint/board paste margins and ratios are inherited independently,
   including explicit-zero overrides. Roundrect corners and capsule ovals are kept.
5. Filled zero-stroke paste rectangles are included. Older PS1 USB footprints use
   these instead of putting all paste on copper-pad records.
6. A read-only parser projection removes unsupported annotations and irrelevant
   copper-only pads. Unknown paste shapes/artwork fail clearly rather than giving
   an incomplete stencil. No source PCB or vendor parser files are modified.
7. Degenerate cap triangles are omitted; watertightness is checked before export.

IMAGES
app-summary.png: unedited cropped screenshot from the real local desktop app,
after clicking Export stencil and opening its generated F-Paste.json.
stl-comparison.png: diagrams from actual STL mid-plane cross-sections. These are
not screenshots or physical prints. It compares the earlier actual app export,
the fixed actual app export, saved Stenchill output, and the earlier agent STL.
rotation-fix.png: U6 geometry close-up with filters OFF in both old and fixed code.
The old transform merged eight holes into two slots; the fixed transform keeps eight.

REFERENCES AND LIMITS
PS1 source: fabPlane/playbridge-ps1-wireless-adapter at
fc0e21947b4d8ab6ddc4e523a43e669158542632,
versions/v4.0-controller-serial-bridge/board.kicad_pcb.
SHA256: b2cc3a1123a4df24954942d0b57a1613c5ff7946209aeaf1fc40d2588b273cc3
The imported app copy has that same SHA256 before and after export.
This is the Windows/CRLF checkout hash; the Git/LF blob hash is recorded in
results.json. Normalized contents are identical. The six-board corpus checkout
is 125f885f2d6745c09e983acd62535c28e34251d1; its V4.0 file is unchanged from fc0e219.
KiCad reference: native F.Paste/B.Paste Gerbers from 10.99.0-5073-g05cc3edacc.

The saved Stenchill comparison uses separate holes with no row merging or shrink.
This is aperture fidelity, not a claim of feature parity with every Stenchill mode.
Curves are tessellated: fixed V4.0 STL boundary error versus native KiCad is below
0.0022 mm. Across the 12 native comparisons the maximum is below 0.005 mm.
The three successful V4.0 outputs all cover the same 240 expected locations.
Default app plate: 78 x 70 x 0.15 mm; PCB: 68 x 60 mm. The saved Stenchill and
earlier agent files use a 10 mm frame and 0.10 mm thickness (88 x 80 mm plate).
Rigid orientation/translation only is used to align their XY geometry for comparison.

The earlier app screenshot/export was captured at 60de742. It required a
parser-compatible diagnostic copy whose native paste was independently confirmed
identical to the original board. The original board itself failed to parse there.
Its default export had 208 paste openings. The newer PR baseline used for test
failure comparisons is 1377b6a90ab3158449e1c6f815417a079b785780; its outline fix is retained.

TESTS
27 focused tests pass. Coverage includes rotation, bottom pads, stacked USB pads,
threshold equality, repeated references, small holes, margins and explicit zeros,
rounded/oval shapes, nightly metadata/transforms, paste graphics, invalid settings,
unsupported paste artwork, degenerate triangles, file output and the actual tool.
Three tests compare against frozen independent native KiCad geometry.

12 native comparisons pass: six PS1 revisions (V1, V2, V2.1, V3, V4.0, V4.1),
five fixture front layers, and a bottom-layer fixture. Native/app/STL opening
counts match (210, 210, 214, 218, 240, 240 on the six PS1 boards). All have no
missing source centers and closed, consistently wound, positive-volume meshes.
Detailed metrics and file hashes are in results.json.

Full typecheck and desktop build pass. The full test suite is NOT green in this
Windows checkout: 28 workspace failures also reproduce on unchanged 1377b6a.
The separate scripts suite has five failures, also reproduced on that baseline.
No new failing test names were introduced. Results include the failing names.
No claim is made that CI on every platform is green.

Bambu Studio sliced the fixed V4.0 geometry at 0.20 mm thickness / 10 mm frame
using X1C 0.2 mm, Smooth PEI and Bambu PLA Lite settings. A nominal G-code material
sweep retains 240 separate holes on each of two 0.10 mm layers and through both.
Single-layer microvoids exist; none of the extra through-voids exceed 0.01 mm2.
There is a bed-temperature-versus-filament profile warning, recorded verbatim in
slicer-validation.json. No physical printing or solder-paste transfer was tested.

Custom/chamfered pads, other paste graphics and scaled footprints still fail with
a native-Gerber fallback message. The holder remains a simple rectangular pocket.
Bottom exports remain in board/top-view coordinates; choose the correct physical
orientation before printing. Geometry fidelity does not guarantee printability.

REPRODUCE FROM THE REPOSITORY ROOT
bun test packages/kicad/test/stencil.test.ts packages/kicad/test/stencil-geometry.test.ts packages/kicad/test/stencil-native.test.ts packages/tools/test/stencil-export.test.ts
bun run typecheck
bun run build:desktop
bun run test
bun test ./scripts/test

To regenerate native fixture references with KiCad installed (optional developer
dependencies: Python, gerbonara, shapely):
python scripts/stencil-native-reference.py --kicad-cli PATH_TO_KICAD_CLI
Review the generated geometry rather than accepting a changed snapshot blindly.
The normal application and Bun tests do not depend on native KiCad or Python.
