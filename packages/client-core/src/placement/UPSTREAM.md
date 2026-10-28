# Placement engine provenance

The JavaScript geometry, KiCad file model, constraints, placement search and review modules in `engine/` are adapted from [TensorFleet/placement-lab](https://github.com/TensorFleet/placement-lab), commit `51cd33385d4c350cd0f08e15e141715ac48004f9` (2026-10-28 integration).

Only relative module extensions were removed for FabDesk's bundler. The engine remains JavaScript to keep this tested snapshot comparable with upstream; `engine/index.d.ts` provides its typed application boundary. The React interface, worker integration, history and project draft workflow belong to FabDesk. No standalone server, analytics, source maps, personal boards or footprint library is bundled.

`fixtures/usb-timer.kicad_pcb` is upstream's illustrative 12-part example. It is used only in tests. Placement findings are geometric review aids, not electrical DRC or fabrication acceptance. Optional spacing targets are advisory and disabled by default. Export deliberately removes tracks, vias and zones and leaves the source file unchanged.
