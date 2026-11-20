# fabPlane parts (KiCad plugin)

Search your libraries, the team library on fabplane.com, and KiCad's standard
symbols from Schematic Editor or PCB Editor. Pick a row to copy a self-contained
`kicad_sch` clipboard snippet (Footprint, MPN, Manufacturer). Paste with Ctrl+V /
Cmd+V in the schematic.

The plugin talks **only** to the local fabPlane daemon (`daemon.json`). Sign in
through the fabPlane app first.

## Install

This plugin is not auto-installed. Copy this folder into KiCad 8/9's scripting
plugins directory and restart KiCad:

- macOS: `~/Documents/KiCad/8.0/scripting/plugins/` (or `9.0`)
- Linux: `~/.local/share/kicad/8.0/scripting/plugins/`
- Windows: `%APPDATA%\kicad\8.0\scripting\plugins\`

Then **Tools → External Plugins → fabPlane parts**.

## Make this part

When search is empty, enter an MPN or a datasheet URL and click **Make this
part**. Mapping uses Device templates (R/C/L/LED/D/IC) from the part number;
there is no LLM datasheet parser.

## Notes

- Paste is a schematic clipboard even when the plugin is opened from PCB Editor.
- The wx panel does not show thumbnails.
- Team/org hits require the companion fabplane.com cad-parts API.
