# Automatic board views

The Board workspace offers 2D, 3D and Layers. 2D is an orthographic view of the same saved PCB model used in 3D. Top/Bottom, pan, zoom, component selection and Fit remain available. Layers displays KiCad's actual enabled copper stack, paste, mask, silkscreen and outline with independent visibility controls.

Opening a saved board prepares missing/outdated model and layer previews in the background. Preparation is keyed by endpoint, project, source/manifest identity and PCB SHA-256. View switching reuses the canvas and decoded model. Source edits settle before preparation; errors require an explicit retry rather than an export loop. An installed compatible KiCad version can be used without changing user settings. No source board is rewritten.

The existing schematic, routing, placement and checks remain available. The source drawing and pinned comments are under **More board tools → PCB drawing & comments**. Existing saved finding/comment navigation opens that drawing directly. Component-model export notes remain visible; these previews do not establish manufacturing or physical fit.

## Validation

- Root typecheck and desktop production build passed.
- UI: 395 tests passed. Client core: 616 tests passed.
- Focused registry/preview tests: 77 passed. GLB integrity and preview publication tests: 14 passed.
- New tests cover actual layer enumeration, immutable source export, preservation of previous output after an edit, revision matching, failed queued jobs and layer visibility.
- Live desktop: a real four-layer VAIO peripheral board and two-layer microSD board, both as separate assembly sources with no pre-existing previews. Automatic preparation produced 11 and 9 layer images respectively; both bundles matched their source SHA-256 and models were independently saved (6.9 MB and 1.2 MB).
- Six successive view switches retained the same WebGL canvas. Two-frame observations took 7–31 ms on the tested machine, after initial preparation. Top/Bottom and layer toggles passed. This is an interaction smoke check, not a cross-device performance guarantee.
- Broader Windows tools/KiCad suites are not fully green. Their existing failures were reproduced in a separate checkout of `main` (`b7bc58cb`), including symlink privileges, shell-based CLI fixtures, stencil and other platform-sensitive checks. The two changed inventory assertions (tab/tool additions) were updated and passed on rerun.

Screenshots in `screenshots/automatic-board-views/` show the actual app using the VAIO peripheral source, not mockups.
