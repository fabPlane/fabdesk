# Laser-cut stencil settings (starting points)

`export_laser_stencil` writes a LightBurn `.lbrn2` job plus layered SVG/DXF of
`F.Paste` / `B.Paste` for a **ComMarker Omni X 355 nm UV** galvo. Import the
SVG/DXF into **EZCAD** or ComMarker Studio when you are not using LightBurn.
Each export also writes `exports/stencil/<side>-Paste-laser-notes.md` with the
same numbers.

**Every table in this file is a starting point, not a certified recipe.** Focus,
lens, Omni X power variant (5 W / 6 W / 12 W), film batch and fixture all change
the cut. Run a coupon on scrap of the same sheet, then adjust. Wear UV eyewear
and ventilate.

## Presets

| Preset | Material | Shrink | Kerf | Min opening | Starting-point job (150 mm lens) |
| --- | --- | --- | --- | --- | --- |
| `mylar-uv` (default) | 0.1 mm Mylar / polyester (PET) | 0.05 mm/side | 0.015 mm/side | 0.15 mm | 100% · 1200 mm/s · 30 kHz · 1 ns · 2 passes |
| `kapton` | 0.075 mm Kapton / polyimide (PI) | 0.04 mm/side | 0.015 mm/side | 0.15 mm | 100% · 1600 mm/s · 30 kHz · 1 ns · 2 passes |
| `stainless-0.1` | 0.1 mm stainless stencil foil | 0.05 mm/side | 0.02 mm/side | 0.25 mm | 100% · 20 mm/s · 40 kHz · 1 ns · 8 passes |

Power, speed, frequency, pulse width and passes are editable at export. The
`.lbrn2` job writes the values you send. Frame-corner + board NPTH fiducials
are on by default (Ø 3.2 mm).

## Import

1. LightBurn: File → Open the `.lbrn2`. Devices → Create Manually → **BSLFiber**,
   laser type **UV**, Galvo 2 = X. Frequency 20–200 kHz, pulse 1–50 ns.
   Calibrate the lens (9-point) first.
2. EZCAD / ComMarker Studio: import the SVG (colour-mapped) or DXF (layer-mapped).
   Units are millimetres.
3. Map layers if you imported SVG/DXF:
   - `APERTURES` / red — through-cut
   - `FRAME` / black — through-cut sheet outline
   - `FIDUCIALS` / blue — printer-frame + NPTH registration holes
   - `GUIDE` / cyan — board outline, **do not cut**
4. Disable Fill / hatch on every cut layer.
5. `B.Paste` is still KiCad top-view. Mirror in the laser software if you flip
   the film onto the back of the board.

## Sources

- Omni X parameters: https://support.commarker.com/hc/en-us/articles/49779932023449-Parameters-About-ComMarker-Omni-X
- Cutting appendix: https://support.commarker.com/hc/en-us/articles/49717629130649-How-to-Perform-Cutting
- LightBurn Omni X setup: https://support.commarker.com/hc/en-us/articles/49950364833689-Omni-X-Correction-Guide-with-Lightburn
