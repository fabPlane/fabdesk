# Enclosure software validation — 30 October 2026

PR #398 adds a guarded prototype enclosure workflow. Software checks and slicing are evidence for review; they do not certify a manufactured assembly.

## Multi-board follow-up — 2 November 2026

- Layout search now tries up to 12 deterministic orders, connection-priority orders and positions beside fixed obstacles. Optional print-area limits include the case body walls. Comparison runs in a dedicated worker without repeating native intersections; the built-app eleven-board comparison produced three choices in 1.1 seconds (55 timer ticks, 36.5 ms longest interval, background timer throttling disabled for automation).
- Optional cable planning searches conservative three-dimensional orthogonal corridors around substrate/component boxes, mounts, obstacles and previously planned cables. It reserves bend radius and cross-section, checks routed length plus slack, and blocks an unsuccessful requested route. Straight guides remain clearly distinguished from planned corridors. Endpoint connector exit direction, exact holder/lug geometry, ribbon twist and physical cable dimensions still require review. Planning is bounded and sequential, not globally optimal.
- Assembly review now highlights obstructed assumed screwdriver corridors. The assumed diameter is 6 mm or the larger entered screw head; this does not establish actual tool access or retention strength.
- Native checking skips non-solid planar artwork before conversion and releases intermediate solids per board. Limits are 500,000 triangles per board and 1,500,000 per assembly; a failed board no longer exhausts later boards' budget or inflates checked coverage.
- Six real boards: unrestricted cavity changes from 215 × 120 to 255 × 100 mm (1.2% less area). Eleven real boards: unrestricted 325 × 130 mm unchanged. With a 250 × 250 mm case-body limit, the eleven-board result is 190 × 225 × 20 mm inside, with all six inferred external ports at their walls. The case and lid pass independent slicing with no warnings; STEP reads as two solids and ZIP hashes match.
- Eleven-board native coverage improves from 307 to 314 closed bodies. All ten exporter-compatible boards are considered; the combined peripheral A2 file still requires KiCad 10.99 or newer. No known native collision blockers; 132 sampled assembly positions clear for loaded bodies. Missing models, seven unsupported boards, screw dimensions, five screwdriver-access concerns and unmeasured ports remain explicit review items.
- **118 focused tests / 735 assertions pass**, as do root typecheck and core/desktop builds. Broader Windows packages: 732 pass, five existing failures (four CLI-probe shims and a CRLF-sensitive stencil fixture), also present in earlier baseline-compared logs. Protocol, client-core and UI packages pass. The prior PR CI failure was an outdated aperture fixture missing evidence records; it now checks both unknown and documented dimensions correctly.

These are mechanical stress collections, including alternative revisions, not a validated electrical VAIO system. No verified cable map was supplied for this collection, and no custom harness was created. Cooling, mass distribution, material strength, screw pullout and physical assembly remain unverified. Original VAIO PCB hashes were checked and source files left unchanged. See [multi-board evidence](enclosure-multiboard-validation.json) and the [actual app preview](screenshots/mechanical-workspace/60-eleven-board-preview.png).

## New behavior

- Generated case and lid are boolean-joined separately with Manifold 3.5.4. Export rejects open, empty, non-positive or disconnected parts. STL and faceted STEP use the same joined boundary. Imported results must also pass a closed-solid audit.
- Optional four-screw closure searches 18 placements along both wall pairs to avoid ports, plugs, boards and obstacles. Screw bore, wall thickness and engagement are checked. Rectangular PCBs without holes can use corner feet/fences and lid capture pegs; unsafe corners and overlaps block export. Automatic placement reserves room for these holders.
- Footprint `Height` / `Height (mm)` properties supply measured component heights. Existing exact USB4105 / DM3D-SF profiles remain. Measured plug access now includes removal travel.
- Optional fresh native KiCad GLB checks intersect closed bodies with the case, lid, other boards and reserved obstacles. Independent board/obstacle gaps are checked. Collision regions are shown in red. Missing, open and oversized model coverage stays visible; conservative checks still run.
- Export adds `lid-print.stl` with the outside face at Z=0, `geometry-validation.json`, physical-check instructions and printable connector/pilot-hole samples. The manifest hashes all outputs. Original PCB files remain untouched.

## Verification

- **125 affected tests / 801 assertions pass.** Includes bores, holder retention/collisions, automatic lug alternatives, disconnected/open rejection, flipped lid, rounded samples, native collision/clearance rejection, failed model coverage, imported broken results and source preservation.
- Root typecheck, compiled Windows daemon and desktop production build pass. The compiled WASM export smoke succeeds. No source maps in build outputs.
- **12 independent Bambu Studio slices succeed with empty warning messages and nonzero extrusion.** Cases/lids: tiny 20×12 mm dongle, 120×24 mm hub, 180×120 mm controller, screw/holder fixture, real two-board VAIO-derived assembly; plus connector and pilot samples. These are slicer checks, not physical prints. See [machine-readable results](enclosure-v1-validation.json).
- Independent OpenCascade STEP imports of four fixture assemblies succeed, with one case and one lid mesh each.
- Two unchanged VAIO-derived PCB copies: 138 closed native bodies checked in approximately 8.4 seconds; eight open surfaces explicitly excluded. Missing component models and unmeasured mating dimensions remain review items. A lug/USB clash was detected, then eliminated by the bounded lug search. The final preview has zero blockers and ten review notes. Coordinated ZIP hashes match.
- Live UI: lid selection and detailed-check toggle persist through preview; blocked geometry disables export; corrected layout enables it. Checked checkbox alignment and captured actual app screenshots.
- Full Windows workspace suite: **35 failures**, all 35 reproduced by an isolated unchanged `265bcaf7` checkout with its own dependencies/submodules. No failure unique to this patch. This is not a claim that the entire suite passes. CI must be checked separately at the pushed revision.

![Lid and holder controls](screenshots/mechanical-workspace/51-lid-and-holders.png)

![Joined case review](screenshots/mechanical-workspace/50-solid-review.png)

## Physical validation still required

Print the small fit samples first with the intended printer/material. Fit actual screws, plugs/cards and boards. Check board restraint, lid closure, underside solder joints, insertion/removal, cable bends and cooling. Record results before calling any assembly production-ready. No physical print or assembly was performed in this software session.

## Remaining limits

Corner holders support only clear rectangular boards at quarter-turn rotations, and require a screwed lid. Arbitrary PCB shapes require mounting holes or custom restraint. The automated lug search is bounded, not a global mechanical optimizer. Generated shells are rectangular cavities. Imported models require the native CAD bridge; imported automatic lid hardware is not implemented.

Detailed checks use tessellated closed solids, with a 0.01 mm³ intersection threshold and bounded model sizes (250k triangles per board / 500k assembly). They do not prove load strength or all support-contact tolerances. Cable lengths/slack and reserved spaces are checked; full flexible cable routing and bend-radius optimization are not implemented. Missing component models cannot be checked accurately. Arbitrary connector contours are not inferred from 3D models; users must measure unknown parts. Slicer settings and material shrinkage are printer-specific.

## Follow-up model coverage audit

The 30 October follow-up fixes a false-complete case: a footprint with only hidden models no longer counts as loaded. Model review now distinguishes unassigned, hidden, failed and partially loaded models, lists the linked files, and places failed model loads before bare pads. The fit-review export retains every affected reference and repair reason.

Native planar surfaces close to a PCB face are reported separately from broken component solids. Named component models are never excluded by that classification. The eight VAIO surfaces are planar layers near the board faces; they remain excluded from solid intersections, with solder/surface-contact review explicitly required.

- 10 focused regression tests / 45 assertions pass, including hidden-model coverage, missing paths, component-versus-layer classification and the rendered repair actions/order.
- Root typecheck and desktop production build pass.
- Fresh two-board native check: 138 closed bodies, zero blockers, approximately 7.6 seconds. No source PCB edits.
- Actual app inspection: repair cards wrap within the panel and prioritize U9/U10/U8 over unassigned test pads.

![Model coverage with repair actions](screenshots/mechanical-workspace/52-model-coverage.png)

**Still unresolved in the supplied VAIO design:** U8, U9 and U10 have linked models that did not load; C17/C18 have no assigned model. The other unassigned footprints are test pads and solder jumpers and require solder/access review. The USB and card openings still need actual mating-plug/card measurements. These findings cannot be resolved by declaring the missing geometry accurate. Physical print/assembly results are still absent.

A follow-up corner-holder trial on the same actual boards was **blocked**, correctly: the holders collide with USB-board TP1 and the small board's J1/J2 connectors, and obstruct card access. The accepted zero-blocker preview has no validated board-retention method. It must not be described as an assembly-ready VAIO case. See the local report for the complete rejected candidate; no candidate was saved to the project or exported for printing.

## Adaptive edge retention follow-up

`Find clear edges` adds four distributed underside supports, outside-anchored lid captures and two low end stops. It searches both edge pairs and 65 positions per edge, retaining component, drill, obstacle, mounting-post, opening and plug keepouts. If no supported layout fits, export is blocked. This is a bounded search for rectangular boards, not a universal restraint or a strength certification.

The same two VAIO-derived boards that failed the corner-holder trial now have a candidate with edge retention and no known solid collisions. A fresh native check covers 138 closed bodies, with the same missing-model and physical-review limitations. Both chosen holder settings persist in the app. The original board sources still match their hashes.

Each edge holder uses a 2 × 4 mm underside support and a 0.5 mm capture lip, with 0.25 mm nominal engagement at maximum lateral play. End stops retain at least 0.2 mm engagement after vertical play. These are prototype dimensions: print and load-test the real assembly before relying on them. Board-specific fit gauges accompany the export. An initial gauge orientation produced a slicer floating-region warning; printing on the extrusion end face resolves it.

Recessed linked openings now use actual mating-reach checks rather than incorrectly labeling an aligned opening as missing. Unknown plug measurements remain review items; short measured plugs still block export.

Validation:
- 37 focused geometry/access tests / 240 assertions pass, including four board rotations, occupied corners, underside components, drill keepouts, blocked end stops, thin boards, lid requirements, joined exports, gauges and recessed plug reach.
- Root typecheck, Windows daemon compilation and desktop production build pass; no source maps in outputs.
- Full Windows suite: 34 failures, all present in the unchanged `265bcaf7` baseline's 35 failures. One prior MCP failure did not recur; no new failure was found.
- Current VAIO case, lid and both board-thickness gauges slice with positive extrusion and no warnings. OpenCascade imports the current STEP as two solid meshes. ZIP hashes match. See [current slicing results](enclosure-edge-validation.json).

![Adaptive holders in the actual app](screenshots/mechanical-workspace/53-edge-retention.png)

![Simple edge-holder controls](screenshots/mechanical-workspace/54-edge-controls.png)

**Current remaining evidence:** physical printing/assembly and retention-load tests; actual plugs/cards and manufacturing tolerances; U8/U9/U10 linked model failures, unassigned C17/C18 models, and solder/jumper/pad access. The earlier statement that the accepted preview has no retention method applies to the previous corner-holder trial, not this new candidate. The new candidate has software-checked retention geometry, but no proven physical fit.

## Portable models and manufacturer-model follow-up

A separate VAIO QA copy now links U8/U9/U10 to official TI STEP models: [TPS25730 / REF0038A](https://webench.ti.com/cad/cad.cgi?partno=TPS25730), [BQ25798 / RQM0029A](https://webench.ti.com/cad/cad.cgi?partno=BQ25798), and [TPS568230 / RJE0020A](https://webench.ti.com/cad/cad.cgi?partno=TPS568230). The board's saved part numbers match these packages. Independent STEP measurements are 6 × 4 × 0.8, 4 × 4 × 1 and 3 × 3 × 1 mm respectively. Only three model-path tokens changed; the original VAIO sources and earlier test project were preserved.

This test exposed and fixed an export bug: PCB files previously left their local model dependencies behind. Coordinated exports now include project-owned model files and portable links, retain exact original PCBs under `source-boards/` when links need rewriting, and hash all packaged content. `model-dependencies.json` lists packaged, missing, unresolved and external references. System libraries remain explicit dependencies. Project jail checks also cover symlink targets. Local model content participates in the preview revision; changes before or during export reject stale results.

Verification:
- 19 tool/export tests / 88 assertions pass, including extraction, nested and absolute board paths, unchanged circuit content, STEP substitutions, model edits, external paths and symlinks.
- Root typecheck and Windows daemon build pass.
- Fresh native enclosure check: 141 closed bodies and zero known collision blockers. KiCad reopened the extracted PCB with all three official IC models present at their expected positions and heights.
- Case, print lid and both holder gauges are byte-identical to the four successfully sliced outputs above. ZIP hashes and original PCB snapshots match.

[Machine-readable manufacturer and export evidence](enclosure-model-validation.json).

![Official IC models in the actual test project](screenshots/mechanical-workspace/55-official-models.png)

The remaining capacitor part was identified from the source order notes as Murata ECASD41E336M040KA0 (C17/C18), also listed in [Murata's reference specification](https://search.murata.co.jp/Ceramy/image/img/A01X/G101/ENG/JECPY1-9012C-01%28ECAS%29%20S.pdf). No exact capacitor model was assigned. The missing-IC limitation above applies to the untouched earlier fixture; the new fixture repairs those three references. Solder/jumper/pad access, actual plugs/cards, manufacturing tolerances, printing and physical retention testing remain unresolved. No hardware testing or physical-fit claim has been made.

## Capacitor clearance and current readiness

The repaired QA copy now also stores `Height = 2.0 mm` and its provenance for C17/C18. This replaces a 1.6 mm generic estimate with the D4 catalog body-height allowance (1.9 ± 0.1 mm) from [Murata C90E, page 2](https://www.murata.com/~/media/webrenewal/support/library/catalog/products/capacitor/polymer/c90e.ashx). It excludes unmeasured solder height, does not assign an exact 3D model, and does not certify physical fit. The catalog identifies its figures as typical specifications. Only height/provenance properties changed in the QA PCB; original repository sources remain untouched.

An isolated test with 1.8 mm available above the PCB previously missed both capacitor bodies; it now reports both collisions. The complete enclosure still reports zero known blockers across 141 closed modeled bodies, while both missing capacitor models remain flagged. Native export accepts the saved properties. Archive hashes match, and the case, print lid and two gauges remain byte-identical to the four previously sliced outputs. See [capacitor clearance evidence](enclosure-capacitor-validation.json).

| Requirement | Verified | Outstanding |
| --- | --- | --- |
| Printable exports | Joined/audited solids, coordinated portable files, slicer toolpaths | Actual print with intended material/settings |
| Lid and retention | Screws, edge holders, gauges and known-geometry checks | Closure, engagement and retention under load |
| Connector access | USB-C/microSD profiles and plug-reach/removal checks | Actual plugs, cards, handling space and tolerances |
| Detailed fit | 141 closed modeled bodies and explicit missing-model/height-envelope review | Exact capacitor models, solder/contact geometry and flexible cables |
| Physical validation | Prototype files and fit samples prepared | Real printing and board/screw/card/cable assembly; no trial recorded |

The full objective remains incomplete. Passing geometry checks or slicing is insufficient to claim a perfect physical fit.


## Dimensional allowance and digital assembly checks — 2 November 2026

- Fixed a zero-clearance locating rim in the guided generated lid. Its nominal gap is now 0.25 mm; optional per-surface allowance increases it by twice that allowance without thinning the rim.
- Optional “Allow for small sizing differences” adds opposing-surface error to cavity, independent-board, obstacle, plug-reach and hardware checks. Newly arranged openings include it; existing openings remain visible for review/resizing. It is a planning assumption, not printer calibration.
- Edge-holder play and capture scale together, preserving 0.25 mm calculated engagement under the assumed error. Search tries 4 mm then 3 mm contact strips without relaxing keepouts. Thin boards or unsafe legacy corner holders block export. Fit samples use the same cross-section.
- Screw checks account for hole/outer diameter and axial variation. The VAIO example uses 10 mm M3-sized screws, a 0.10 mm per-surface assumption, 0.45 mm holder play and 0.90 mm capture. These are checked design inputs, not tested hardware strength.
- Real VAIO QA copy: raised both boards 0.20 mm and moved the small microSD board 1.50 mm away from the wall to clear its end stop. USB supports use 2 × 4 mm contact strips; microSD uses 2 × 3 mm. Existing openings expanded 0.20 mm per edge. Original PCB geometry remains untouched.
- **80 tests / 524 assertions pass**, root typecheck and Windows core/desktop builds pass. Tests cover nominal-fit failures, rim gap/thickness, joined solids, sample consistency, thin boards, dense support strips and opening layout.
- Native validation checks **141 closed bodies**, with **zero known collision blockers**. Case, print-oriented lid and two holder samples each slice with nonzero extrusion and no warnings. Independent OpenCascade reads the case and lid from STEP; coordinated ZIP hashes match.
- Connector scenarios: assumed USB-C plug bodies 12 × 6 × 20 mm, 8 mm reach and 15 mm removal travel; assumed card envelope 11 × 1 × 15 mm, 12 mm reach/travel. These clear the tested layout. Negative controls with 2 mm reach or 80 mm-wide overlapping plug bodies are rejected. These assumptions were **not** saved as verified hardware dimensions.
- Live UI: raising allowance to 0.20 mm exposes three blockers and disables export; restoring 0.10 mm clears them and enables export. Saved settings restore correctly.

[Machine-readable evidence](enclosure-tolerance-validation.json). C17/C18 retain their documented 2.0 mm maximum body-height envelope plus the selected fit clearance. No exact manufacturer capacitor model or assembled solder-height measurement was obtained. Physical fit/strength is still unverified; this remains a prototype workflow.


## Assembly paths and dimension evidence — 2 November 2026

- Optional **Check straight-down assembly** samples rigid removal in +Z (reverse of downward installation). Each loaded board and the lid are checked at 12 positions against the case, other installed boards and reserved obstacles. An observed intersection produces a review card and 3D region. Clear samples are not a continuous-motion proof; assembly order, angled insertion, cables, tools and strength remain outside the check.
- The VAIO assembly had no obstruction at 36 sampled positions across its two boards and lid. Native preview took approximately 12 seconds; final-position collision blockers remain zero. Missing component models remain explicit.
- Opening and plug dimensions now carry separate source records: assumed, manufacturer drawing, or measured hardware. A nonblank reference is required to remove the assumed-dimensions review. Changing a dimension or opening shape resets its evidence to assumed. Existing designs are never silently treated as measured.
- An explicitly specified aperture without a fitting opening now blocks export. Merely inferred openings retain review status. Custom entries are labelled “Custom dimensions,” and per-side clearance is displayed to two decimal places.
- **103 focused tests / 681 assertions pass** across ten files. Includes an obstructed assembly path despite a clear final pose, unobstructed samples, cancellation, evidence persistence, empty references and undersized apertures. Root typecheck and Windows core/desktop builds pass. Live UI confirms stale evidence is reset after a numeric edit; temporary QA references were discarded.
- Case, print lid and both holder samples match the previously sliced files byte for byte. Export manifest hashes verify. No additional slicing was needed for unchanged geometry.
- Further capacitor research did not obtain a verified exact downloadable 3D file. The manufacturer D4 drawing still supports the retained 2.0 mm maximum body-height envelope; neither that drawing nor entered evidence proves assembled solder height or physical strength.

[Machine-readable assembly and evidence results](enclosure-assembly-validation.json).

## 2026-11-02 — board controls and port-wall regression

- Selecting a board exposes Camera, Move, Rotate, Turn 90°, and Lock/Unlock in every enclosure step. Position editing no longer depends on opening a disclosure on the Boards step. Moving or rotating invalidates the old preview; ports and fit must be checked again.
- Walls with openings now use continuous polygon profiles. The former rectangular subtraction discarded strips under 0.05 mm; a regression with two nearly aligned openings reproduced a slit above the ports. The same test now passes for the joined solid, and wall-vent tests inspect actual mesh openings instead of counting box pieces.
- Fit review warns about thin material beside an edge or between opening envelopes. This is a conservative spacing check, not a strength certification.
- Validation: 82 focused tests / 420 assertions pass; root typecheck and Windows core/desktop builds pass. Built-app mouse dragging moved a board center from X 48.18 to 77.2484 mm; the rotation ring changed 90° to 157.1033°. Turn 90°, Undo, and lock gating were exercised. The user's seven-board imported-case draft was restored exactly after testing.
- A separately regenerated six-board VAIO case passed native preview with no detected blockers. The new wall was visually inspected in the actual 3D renderer. The isolated-wall screenshot shows the generated geometry; it does not certify the connector dimensions.
- Still unresolved: the CM5 I/O board's J1 is `USB_Micro-B_Molex-105017-0001`, currently using a generic 7 mm connector-height estimate (7.8 mm opening with default clearance). The [Molex drawing](https://www.molex.com/content/dam/molex/molex-dot-com/products/automated/en-us/salesdrawingpdf/105/105017/1050170001_sd.pdf) was located but its dimensional callouts could not be verified in this environment. Do not treat that opening as exact. Recorded connector/plug evidence and physical validation remain required.
- Existing imported STL geometry is preserved; rebuilding a generated case does not repair previously imported files. Imported-solid editing remains dependent on the CAD bridge, unavailable locally on Windows.

### 2026-11-02 — Intermittent outline-only boards

- Fixed progressive PCB model refresh: loading one board no longer removes other valid models. A failed refresh retains the loaded model only for the same project and PCB revision. Successful same-revision cache entries survive failed refreshes; tab/selection changes reuse loaded geometry instead of forcing another export after Refresh.
- Changed PCB revisions and other projects still discard stale models. Cancellation stops obsolete loads from publishing into the next view.
- Unavailable selected boards now explain that the amber shape is estimated bounds, with model details and retry below.
- Reproduced in the running desktop with six real VAIO models and controlled delayed responses: before the fix, visible detailed models dropped from six to one, then ended at five after one refresh failed. After the fix, all six remained throughout the same test. The real exporter was restored after fault injection.
- Three full Add → Arrange → Enclosure and Case → Preview → Boards cycles retained all six models without WebGL context loss. Compared the recovered draft with the pre-reload draft: unchanged. A hidden-window timing test hit the automation timeout; the visible-window repeat passed.
- Validation: 16 targeted model loading/decoding/batching tests, 63 assertions; root typecheck and desktop production build passed.
- Separate compatibility limitation: `combined-peripheral-a2` requires KiCad 10.99 or newer and cannot be exported by this installation. Its amber bounds are intentional fallback, not recovered detailed geometry. No source PCB files were converted or changed.

### 2026-11-02 — One-click Auto arrange

- A visible Auto arrange button is available at the top of every enclosure step. It runs the existing compact, port-aware deterministic search in a Web Worker and applies the result as one undoable draft edit, with automatic framing and a fit-review reminder. Advanced comparison remains available.
- Uses matching native model bounds where available; preserves locks, obstacles, imported-case dimensions and configured case-size limits. Imported interiors must be confirmed first. Empty selections and all-locked boards explain why arrangement is disabled. Failed searches leave the design unchanged.
- Real seven-board VAIO test: the configured 245 × 120 mm limit rejected the search without modifying the draft. Temporarily removing the limit produced a 150 × 180 × 16 mm interior and five detected external openings. Undo restored the exact previous poses, then the original size limit. No project save, PCB edit or export was performed by Auto arrange.
- The combined peripheral board remains an estimated envelope because the installed KiCad cannot export its newer file format; the screenshot makes this visible. Auto arrangement still requires Preview and fit review, and is not a proof of printability or a globally optimal solution.
- Checks: 20 layout/setup/history tests, 99 assertions; root typecheck and desktop build passed. Final UI typecheck passed after clearer size-limit/loading messages. Screenshot: `screenshots/mechanical-workspace/63-auto-arrange.png`.

### 2026-11-02 — Resize case to fit

- A generated case with a size limit now offers **Resize case to fit** beside Auto arrange. This explicit one-click action removes the cap, sizes the enclosure around the selected boards and applies their placement in one Undo step. The success message shows outside dimensions; subsequent automatic placement is labelled **Auto arrange & size**.
- The original Auto arrange action retains a configured cap. Imported cases and fixed wall constraints are never silently resized. Locked boards, obstacles and manual openings require review before removing the boundary constraint.
- Tests cover a too-small cap becoming a valid clearance-safe generated case, unchanged input, and rejection of imported/fixed cases. Layout/setup/history: 22 tests, 108 assertions. Root typecheck and desktop build passed.
- Live seven-board test: Resize case to fit produced a 150 × 180 × 16 mm interior / 154 × 184 × 20 mm exterior with five detected external openings. Undo exactly restored the starting poses and 245 × 120 mm cap; Redo exactly restored the resized design. Left the resized draft open, unsaved, with Undo available. Detailed geometry for the newer-format combined board remains unavailable; fit/preview review is still required.

## 2026-11-02 — combined peripheral model and camera depth

- The lower-right amber rectangle was the combined-peripheral-a2 board: its source requires KiCad 10.99+, while this machine used 10.0. Installed the signed official 10.99 nightly alongside 10.0 and selected its CLI in local FabDesk settings. This is a local prerequisite change, not a bundled KiCad upgrade.
- All seven selected VAIO boards now load real GLB geometry, including the combined board (7,248,448 bytes). Its PCB SHA-256 remains `4bad50642edb8d0b5ddbe0771f41c4e974b34e3b379114ce47bda7d3ad687dd0`; no source board was rewritten. The previous unavailable-board notes above describe earlier checks.
- The newer exports exposed depth-buffer interference between closely spaced PCB surfaces. Camera clipping now follows the assembly bounds, view and zoom instead of spanning almost zero to tens of thousands of millimetres. Cached assembly bounds avoid traversing all meshes during ordinary orbiting.
- Validation: 12 rendering/camera tests, 767 assertions; root typecheck and desktop build pass. The regression checks 0.01 mm layer separation and visible bounds at different distances/orientations. Reloaded the built app, checked top/3D views and zoom with seven actual models and no lost graphics context. Restored the exact draft values and Undo history.
- Component coverage remains incomplete: combined board has 61/104 footprint models loaded. Missing/unassigned entries include foreign absolute paths, unavailable custom parts and bare pads; no guessed replacements were added. Preview/fit checks and physical verification are still required.

![Seven real boards including the restored lower-right combined peripheral board](screenshots/mechanical-workspace/65-combined-board-restored.png)

## 2026-11-02 — guided setup, fit actions and recovery

- Added a visible board-loading card with loaded/selected counts, an explanation of amber placeholders and retry/setup actions. A read-only preflight compares the PCB saving version with the local exporter. It offers an already installed newer exporter when available; only the user's button changes the app setting. Saving-version comparison is advisory, and actual export remains the compatibility check. The flow does not download KiCad or guess missing component models.
- **Arrange & fit case** now places boards, sizes a generated case within existing constraints, aligns detected external openings and creates the checked preview in one action. A separate Placement only disclosure retains the lightweight layout action. Explicit Resize case to fit releases a generated-case cap. Existing/fixed cases and locked parts retain their constraints; Undo restores the prior design.
- Fit warning actions highlight the relevant region and select the affected board with Move controls, or open the specific model/settings section. Two-board collision messages identify the first affected board as well as single-board boundary warnings.
- A single readiness card distinguishes a missing preview, blocked export, prototype export with review items, and prototype export without known blockers. Detailed geometry/printing notes stay in the checklist rather than repeating status cards. No state certifies physical fit.
- Same-revision unsaved drafts restore automatically; changed saved revisions still require a recovery choice. Equivalent objects with reordered JSON properties no longer create phantom edits. The enclosure step, selection and camera survive tab changes/reload within the session. Background assembly loading no longer resets an already opened enclosure panel, and an unframed camera cannot overwrite a remembered view.
- Existing camera/board tool separation, Fit view, simple defaults and Advanced disclosures remain in place. Model refresh still retains only geometry matching the same PCB revision, avoiding stale models being mistaken for the current design.

### Verification

- 45 focused tests / 904 assertions pass: readiness response envelopes, version comparison, path containment, recovery conflicts, corrupted camera preferences, revision-safe model retention, history, setup, export gates and rendering. Root typecheck and desktop production build pass; no source maps in the built app.
- Separate seven-board VAIO QA project; original project PCB files were not edited. With KiCad 10.0 selected deliberately, the actual failure remained visible and the new installed-version button selected 10.99 and reloaded all seven models. A synchronous tool-response handling issue found during this exercise was fixed and regression-tested.
- One-click placement completed with a joined case/lid preview, zero known blockers and 39 review items. Undo restored the original QA draft. A board moved outside the case produced red highlighting; its warning action selected the board and enabled Move. Automatic recovery retained the edited draft and selection; camera coordinates after reload/tab changes matched within 0.000001 mm.
- Missing component models, assumed dimensions, cable/assembly limits and physical printing remain review work. These UI changes do not resolve those engineering uncertainties.

Measured final Arrange & fit case run: 24.8 seconds from click to completed seven-board preview. Original/QA copies match for all 11 source PCBs. [Machine-readable evidence](enclosure-experience-validation.json).

![One-click preview and export readiness](screenshots/mechanical-workspace/67-arrange-fit-preview.png)

![Warning action selects the red board and opens Move](screenshots/mechanical-workspace/68-actionable-fit-warning.png)

## Faster, simpler enclosure workflow (2026-11-02)

- Replaced competing arrange/placement/preview buttons with one footer action and a compact board-layout selector. Measurements appear when a board is selected (or on Boards); advanced hardware follows the basic choices. View options start collapsed and stay collapsed when the panel grows.
- Generated cases show joined shell geometry before detailed model checks finish. The early result is explicitly unverified, contains no export revision, and cannot unlock export. Checks continue automatically with fresh native exports, exact intersections, clearance and assembly-path sampling enabled.
- Native export concurrency is bounded at two. Failed boards remain explicit findings; cancellation drains running exports before scratch cleanup. Conservative bounding-box separation prunes only solid operations that cannot affect the result.
- Real seven-board comparison: native detailed checks fell from 24.2 to 16.2 seconds with identical issue messages. In the built app, the joined case appeared after 1.6 seconds; full checking finished in 18.1–19.5 seconds across two runs versus the previous 24.8-second run. The live result retained 0 blockers and 39 review items. These are local observations, not guaranteed timings on other machines.
- 45 targeted tests / 211 assertions pass, including bounded concurrency, cancellation, failures, exact collision preservation, unverified-preview export rejection and pending-check presentation. Root typecheck and desktop build pass; no source maps in output. The full monorepo suite was not rerun for this change.
- Built-app failure recovery: a deliberately interrupted full check kept export disabled and offered Preview case again. Retry completed successfully. The final panel has one primary footer action and no horizontal overflow. Original VAIO draft and Undo history were preserved.
