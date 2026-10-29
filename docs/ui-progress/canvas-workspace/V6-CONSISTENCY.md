# v6 visual consistency follow-up

Local UI pass based on the preserved v6 spec and actual reference images: project overview, saved outputs, Review updates. Incorporates the subsequent user preference for icon controls with hover/focus labels. This is visual and workflow organization work, not a claim that pending engineering features are complete.

- Shared 56px header and 64px task row, with matching control spacing, radii, navy text, ivory dot grid, green active states and restrained shadows. The duplicate workspace breadcrumb is removed. Fresh start and full conversation/secondary flows do not receive an empty task bar.
- Existing task tabs retain their navigation and keyboard behavior. Root PCB/Schematic/3D now use the same named icons as assembly boards; Review uses a quiet active underline. Checks stay in the board toolbar and Review Checks, rather than repeating on unrelated pages.
- Board cards include their name/status inside the existing logical map bounds; unavailable sources have a dashed border. Source receipts/findings remain actual, and board membership/geometry/connections are unchanged.
- Saved outputs has a visible page title, Create action, aligned search/source/category controls and consistent cards. Filename is primary, board source secondary, with recorded status retained. No synthetic previews or outputs added.
- Review title, source cards, section headings and tables use the shared page width and type hierarchy. Parts/Shopping controls move into the same task row, retaining BOM, CSV, search and procurement behavior.
- Corner assistant, menus and spatial controls share the same restrained surface treatment. Existing closed-by-default behavior and explicit actions remain. Board Art/Mechanical internals are not edited.

## Verification

UI typecheck PASS;234 tests917assertions/0fail. Six read-only rendered route diagnostics cover Outputs, Parts, Updates, Changes, Checks and Files: 56px header /64px task row, no page-level horizontal overflow, assistant closed, no runtime error boundary. Native captures cover VAIO overview and actual saved outputs; root Review/Parts; compact960x720 Parts; fresh start. Native keyboard switching verified PCB→Schematic→PCB, retaining focus and selection. No new circuit or render job invoked during this visual pass.

The root study's34 protected files remain byte-identical, including against the prior baseline. Eight current VAIO native/manifest paths remain unchanged. See v6-consistency-native.json. Original v6 concepts and every screenshot iteration are preserved. Remote publication remains prohibited; this checkpoint is local only. Provider/model behavior and incomplete feature integrations are not revalidated or claimed complete.

## Implementation

Shared visual tokens/rules live in packages/ui/src/layout/canvas-v6.css, loaded after the existing canvas rules. Small presentation changes live in CanvasWorkspace, BoardPanel, AssemblyOverview, OutputsLibrary, AssemblyReviewUpdates and optional icon tabs in components/ui.tsx. Existing source ownership, native tools and action contracts remain intact.
