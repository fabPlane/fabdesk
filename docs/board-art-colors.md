# Board Art colors and saved drafts

The Art tab supports Monotone and source-colored Multicolor halftone artwork. The
physical solder-mask swatches use JLCPCB's seven standard names: green, black,
blue, red, purple, white and yellow. Display colors approximate the finish.
Monotone ink is a preview/order choice; ordinary Gerber contains geometry, not
ink or solder-mask color instructions.

Multicolor locks the effective physical solder mask to white. Its printed
background is an optional override, independent of the source image, with a native
color picker, validated six-digit hex input and a not-set icon. It defaults to not
set, leaving the physical board color visible between dots. Clearing it omits the
custom base rectangle from the SVG reference; leave EasyEDA Pro at its default
white base for JLCPCB. Background edits leave sampled source colors unchanged.
Original RGBA is retained, including transparency. Multicolor uses colored dots
with varying coverage, keeping white highlights; crop, placement and outline
clipping use the same geometry as the preview and SVG reference. Previous
monotone mask and ink choices are retained when switching modes.

## Ownership and persistence

Each project has one artwork draft for `board.kicad_pcb`, stored at
`board-art/draft.json`. The versioned file embeds the original image bytes and
all conversion, color, crop and placement options. Edits autosave; Save draft
retries a failed save. Writes serialize and remain bound to their original
project across navigation. A failed restore disables editing to avoid overwriting
unread saved data. Chats in the same project share the draft; switching projects
restores that project's draft. Tab unmounting flushes pending changes.

With no project selected, the UI explicitly identifies an unassigned draft.
It persists in IndexedDB on that device and core endpoint. Create art project
copies it into a new project. Importing and editing art require no circuit.
Saving an export writes `board-art/artwork.zip` and `board-art/preview.svg`,
without replacing the project's circuit, tracks, components or fabrication files.
Creating a new monotone art project also creates its standalone KiCad board.
Multicolor projects retain the draft/reference without creating a misleading
uncolored root board.

## Manufacturing and export boundary

Verified against the official JLCPCB guide on 2026-10-28:

- [Multicolor guide](https://jlcpcb.com/help/article/how-to-design-multi-color-silkscreen-using-easyeda), updated 2026-09-09: white PCB color, 2/4 layers, 1 oz outer copper, ENIG and 1u gold. A separately printed base color determines the top/bottom board appearance.
- [Solder-mask palette](https://jlcpcb.com/blog/pcb-solder-mask-colors-performance): seven standard colors.

JLCPCB currently accepts color silkscreen production files exported from EasyEDA
Pro. Fabdesk does **not** generate that proprietary color-production package.
Multicolor ZIPs contain a board-size `color-artwork-reference.svg` (colored dots
and the selected base, with no preview surround), `artwork-settings.json`, a
preview and an explicit README. Their conventional Gerber and KiCad files are a
blank standalone board, never a flattened single-color substitute for the image.
The UI labels the download as a color reference ZIP. Import and align the SVG in
EasyEDA Pro and generate its required color-production files before ordering.
Verify pad/component keepouts, feature sizes, actual color reproduction and
process options there; the current dot floor is a reference drawing constraint,
not a validated multicolor manufacturing profile.

The current preview is a standalone artwork board. Applying artwork onto an
existing circuit, showing its components/clearances and generating the final
manufacturing package remain integration work for #394/#395. The Art tab saves
alongside that circuit safely. The legacy `silk_art` tool remains explicitly
destructive and replaces the root board; it now accepts the color options and
reports the same multicolor export limitation. Broader filters/palette replacement
are outside this change.

The changes are isolated to Board Art, its deterministic conversion/export
package, and a reusable draft persistence helper. No active redesign checkout,
shared Git directory, app profile or existing development server is required.
