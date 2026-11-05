# Placement UX human test — November4

Start: native fabPlane Dev at b71a342, preserved fresh-user-flow profile; existing Button light project. User runtime layout19.5×9.75mm is unsaved; preserve it. No source setup mutation.

| Step | Visible action/path | Expected | Actual | Status | Evidence/friction |
|---|---|---|---|---|---|
|1|Placement → selectedPCB tab|Obvious exit to savedPCB|Click works, but selected tab conceals mode switch; Back may point elsewhere|Passed with friction|01-before-placement.png|
|2|SavedPCB → lowerleft Edit placement|Discover editing among task controls|Editing sits beside Fit/zoom/Comment at bottom edge, far from Routing/Checks|Passed with friction|02-before-pcb-entry.png|
|3|Connections → All connections|Visible meaningful links|No explanation; single-ended unconnected nets listed; lines faint/hidden by part fills|Passed with friction|03-before-connections.png|
|4|Canvas tools|Find basic selection/navigation/Undo|Select/Pan/Undo/Redo/footprint/area/snap all inside one popup|Passed with friction|04-before-hidden-tools.png|
|5|+Footprint|Understand whether adding a circuit part|Large42package dialog, disabled pad filter for additions, empty comparison half|Passed with friction|05-before-footprint-library.png|

## Change list and retest plan

P1 entry/exit: expose Edit placement beside PCB task actions and persistent Back to PCB. Retest without menus/history.
P1 editing vocabulary: Editing placement + Save layout + Create PCB copy, one short source-state explanation. Retest understand savedPCB unchanged and routecopy next step.
P1 connections: draw airwires above footprint fills with legible dashed links/endpoints, selected-component mode and net labels; exclude single-ended nets from link choices. Retest chosen LED net visibly connects correct pads, explain not copper.
P1 basictools: persistent Select/Hand + Undo/Redo + Fit; scoped keyboard shortcuts must respect typing, disabled preview and otherpages. Explicitly requested shortcut test is part of this human test, not a bypass. Retest clickmove/undo/redo, cmdZ/shiftcmdZ, textfieldundo, temporarySpacepan.
P2 pageownership: remove enclosure entry from canvas placement; preserve underlying classic functionality. Footprint geometry comparison stays contextual; additions advanced and explicitly unconnected.
P2 popupsize: task-specific library empty state, no redundant disabled additionfilter, consistent imported-filebutton. Retest choose→preview→cancel without adding unintended circuit.

User-supplied seven screenshots are reported evidence, independently reproduced above where indicated. Before/after remain distinct. Fixes authorized in same request.

Research: Figma official toolbar/Hand tool guidance (https://help.figma.com/hc/en-us/articles/360041064174-Access-design-tools-from-the-toolbar); KiCad official PCB editor documentation (https://docs.kicad.org/8.0/en/pcbnew/pcbnew.html) distinguishes schematic-defined nets, airwires and actual routed traces; NN/g visibility/recognition principles (https://www.nngroup.com/articles/ten-usability-heuristics/). Applied as design rationale, not evidence of app success.

## Retest of revised UI

Native clicks and normal typing in the existing project, preserving the user's 19.5 × 9.75 mm layout:

| Step | Visible path | Actual outcome | Status |
|---|---|---|---|
|6|PCB task row → Edit placement → Back to PCB → Edit placement|Dedicated entry/exit works; original drawing and preserved layout remain separate|Passed|
|7|Arrange → R3|Two labeled dashed guides (BUTTON_OUT, LED_ANODE) appear above the footprints; legend explains these are not copper|Passed|
|8|Change R3 X13.09→13.34; Undo/Redo|Buttons restored13.09/reapplied13.34; final Undo restored the original test coordinate|Passed|
|9|CmdZ / CmdShiftZ with editor focus|Undid/redid the same move. CmdZ in parts search undid text only, without moving the board|Passed|
|10|H → drag canvas → V|Panned view without moving parts; switched back to selection|Passed|
|11|Compare pad pattern → choose0805 → Preview|Current/new dimensions, pad numbers and nets shown; preview unapplied with geometry findings|Passed|
|12|Preview → Back to PCB → Leave preview|Explicit confirmation; discarded preview and reopened earlier six-part layout|Passed|
|13|More placement options → Add unconnected footprint → Cancel|Task-specific explanation, full-width grid, styled file action; no enclosure duplicate and no component added|Passed|
|14|Create PCB copy → Create copy & continue|Native exported a separate unrouted KiCad file and opened the named working-copy dialog automatically; cancelled new-project creation|Passed|
|15|Space-held drag; narrow viewport; Windows CtrlY|Not exercised with available native controls in this pass|Not tested|

The earlier source-bound integration already tested actual new-project/routing continuation; this pass verifies the revised export/handoff and cancellation, not another routed-board result. Save layout persistence was not re-exercised; no test move was saved over the user's layout. Existing overlap warnings are layout geometry findings, not electrical checks.

Native automation briefly reported noWindowsAvailable for scrolling and stale AX diffs. Rebinding and fresh observations recovered; these are recorded as test-tool friction, not an app success. Numeric context distances changed while the asynchronous analysis refreshed; obsolete response guards now prevent older requests from winning. This is not a claim of physical clearance validation.

Checks: UI typecheck passed;299 UI tests passed,0 failed; desktop production build passed;0 emitted .map files;git diff --check passed. File verification: all previously existing project files retained the same SHA256; the only new file is the explicit placement-copy PCB. Original PCB, schematic, netlist and prior outputs unchanged.

Evidence:06-after-pcb-entry.png,07-after-selected-airwires.png,09-after-add-footprint.png,10-after-copy-handoff.png.08 is retained as an intermediate capture, not used as final evidence.
