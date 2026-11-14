# Board workflow

The board toolset (`load_toolset {"toolset":"board"}`) is the method for taking a placed board to a releasable one. **The owner gives
intent; the tools handle the rest.** Intent is goals, constraints, preferences and decisions, kept in
`.fabdesk/board/review/intent.json` (`goal`, `constraints`, `decisions` with `covers` patterns that settle matching findings in every
later run, `preferences.ask_owner_for` / `workflow_decides`; `board_review intent_init` writes the skeleton, `intent_decide` records an
owner answer). Rules, placement, routing, edits, review and fixes are the tools' and the
agent's job. A gate is never a bare block: every open item carries a proposal (who acts, what it does, what it changes in
practice); ask the owner only for what intent does not decide, recommended option first.

**Everything here is a default with proof attached, not a fence.** Take any path: your own plan, your own check, a hand fix. What stays
fixed is the evidence: every change goes through the same proof, and every departure from a default is recorded with its reason.

```
onboard ─► layout (place · rank · route) ─► last mile ─► review ─► release
                       ▲                                    │
                       └──────── edit (ECO) ◄───────────────┘   every edit makes the review stale
```

| Stage | Tool | What it does in one line | Gate before the next stage |
| --- | --- | --- | --- |
| 1 onboard + check | `board_check` | derives the board's requirements on first use, then measures A1-A9 on the saved board and compares with the board as onboarded; a board saved by KiCad 9 or older is refused until `upgrade: true` (a checked copy written over it, the previous board kept) | your review of the onboarding proposals, recorded with `board_check {"confirm": true}` |
| 2 layout | `board_route` check · place · rank · route · auto · status · courtyards; floorplan path: blocks · floorplan · block_eval · placement | fail-fast preflight, seeded placements (KRT seeds, or block passes from your floorplan) gated on courtyard DRC, ranked by routed opens, then the best seed routed (30-60 min in all) | `route` PASS (few enough opens) |
| 3 last mile | `board_route` new · try · loop · sweep · pairs · why · crossings · fit · validate · accept | tries rip, route, pair and placement steps in parallel on the whole board, keeps the best one that improves the gate, undoes the rest | A1-A9 pass |
| 4 edit | `board_edit` | an ECO as a plan across board, schematic and requirements: impact, candidate, repair of cut nets, A1-A9 proof, planned-versus-collateral diff, adopt | 0 collateral |
| 5 review | `board_review` | whole-board review (22 checks, silk labels among them) bound to one design hash; findings with proposals, dispositions, gate, fixes as proven candidates; `autopilot` runs review, fixes and leaves only the owner's questions | gate 0: current, every finding settled |
| 5b silkscreen | `board_silk` | judges every label from KiCad's exact shapes, places the ones that fail, shows silk over copper | no label problems |
| 6 release | `board_release` | BOM and JLC rotations, Gerber render check, release readiness, via fill and cap (`vias`), the fabrication package behind its gates | the gates below |

Where a request starts (then follow the stages from there):

| Asked to ... | Start with |
| --- | --- |
| check or review a board, find faults before ordering | `board_review {"action": "run"}`: ERC, DRC with parity, A1-A9, pin functions against datasheets, decoupling, supply widths and current (with a supplier stack, the complete inner-power audit), impedance, ratings, connector mouths, BOM, silk labels, in one pass as findings with evidence; then read for what checks cannot judge (values against the circuit's intent) |
| say where a board stands, what to do next | `board_check` (A1-A9, then the review and release state and one next step) |
| add, remove, move, swap or reconnect parts | `board_edit` (a plan; it repairs cut nets and proves the result) |
| route nets that are open, fix pairs, widths or DRC | `board_route` last mile (`new`, then `try`) |
| fix silkscreen | `board_silk` |
| check that cables reach between boards (multi-board product), or after moving a connector | `board_review {"action": "cable", "chassis": "chassis.json"}`: every catalog cable in every stated frame (PASS/FAIL, slack, flags); `boards` swaps in an edited board, `sweep` finds where on an edge a connector gives the most slack; a PASS is reach in the stated frame, not installed fit |
| prove a pair's impedance on a stack, or bound a short off-impedance stretch | `board_review section` (atlc finite-difference cross section from `spec`: a pair's width, gap, copper, heights, er, etch, mask; solve at two `pixelMm` sizes for convergence) or `board_review short_section` (lossless reflection at the edge knee per case); nominal 2D figures, not assembled SI |
| show or compare boards, or what an edit changed | `board_review page` (KiCad-plot page of one or more boards with opens and DRC errors) or `board_review diff` (old -> new change picture) |
| produce the fab package | `board_release fab` for a release (its gates: settled review, A1-A9 or owner exceptions, BOM); for a board the owner approved as it is, `board_release cam` (Gerbers from a fresh zone fill, drill, BOM, placement, render check; one call) |

Long jobs return a job id: `board_job` waits for, reports or cancels them. One heavy job runs at a time; the resource governor queues the rest.
Engines (KiCadRoutingTools, TraceMaker, atlc for `section`) install themselves the first time a step needs them (minutes, with progress lines;
nothing to preinstall; atlc is built from source and needs a C compiler unless the system has one); `board_engines` shows their state or installs
ahead. A set override (`FABDESK_KRT_DIR`, `TRACEMAKER_BIN`, `ATLC_BIN`) is used as given.

**The board's acceptance checks (A1-A9).** Each board carries its own definition of done, written at onboarding into
`.fabdesk/board/requirements/` (you own the numbers). The same nine questions apply to any board, each judged against that board's data:
**connectivity** (A1), **drc** against its rules (A2), schematic/PCB **parity** (A3), **circuit** unchanged from its source (A4),
**anchors** in place (A5), **stack** and via spans as declared (A6), power **widths** for their current (A7), differential **pairs**
coupled (A8), **heights** within the limits (A9; not set when the board has none). DRC is the project's own rule severities with
owner-excluded items left out. A board that came in already failing is judged by no new failure against its first result; name each
pre-existing failure. A board whose acceptance does not keep its native rules (onboarded bare) is judged on the acceptance's classes and rules:
they are written into each scored copy's project file first, and the release writes them into the project (a change stops it: run the review again).
A courtyard overlap counts in A2 unless its two footprints are named in the acceptance's `courtyard_overlap_exceptions` (with the measured gaps
and basis); `inner_neck_allowance_mm: 0` on a power class makes every inner segment below its inner width fail A7 (no neck allowance).

### Working rules

- **Layout.** Many opens after `route` are a placement problem: restructure the block or try new seeds before tuning the router. Judge seeds on
  routed results over several seeds (router noise is large), move whole blocks rather than one part in a crowded corner, one TraceMaker job at a time.
  When seeds keep failing in one dense block, give it structure: `blocks` lists the board's blocks (sheets, split ones by anchor IC), you write
  `.fabdesk/board/layout/floorplan.json` (groups of blocks or explicit parts with a region each, in order, pinned poses, rows along a signal path
  as sub-groups), `floorplan` places group by group with the rest locked (a gated result joins the seeds for `rank`), `block_eval` judges one
  block alone over 2-3 placer seeds, `placement` scores any placement before routing (HPWL, 90-degree turns that save >= 15 %, congestion,
  via sites); check a rotation idea there before trying it.
- **Courtyards.** A pads-only courtyard can be smaller than the part: `board_route {"action": "courtyards", "refit": "J101", "bodies": "requirements/part-bodies.json"}`
  rebuilds only the named footprints' courtyards round pads and datasheet body (body drawn on Fab); nothing else changes.
- **Last mile.** Order: rip, taps, pairs-all, leg | blockers:1.0 (try both in parallel), a7, bundle per pair bundle, pairs, validate. What is left
  after that is placement: crossings, then `fit` (dry run of one nudge), then nudge or `sweep`. A step that does not improve the whole-board gate is
  undone. Do not rip whole wide power nets. `why` names what walls each open end. A pair counts only when coupled; `pairs` splits each uncoupled mm
  by cause (`loose` is fixable in place; `on_pad`, `between`, `escape` come from pads, pinout and vias; `apart` needs a re-route). Pairs on a routed
  board: `tighten` first (vias, mirror, retune, width, tighten, skew, no router), then `loop` with `reroute:{pair}+shorts+blockers:1.0+tighten`.
  Pairs routed apart (coupled share near 0) need `bundle:REGEX` instead. Through a tight connector fan-out (0.5 mm pitch, ESD parts in line)
  KiCadRoutingTools routes the short legs single-ended; add modifiers after the action: `!short` couples them (its short-leg rule lowered to
  1 x setback / 1 mm; the installed KRT is not edited), `!match[=MM]` length-matches P/N as they route, `!outer=COST` sets the F.Cu/B.Cu
  cost of the pair stages (the templates use 20; 2 when the pads and legs are on an outer layer). E.g. `bundle:HDMI!short!match!outer=2`,
  then the same for a pair still apart with the others in place, then `tighten`. They fit any action that routes pairs as pairs (`pairs`,
  `pairs-all`, `bundle`, `reroute`, `route`, `region`, `nudge`, `plan:FILE`).
  `pairs` also gives each pair's connected path pad to pad (tails and branches left out), the length the signal runs; tune length matching to
  that, not to the segment sums. With a floorplan, finish block by block: `replace:GROUP` rips the group's region, re-places it there with the
  rest locked and routes again. To redo a region with the placement kept: `region:X0,Y0,X1,Y1` (or `region:opens~1.5`, boxes round each open
  end) cuts all copper there and routes again, cut pairs as pairs; `region:...!escape` adds the power escapes on the ripped board first; `cut:BOX`
  only cuts, so you can chain your own steps before `route`. `view` draws a window with the DRC markers, optionally only some copper `layers`,
  and with `candidate` a try's board instead of the current step.
  Rip, route and nudge steps run KiCadRoutingTools plans; when KRT cannot be had (install error, broken override, auto-install off) a step
  that needs it fails naming why, and `finish`, `fill:ROUTER`, `tighten` and the power steps still run. A router step can also rewrite
  nets that were not open (KRT's `finish` did on large boards); each `try` line says which other nets a candidate changed, and a candidate
  that closed opens and changed other nets gets a `NAME~scoped` sibling with those nets' copper put back, scored like any other and preferred
  on equal figures. For a "change only this" task, accept a candidate that changed no other net (the `~scoped` one), never splice copper by hand.
  To re-route a few nets on a large board, `opens` (finish limited to the nets open now) returns in a minute or two where `finish` can take
  ten or more; try both in one `try`. New tracks can also split another net's copper pour, so that the refill islands a pad that was connected:
  the try line says `split a pour: NET on LAYER`, and the bench retries that step once as `NAME~avoid:LAYERS` with those layers out of reach
  of its router plans (inner layers left out, F/B at layer cost 10). The layers are the split ones, outer layers with pours near the new
  tracks, and inner layers that carry pours but little track. A candidate that split a pour ranks after every passing one that split none;
  take the `~avoid` result rather than writing a router plan by hand. Power copper without a router: `escape` (pad-width bridges and stubs at fine-pitch
  power pins narrower than their class, within the 1 mm neck rule; chain a router, `escape+finish`), `planes:FILE` (a split power plane on an
  inner layer from a plan JSON) and `pour` (net zones over open power connections, never thinner than class width; it closes an open only where
  the copper fits, not a structural one). The TraceMaker route plan takes the same as `planes` / `escape` before routing.
- **Edit.** Write the change as a plan (remove, move with `to` or `near`, displace, swap, add, net; `legalise` seats test points at the free
  spot nearest their net's other pads, many in one plan). `impact` first: a STOP is your decision. A `near` pose that lands on other nets'
  copper is named in impact with the nearest pose that cuts none: take it with the move's `clear: true` (and a radius that reaches it)
  rather than probing `to` poses one by one, or keep the first pose and let the repair route the cut nets.
  Three keys are local fixes on the routed copper, never routing: `copper` (a filled/capped via at a pad with `via_at_pad`, dead ends pruned
  with `prune_signal_leaves` / `prune_track_leaves`, copper removed by uuid with `remove_items`, `source_sha256` pins the board you read);
  `hole` (resize an NPTH locating hole to `size_mm`, round or oval, with its courtyards, keep-out and library footprint); `stack` (a
  supplier stack-up and rule plan: class updates and `split_classes`, an `acceptance` merge, `dielectrics` epsilon_r, `remove_vias` each
  with a reason, or `copper_source` to take a bench result's board). Each is proved like any other edit; repair what a tighter rule fails
  with the last mile, not with coordinates in the plan.
  When an edit displaces a dense region, stop editing and re-place with the moved parts as anchors.
  The owner's DRC exclusions follow the edit: when a part the owner had excluded moves with its partner, or an identical part takes its
  place (a swap), the proof re-keys that exclusion in the candidate's project file, scores again and prints one `DRC exclusion carried` line
  each (rule, parts, old -> new); anything else that the edit makes newly fail is a real violation, and `not carried` says why. Adopt writes
  the candidate's exclusions into the project (that key only). Never copy a candidate's board or project file by hand: adopt also carries the
  requirements (anchors, circuit) and works when the board was saved by a newer KiCad than the app's (it writes the file and says so).
- **Review.** One design hash covers board, schematics, project files and requirements; any change makes the review stale. Settle each finding with
  evidence: a must-fix is fixed, or accepted by the owner (or by you with evidence when intent allows); a false-positive needs a third source
  (neither the design nor the check); a question closes with any disposition that has a reason. A fix candidate is READY only when the proof
  passes, the finding is gone, no new finding appears and 0 nets are collateral. `fix` with `apply` also proves every READY edit applied together
  (the combined candidate: one change per board) and writes a change picture beside each READY candidate; `try` puts your own plan
  through the same proof for the finding ids it should fix; `autopilot` is review if stale, then `fix` with `apply`, then only what needs
  the owner. Starting an independent reviewer on the expert pack costs an agent run: ask first. On a board whose acceptance records a
  `supplier_stack` (or with `review.inner_power`), the `inner_power` check audits every current-declared inner net completely: terminals
  by pin type, track and via resistance with no pour credit, the supplier's etch taken off every width, IPC-2221 heat on every inner
  segment and a 2 % drop; a missing or disconnected terminal is a must-fix, not a pass.
- **Release.** `board_release fab` refuses, writing nothing, unless in order: the interconnect gate (none for a standalone project), the review
  gate for this exact board, A1-A9 with parity (an exception only with an owner decision), via-in-pad and microvia fill and cap bindings; then CAM is
  exported twice with identical hashes and the Gerbers are rendered and compared with KiCad's plot. Package only a board whose review covers that exact version.
  A via STOP: `board_release vias` names the vias in pads and the microvias; `apply: true` sets fill and cap on them (the order must then ask
  for filled, capped vias), or move the vias out of the pads.
- **Look at the board** (`render_view`, `board_route view` / `info`) rather than parsing it ad hoc. Let the tools author tracks and vias; hand
  coordinates are fine when they are the better path.
- **Hard limits** come only from the owner's intent and project policy: hard constraints, interconnect contracts, no powered work, purchases or supplier messages.

### Defaults you may depart from (record why in the plan or disposition)

| Where | Default | Why |
| --- | --- | --- |
| After onboarding | review planes, fixed parts, power widths from current, pair width/gap from the stack | onboarding guesses; you know the circuit |
| Before place | pass-through parts of pairs (series R, filters, ESD) seated on their chip pins: `.fabdesk/board/layout/templates/`, written by the layout check (edit or drop rows); add datasheet templates for switchers and dense serializers | placers do not read datasheets |
| Place / route STOP | treat many opens as a placement problem | placement was the bigger lever when measured |
| Last mile | the step order above; check placement moves with `fit` first | a step that does not help is undone anyway |
| Edit | write the change as a plan | tool-made changes are reproducible and proven |
| Review | settle each question with evidence | evidence is what makes a review mean something |
| A rule vetoes a real gain | change the rule or gate and record its basis | gates are provisional |

Housekeeping: board copies (seeds, candidates, tries, review runs, adopt backups) fill disk quickly; `board_route clean` lists the reproducible
ones with size and reason (`apply: true` deletes them; candidates that can still be adopted and accepted steps stay), `board_route prune`
deletes one workspace's unused last-mile candidates, and the layout check refuses below 10 GiB free.
