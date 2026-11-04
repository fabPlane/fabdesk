# Placement engine provenance

The JavaScript geometry, KiCad file model, constraints, placement search, review and autosave modules in `engine/` are adapted from [TensorFleet/placement-lab](https://github.com/TensorFleet/placement-lab), commit `51cd33385d4c350cd0f08e15e141715ac48004f9` (2026-10-28 integration).

Relative module extensions were removed for FabDesk's bundler. The engine remains JavaScript to keep this tested snapshot comparable with upstream; `engine/index.d.ts` provides its typed application boundary. React UI, workers, project draft/recovery integration, editing helpers and enclosure integration belong to FabDesk. No standalone server, analytics or source maps are bundled.

`library-data.json` contains the exact 42 footprint texts and catalog labels from upstream `library/`; they load lazily. The footprints originate from the KiCad community libraries, distributed under CC-BY-SA 4.0 with the electronic-design exception. See [LIBRARY-LICENSE.md](LIBRARY-LICENSE.md) for the copied license and [KiCad libraries](https://gitlab.com/kicad/libraries/kicad-footprints) for the original project.

`examples.json` contains upstream's illustrative USB timer and constructed connectors/cutout fixtures, available as explicit example choices. `fixtures/usb-timer.kicad_pcb` is the same illustrative board used in tests. No personal boards are included. Placement findings are geometric review aids, not electrical DRC or fabrication acceptance. Optional spacing targets are advisory and disabled by default. Native export removes tracks, vias and zones and leaves the source file unchanged.

See [the feature and screenshot comparison](../../../../docs/placement-parity.md) for integration differences and checks.

FabDesk's export adaptation gives synthesized resized-outline segments stable identities. Re-exporting an unchanged session then preserves the board hash used by enclosure alignment checks; real geometry edits still change the export.
