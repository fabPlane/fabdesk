# Component selection across views

Click a component in PCB, Schematic, or 3D to highlight the same reference in the
other views. Selected 3D meshes turn cyan; PCB footprints and schematic symbol
bodies receive a translucent cyan fill and reference label instead of a box outline.
The 2D fill uses a source-derived component envelope, not editable model geometry.
Clearing or switching parts restores the original 3D materials, including shared
materials and textures. Selection belongs to the endpoint, project, and board source; two
boards with an R1 do not share a selection. Switching views keeps the selection.
**Show all three views** opens PCB on the left and schematic above 3D on the
right in taller windows. Short windows use three columns to give each drawing
more vertical space. All three stay mounted and highlight together. One shared selector
and Clear control sit above the panes. Drag either divider (or use its arrow keys,
Home and End) to resize; each pane has Focus and an expand button. Expanding a pane
preserves selection; Show all three views returns to the saved arrangement.

In the three-view workspace, clicking a component smoothly focuses its counterparts
in the other views. PCB and schematic keep the clicked view steady; 3D also
zooms into a component clicked directly in the model. Its close-up fits the part
at the current camera angle, including small parts on large boards. The shared dropdown focuses
all three. Transitions take 320 ms, respect reduced motion, and are interrupted by
manual camera input or a newer selection. **Focus** also zooms explicitly; **Fit**
restores the overview. In single-view mode, selection leaves the camera unchanged.
**Clear** or Escape clears the highlight. The component dropdown supports keyboard selection.
**Actions** opens the existing drawing tools when needed.

A selected component on one uniquely identified schematic sheet opens that sheet.
Multi-unit symbols on the visible sheet are highlighted together. Ambiguous or
missing counterparts are not guessed. PCB/schematic targets require matching
saved-source and preview hashes. A 3D target additionally requires an exact KiCad
exporter node name and matching model receipt. Missing component models and stale
or untracked previews remain viewable, with a selection-unavailable message.
Selection is session-only and never edits the design or starts an agent.

## Main versus branch walkthrough

Baseline: `main` at `2a6d32b19dde758b16eb5a7e54d45802c6d1ffec`.
Feature branch: `codex/cross-view-part-selection`.

The PR embeds fresh paired captures, main on the left and feature on the right,
at 1440×920 and 960×600. Both use the same isolated profile, dark theme, native
KiCad INTERF_U fixture, source files and exported previews. Local fixture model
paths were resolved to installed KiCad libraries; U1 has a model. Two other
fixture component models are missing and are reported by the app.

1. Click U1 in PCB. Main selects a drawing location; the branch highlights U1.
2. Open Schematic. Main has no shared component selection; the branch highlights U1.
3. Open 3D. Main has no component highlight; the branch outlines U1's model.
4. Open Show all three views. The branch keeps PCB, schematic and 3D visible together; main only offers PCB/schematic comparison.
5. Click a part: the other two panes animate to it. Use Focus for the clicked pane,
   Fit to restore an overview, and Escape to clear all highlights.

## Reproduce native checks

Start a freshly built desktop app with an isolated development profile and open
a disposable single-board project with source-verified schematic/PCB/GLB exports.
The standard fixture used here is
`vendor/fab_pcb/e2e/fixtures/boards/interf_u/interf_u.kicad_pcb` and its schematic.
The smoke script expects U1, R1 and R2 to be present, with U1 and R2 in the 3D model.

```sh
FABDESK_USER_DATA=/path/to/isolated/profile \
FABDESK_TEST_PROJECT_ID=disposable-project-id \
FABDESK_CAPTURE_DIR=/path/outside/repository \
bun scripts/check-part-selection-app.ts
```

Run the same script with `FABDESK_BASELINE=1` against an exact main build to capture
the same three steps. The script does not edit project files or run agents.

Validation covers native clicks in both 2D views, shared selection in all directions,
3D highlighting, no implicit zoom, Escape, control reachability and renderer errors.
Unit tests additionally cover exact references (including brackets), rotation,
repeated sheet annotations, multi-unit symbols, board/source isolation, changing
sources during reads, stale receipts, and 3D raycasting/occlusion.

Physical native validation is macOS only. Nets, arbitrary mechanical models and
models without KiCad component identities are outside this feature.

## Board workspace layout audit

The component toolbar stays directly below the view tabs. Preview status and
sheet navigation follow it, so source messages cannot push the toolbar down.
All three comparison panes retain the shared highlight even when only one
pane has keyboard focus. At narrow widths, selection and zoom controls wrap;
action and source-status menus stay within their pane. Escape dismisses component
actions before clearing the selection.

The native smoke check includes both divider keyboard limits, drawing/control
bounds, simultaneous highlights, native clicks in all three views, animated linked
focus, rapid reselection, reduced-motion emulation, centered Focus,
3D framing at divider limits, 24 rapid selections while alternating window sizes,
material restoration, menu bounds, Escape dismissal and expansion/reopening without selection loss. Captures cover
1440×920 and 960×600. The audit covers this board workspace and its component
selection controls; it is not a claim that every application screen, theme, or
platform has been exhaustively audited.
