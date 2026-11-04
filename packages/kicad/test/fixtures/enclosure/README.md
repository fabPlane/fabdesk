# Native pad bounds reference

`pad-bounds.kicad_pcb` is a synthetic board, not a user project. Its three footprints exercise a rotated rectangle, copper offset from the drill anchor, and an oval at 45 degrees. All three lack courtyards so the mechanical parser must use pad geometry.

`pad-bounds.native.svg` was exported with KiCad CLI 10.99.0:

```sh
kicad-cli pcb export svg --layers F.Cu --exclude-drawing-sheet --drill-shape-opt 0 --mode-single --output packages/kicad/test/fixtures/enclosure/pad-bounds.native.svg packages/kicad/test/fixtures/enclosure/pad-bounds.kicad_pcb
```

The first two filled polygons have bounds `(11, 6)–(13, 14)` and `(31, 4)–(33, 12)` mm. The oval is a line from `(42.8787, 12.1213)` to `(47.1213, 7.8787)`, with a 2 mm round stroke, so its bounds extend 1 mm past each endpoint. The regression test compares the parser with these independently exported dimensions. SVG coordinates are rounded to four decimal places.

Pad positions are local to the footprint; saved pad angles are absolute in the board frame. This is also documented in KiCad's [pad parser](https://github.com/KiCad/kicad-source-mirror/blob/master/pcbnew/pcb_io/kicad_sexpr/pcb_io_kicad_sexpr_parser.cpp). These are copper envelopes, not a substitute for missing physical component models.
