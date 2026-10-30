# Enclosure software validation — 30 October 2026

PR #398 adds a guarded prototype enclosure workflow. Software checks and slicing are evidence for review; they do not certify a manufactured assembly.

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
