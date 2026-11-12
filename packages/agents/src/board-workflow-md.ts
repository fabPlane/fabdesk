/**
 * The board workflow as the agent reads it (AGENTS.md section) and as docs/board-workflow.md (same text; a test keeps them
 * equal). Adapted from the toolkit's WORKFLOW.md to the tools of the `board` toolset.
 */
export const BOARD_WORKFLOW_MD = `## Board workflow

The board toolset (\`load_toolset {"toolset":"board"}\`) is the method for taking a placed board to a releasable one. **The owner gives
intent; the tools handle the rest.** Intent is goals, constraints, preferences and decisions, kept in
\`.fabdesk/board/review/intent.json\` (\`goal\`, \`constraints\`, \`decisions\` with \`covers\` patterns that settle matching findings in every
later run, \`preferences.ask_owner_for\` / \`workflow_decides\`). Rules, placement, routing, edits, review and fixes are the tools' and the
agent's job. A gate is never a bare block: every open item carries a proposal (who acts, what it does, what it changes in
practice); ask the owner only for what intent does not decide, recommended option first.

**Everything here is a default with proof attached, not a fence.** Take any path: your own plan, your own check, a hand fix. What stays
fixed is the evidence: every change goes through the same proof, and every departure from a default is recorded with its reason.

\`\`\`
onboard ─► layout (place · rank · route) ─► last mile ─► review ─► release
                       ▲                                    │
                       └──────── edit (ECO) ◄───────────────┘   every edit makes the review stale
\`\`\`

| Stage | Tool | What it does in one line | Gate before the next stage |
| --- | --- | --- | --- |
| 1 onboard + check | \`board_check\` | derives the board's requirements on first use, then measures A1-A9 on the saved board and compares with the board as onboarded | your review of the onboarding proposals |
| 2 layout | \`board_route\` check · place · rank · route · auto · status | fail-fast preflight, seeded placements gated on courtyard DRC, ranked by routed opens, then the best seed routed (30-60 min in all) | \`route\` PASS (few enough opens) |
| 3 last mile | \`board_route\` new · try · loop · pairs · why · crossings · validate · accept | tries router and pair steps in parallel on the whole board, keeps the best one that improves the gate, undoes the rest | A1-A9 pass |
| 4 edit | \`board_edit\` | an ECO as a plan across board, schematic and requirements: impact, candidate, repair of cut nets, A1-A9 proof, planned-versus-collateral diff, adopt | 0 collateral |
| 5 review | \`board_review\` | whole-board review (20 checks) bound to one design hash; findings with proposals, dispositions, gate, fixes as proven candidates | gate 0: current, every finding settled |
| 5b silkscreen | \`board_silk\` | judges every label from KiCad's exact shapes, places the ones that fail, shows silk over copper | no label problems |
| 6 release | \`board_release\` | BOM and JLC rotations, Gerber render check, release readiness, the fabrication package behind its gates | the gates below |

Long jobs return a job id: \`board_job\` waits for, reports or cancels them. One heavy job runs at a time; the resource governor queues the rest.

**The board's acceptance checks (A1-A9).** Each board carries its own definition of done, written at onboarding into
\`.fabdesk/board/requirements/\` (you own the numbers). The same nine questions apply to any board, each judged against that board's data:
**connectivity** (A1), **drc** against its rules (A2), schematic/PCB **parity** (A3), **circuit** unchanged from its source (A4),
**anchors** in place (A5), **stack** and via spans as declared (A6), power **widths** for their current (A7), differential **pairs**
coupled (A8), **heights** within the limits (A9; not set when the board has none). DRC is the project's own rule severities with
owner-excluded items left out. A board that came in already failing is judged by no new failure against its first result; name each
pre-existing failure.

### Working rules

- **Layout.** Many opens after \`route\` are a placement problem: restructure the block or try new seeds before tuning the router. Judge seeds on
  routed results over several seeds (router noise is large), move whole blocks rather than one part in a crowded corner, one TraceMaker job at a time.
- **Last mile.** Order: rip, taps, pairs-all, leg | blockers:1.0 (try both in parallel), a7, bundle per pair bundle, pairs, validate. What is left
  after that is placement: crossings, fit, nudge. A step that does not improve the whole-board gate is undone. Do not rip whole wide power nets.
  A pair counts only when coupled; \`pairs\` splits each uncoupled mm by cause (\`loose\` is fixable in place; \`on_pad\`, \`between\`, \`escape\` come from
  pads, pinout and vias; \`apart\` needs a re-route).
- **Edit.** Write the change as a plan (remove, move with \`to\` or \`near\`, displace, swap, add, net). \`impact\` first: a STOP is your decision.
  When an edit displaces a dense region, stop editing and re-place with the moved parts as anchors.
- **Review.** One design hash covers board, schematics, project files and requirements; any change makes the review stale. Settle each finding with
  evidence: a must-fix is fixed, or accepted by the owner (or by you with evidence when intent allows); a false-positive needs a third source
  (neither the design nor the check); a question closes with any disposition that has a reason. A fix candidate is READY only when the proof
  passes, the finding is gone, no new finding appears and 0 nets are collateral. Starting an independent reviewer on the expert pack costs an agent run: ask first.
- **Release.** \`board_release fab\` refuses, writing nothing, unless in order: the interconnect gate (none for a standalone project), the review
  gate for this exact board, A1-A9 with parity (an exception only with an owner decision), via-in-pad and microvia fill and cap bindings; then CAM is
  exported twice with identical hashes and the Gerbers are rendered and compared with KiCad's plot. Package only a board whose review covers that exact version.
- **Look at the board** (\`render_view\`, \`board_route view\` / \`info\`) rather than parsing it ad hoc. Let the tools author tracks and vias; hand
  coordinates are fine when they are the better path.
- **Hard limits** come only from the owner's intent and project policy: hard constraints, interconnect contracts, no powered work, purchases or supplier messages.

### Defaults you may depart from (record why in the plan or disposition)

| Where | Default | Why |
| --- | --- | --- |
| After onboarding | review planes, fixed parts, power widths from current, pair width/gap from the stack | onboarding guesses; you know the circuit |
| Before place | datasheet templates for switchers and dense serializers; pass-through parts facing their pins | placers do not read datasheets |
| Place / route STOP | treat many opens as a placement problem | placement was the bigger lever when measured |
| Last mile | the step order above; check placement moves with \`fit\` first | a step that does not help is undone anyway |
| Edit | write the change as a plan | tool-made changes are reproducible and proven |
| Review | settle each question with evidence | evidence is what makes a review mean something |
| A rule vetoes a real gain | change the rule or gate and record its basis | gates are provisional |

Housekeeping: board copies (seeds, candidates, tries) fill disk quickly; \`board_route prune\` deletes unused last-mile candidates and the layout check refuses below 10 GiB free.
`;
