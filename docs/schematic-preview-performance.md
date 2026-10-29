# Schematic preview performance

The existing image-based viewer keeps SVG paths out of React's DOM, but Chromium still repaints the vector drawing when its displayed dimensions change. On the local PS1 board schematic (1,119,000 bytes), repeated panel opens and zoom changes produced noticeable frame stalls.

## Change

- Decode the original SVG in a hidden image, then display cached canvas pixels. The source drawing and existing viewBox/click/pin geometry are unchanged.
- Scale the existing canvas immediately during zoom or resize. Refine it after 120 ms without another size change, at the current display density. Cancel obsolete refinements on source change or unmount.
- Reuse the largest cached raster for the same SVG when reopening or zooming out. Changed SVG text gets its own raster; failed refinements do not replace a usable cache entry.
- Quantize raster sizes in 256-pixel width steps. Limit each raster to 4096 pixels per side and 8 megapixels, and retain at most 48 MiB of cached RGBA pixels. Visible canvases have their own bounded backing stores. Eviction releases unused canvas backing stores.
- Fall back to the vector image if canvas rendering fails. Legacy SVGs without a viewBox retain the existing geometry-based viewer.
- Scroll over the preview to zoom toward the pointer (20–800%). Hold the left or middle mouse button and drag to pan a zoomed drawing. Pointer capture keeps a drag active outside the panel; a drag does not place a comment, while a stationary click still does. Fit resets zoom and scroll position.

At extreme zoom or on a very dense display, the raster cap can soften detail; the original SVG file is unchanged. Initial decoding and the first vector-to-canvas draw can still stall a frame. This change addresses repeated repainting, not every possible source of UI latency.

## Local measurements

Windows Electron dev build, foreground window, 2178 × 920 CSS pixels, device-pixel ratio 1. Three runs per implementation using the same project and panel width. Each run closes/reopens the panel three times, zooms in eight steps, zooms out eight steps, and returns to Fit. Measurements are requestAnimationFrame intervals, not an end-to-end latency guarantee.

| Measurement | Original SVG image | Cached canvas |
| --- | --- | --- |
| Frames longer than 33 ms, runs 1 / 2 / 3 | 40 / 41 / 42 | 8 / 8 / 8 |
| 95th-percentile frame interval | 44.5 ms in all runs | 5.7 / 5.6 / 5.7 ms |
| Worst frame per run | 90.3 / 55.6 / 67.0 ms | 53.0 / 48.7 / 54.2 ms |

The middle run has about 80% fewer slow frames. Results depend on the drawing, hardware, window size, and refresh rate. No source design files are bundled with this change.

## Reproduce and check

Start the dev desktop, bring it to the foreground, select a project with a rendered schematic, and close any unsaved comment editor. From the repository root run:

```powershell
bun scripts/bench-svg-preview.mjs "$env:APPDATA\fabPlane Dev"
```

The benchmark uses the existing authenticated local app bridge, changes only preview navigation/zoom, and leaves the schematic at Fit. Run it against the original and changed viewers at the same panel size. It does not send agent messages or modify project files.

Also check Fit, high zoom, panel reopening, PCB previews, resize, and comment placement. Unit tests cover size/memory limits, cache reuse, source changes, eviction, failed refinements, and existing SVG coordinate mapping.

Navigation was also checked in the running Windows app with real wheel and drag input: zoom in/out, horizontal/vertical panning, and dragging versus clicking in Comment mode. A renderer check verified pointer anchoring (less than one pixel of rounding error), line-based wheel deltas, 20%/800% limits, and Fit returning scroll to zero.
