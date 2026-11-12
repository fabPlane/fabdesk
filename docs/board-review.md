# Board review

`board_review` (toolset `board`) is the whole-board design review of the board workflow. It is a port of the toolkit's review
stage to `packages/board-workflow/src/review`; parity figures are in `docs/evidence/board-workflow/review-parity.md`.

A review covers one design hash (board, schematics, project files, requirements, `review.hash_extra`). A finding is a question
with evidence, severity `must-fix | question | note`, and a proposal (who does it, what it changes, how to apply it). Notes
never block. A question closes with any disposition that has a reason; a must-fix closes when it is fixed (it disappears on the
next run), by an owner `accept`, or by an agent `accept` with evidence when the owner's intent allows it; `false-positive` needs a
third source; `fix` on a finding still present stays open. Dispositions are keyed by finding id and carry to later runs.

| action | what it does |
|---|---|
| `run` | the checks, then `review.json` / `review.md` under `.fabdesk/board/review/runs/<time>-<hash>/` and the gate in the project's status. `checks` limits it (a partial run is not the project's review); `offline` skips network symbol lookups; `trustCustom` runs the project's custom check commands. |
| `gate` | 0 pass, 1 none or stale, 2 open, 3 check errors; open items lead with their proposal (owner items first). |
| `dispose` | `id` (a trailing `*` matches a prefix), `state`, `by`, `reason`, `thirdSource`. |
| `fix` | every open finding's proposal; `apply` records the workflow's dispositions. Edit proposals come back with their plan; nothing is built until the edit stage is wired in. |
| `import_expert` | an independent reviewer's findings (`file`) into the current review. |
| `status` | current or stale, finding and open counts. |

Checks (layers): identity, netlist (L0); erc, drc grouped by type, acceptance A1-A9 on the same DRC (L1); pinsense, cards,
evidence (L2); decoupling, current, impedance, ratings, manual (L3); mouth (L4); interconnect gate (L5; none for a standalone
project, a hook for a host); bom, coverage (L6); custom; pack (L8). `silk` is the silk stage's check and registers through
`runReview`'s `extraChecks`.

Files under `.fabdesk/board/review/` (all optional): `config.json` (settings: `checks_only`, `checks_skip`, `hash_extra`,
`currents`, `net_voltages`, `decoupling`, `current_check`, `impedance`, `mouth`, `assembly`, `manual_review`, `native`,
`custom`), `intent.json` (owner decisions that settle findings they `cover`, and `preferences`), `cards/*.json` (project rule
cards), `checks.d/*.json` (checks as data: a command that prints findings as JSON). Shipped data (rule cards, interface
profiles, JLC oracle errata, escapes, seeds) is in `packages/board-workflow/data/review/`.

The reviewer never edits a design. Starting a fresh-context reviewer on `pack/EXPERT-BRIEF.md` is the owner's call.
