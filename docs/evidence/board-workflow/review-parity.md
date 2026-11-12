# Board workflow review stage: parity with the Python toolkit

Date 2026-11-12. Oracle: toolkit branch `cmp/held-out-fixes` (`review/review.py run --offline`). Port:
`packages/board-workflow/src/review` (`runReview`). Harness: `packages/board-workflow/test/parity-review.ts` (not part of
`bun run test`; needs the toolkit, kicad-cli and the LCSC cache). Both sides review a copy of cm5_minima (112 footprints) with the
same requirements (onboarded by the port), the same kicad-cli (10.99.0), offline, the same fetch cache (a copy of the toolkit's),
and the same checks. Compared per check: status, the set of finding ids, each finding's severity; claim text and the check's
detail line are compared apart after normalising `5.0` to `5` and whitespace.

Result: on both runs every check has the same finding ids and the same severities as the oracle, and the same status.
Claim text is identical on every finding after that normalisation; three detail lines differ in wording (listed below).

Not covered by these runs (each is listed under "Not ported or not exercised"): the `silk` check, `bomcheck` itself,
the interconnect gate, rule cards matching a part on this board (0 rules evaluated), the `fix --apply` edit candidates,
vme-wren and C6 (not run: a 70 MB board, and the machine-safety rule).

## Run 1: cm5_minima as onboarded, default settings

Oracle: /home/shane/pcb-worktrees/heldout (`review.py run --offline`, 9 s). Port: runReview (7 s). kicad: 10.99.0. Checks: identity, netlist, erc, drc, acceptance, pinsense, cards, decoupling, current, impedance, manual, mouth, interconnect, bom, ratings, coverage, evidence, custom, pack (silk is not ported here).
Findings: oracle 64, port 64. Check errors: oracle none, port none.

| check | status (oracle / port) | findings oracle | findings port | ids same | severities same | claim text same | detail text same |
|---|---|---|---|---|---|---|---|
| identity | ok / ok | 0 | 0 | yes | yes | yes | no |
| netlist | ok / ok | 0 | 0 | yes | yes | yes | yes |
| erc | ok / ok | 3 | 3 | yes | yes | yes | yes |
| drc | ok / ok | 13 | 13 | yes | yes | yes | yes |
| acceptance | ok / ok | 4 | 4 | yes | yes | yes | yes |
| pinsense | ok / ok | 6 | 6 | yes | yes | yes | yes |
| cards | ok / ok | 0 | 0 | yes | yes | yes | yes |
| decoupling | ok / ok | 1 | 1 | yes | yes | yes | yes |
| current | skipped / skipped | 1 | 1 | yes | yes | yes | yes |
| impedance | ok / ok | 2 | 2 | yes | yes | yes | yes |
| manual | skipped / skipped | 0 | 0 | yes | yes | yes | yes |
| mouth | ok / ok | 0 | 0 | yes | yes | yes | yes |
| interconnect | skipped / skipped | 0 | 0 | yes | yes | yes | no |
| bom | ok / ok | 26 | 26 | yes | yes | yes | no |
| ratings | ok / ok | 0 | 0 | yes | yes | yes | yes |
| coverage | ok / ok | 1 | 1 | yes | yes | yes | yes |
| evidence | ok / ok | 6 | 6 | yes | yes | yes | yes |
| custom | skipped / skipped | 0 | 0 | yes | yes | yes | yes |
| pack | ok / ok | 1 | 1 | yes | yes | yes | yes |

## Run 2: cm5_minima with settings that make the quiet checks find something

Review settings (shared by both sides): declared currents on four power nets and three signal nets (rise limit 5 C, drop limit
0.2 %), net voltages, two manual items, mouth edge distance 12 mm, decoupling limits 1.2 / 2 mm, impedance uncertainty 0 and
minimum run 1 mm, assembly sides F only with the board's `pos.csv` as the CPL (so COVER and CPL findings appear).

Oracle: /home/shane/pcb-worktrees/heldout (`review.py run --offline`, 9 s). Port: runReview (7 s). kicad: 10.99.0. Checks: identity, netlist, erc, drc, acceptance, pinsense, cards, decoupling, current, impedance, manual, mouth, interconnect, bom, ratings, coverage, evidence, custom, pack (silk is not ported here).
Findings: oracle 103, port 103. Check errors: oracle none, port none.

| check | status (oracle / port) | findings oracle | findings port | ids same | severities same | claim text same | detail text same |
|---|---|---|---|---|---|---|---|
| identity | ok / ok | 0 | 0 | yes | yes | yes | no |
| netlist | ok / ok | 0 | 0 | yes | yes | yes | yes |
| erc | ok / ok | 3 | 3 | yes | yes | yes | yes |
| drc | ok / ok | 13 | 13 | yes | yes | yes | yes |
| acceptance | ok / ok | 4 | 4 | yes | yes | yes | yes |
| pinsense | ok / ok | 6 | 6 | yes | yes | yes | yes |
| cards | ok / ok | 0 | 0 | yes | yes | yes | yes |
| decoupling | ok / ok | 3 | 3 | yes | yes | yes | yes |
| current | ok / ok | 5 | 5 | yes | yes | yes | yes |
| impedance | ok / ok | 2 | 2 | yes | yes | yes | yes |
| manual | ok / ok | 2 | 2 | yes | yes | yes | yes |
| mouth | ok / ok | 2 | 2 | yes | yes | yes | yes |
| interconnect | skipped / skipped | 0 | 0 | yes | yes | yes | no |
| bom | ok / ok | 26 | 26 | yes | yes | yes | no |
| ratings | ok / ok | 0 | 0 | yes | yes | yes | yes |
| coverage | ok / ok | 30 | 30 | yes | yes | yes | yes |
| evidence | ok / ok | 6 | 6 | yes | yes | yes | yes |
| custom | skipped / skipped | 0 | 0 | yes | yes | yes | yes |
| pack | ok / ok | 1 | 1 | yes | yes | yes | yes |

## Differences from the Python review (my own decisions, with the figures)

1. **Checks: 19 of 20.** `silk` is not ported: it judges KiCad's exact shapes through pcbnew and belongs to the silk stage.
   `runReview` takes `extraChecks` so that stage can register it (it runs before `pack`). The finding rules SILK stay in proposals.
2. **bom** consumes BOM decisions (`.fabdesk/board/release/bom-decisions.json`, or `env.bom`) instead of running bomcheck. With
   none present the check is `skipped`. Parity fed the toolkit's own `bom-decisions.json` to the port: 26 findings on both
   sides, so the record-to-finding mapping (including IDENTITY) is what is compared, not bomcheck. The same records feed the
   evidence and ratings checks.
3. **interconnect** is a hook (`env.interconnect`), default none: status `skipped`, detail "no interconnect gate (none for this
   project)" where the oracle says "no board_id". Same findings (none) on cm5.
4. **custom checks run only with `trustCustom`** (tool input, default false). The oracle always runs them. They are shell
   commands from the project's data files; a project must not execute code unasked. Without the flag the check is `skipped` and says so.
5. **Storage**: `<project>/.fabdesk/board/review/` (`config.json` = the oracle's `review{}` block, `intent.json`,
   `dispositions.json`, `checks.d/`, `cards/` for project cards, `runs/<time>-<hash8>/review.{json,md}`, `latest.json` instead of a
   symlink) instead of the toolkit's board registry. Record schema `REVIEW_V1` and finding ids are unchanged.
6. **Design hash**: the shared `designHash` (project-relative paths, sheets one folder down, requirements) plus `review.hash_extra`
   files. The oracle hashes absolute paths and its flow spec, so the hash values differ and the file count in the identity line
   differs (14 vs 15: no spec file). Staleness semantics are the same (any design file changes it; tested).
7. **Fetch cache** (JLC/EasyEDA symbols): `FABDESK_FETCH_CACHE` or `~/.cache/fabdesk/lcsc`, same record format as the toolkit's,
   so one cache serves both; the parity run used a copy of the oracle's. Network fetches keep the source's 1.2 s spacing.
8. **`acceptance` check** runs the ported A1-A9 (`checkAcceptance`) on the same DRC JSON instead of the Python script; it is
   skipped when the project has no requirements (the oracle: no flow spec). The PWR_* proxy hand-off to A7 applies when requirements exist.
9. **Gate classification**: the "candidate" and failed-candidate classes read `review/fixes/combined.json` and
   `fixes/*-repaired/review-hash.json` (what the edit stage writes when it builds candidates); with none, those classes are empty.
10. Float formatting in claim text follows Python's `:g`, `:.nf` and `str(float)` where the claims use them; evidence JSON is written
   with Python's separators. A float that Python prints as `2.0` and JSON.parse reads as `2` prints as `2.0` only where the value is
   known to be a float (coordinates, widths); a claim built from a JSON-sourced integer-valued float could still read `2` against `2.0`.

## Not ported or not exercised

- `fix --apply` building edit candidates (edit.py ladder, editbench proof, re-check, combined candidate, `change.html`),
  `review try` (the agent's own plan through the same proof) and `--no-build`: they need the edit stage. `fixProposals` lists every
  proposal, settles the workflow's disposition proposals, and returns edit proposals with their plan (`EditCandidateBuilder` is the
  hook the edit stage implements). The change picture (`diffBoards`, `changePage`, `changeSvgStandalone`, `changeSummary`) is ported and
  unit-tested but nothing calls it yet. The edit plan shape in proposals is the toolkit's (`move` with `near`/`make_room`, `add` with `like`).
- Fresh-agent L8 expert launching: not done by design (needs owner approval). The pack, `EXPERT-BRIEF.md` and `import_expert` are ported.
- `review bench` (escape replay, `escapes.json`): not ported or run; its boards (C6-eco95, R1N, A2v5, replay-*) are not available here
  and C6 is large. The data file is shipped in `data/review/`.
- Seeds: `test/review-seeds.ts` plants the three kinds that need no edit tool (config, narrow, touch). The 11 shipped seeds in
  `seeds.json` are on C6-eco95 and R1N-bom boards: 6 of them are `edit` seeds (they need the edit stage) and the other 5 (config, narrow, touch) need those C6/R1N boards, which I did not run. **The 11/11 expectation was not reproduced and was not run.**
  Instead, on cm5_minima, with seeds of my own that use the same mechanisms (below), 3 of 3 plantable seeds were caught.
- Rule cards: 6 cards ship (copied unchanged); none matches a cm5 part, so card parity is unit-tested only (walk, severity by
  `source_kind` and `checked_against_datasheet`). The same holds for the pinsense erratum path and net-name role contradictions
  (R, O): cm5 gave 6 pinsense findings, equal on both sides; the rules are also unit-tested on a small netlist.
- Pack content: both sides write renders (3), parts.json, findings.json, copies and the brief; the files were not compared byte for byte (the check's status, finding and detail line agree).
- vme-wren and C6 were not reviewed (machine-safety rule; vme-wren is a 70 MB board).

## Seeds on cm5_minima (my own seeds, same mechanisms as seeds.json)

Seeds file kept with the harness run, not shipped. Checks per seed: identity, netlist, current, coverage.

| seed | class | result | by |
|---|---|---|---|
| cm5-top-only-order | L6 assembly coverage (config seed) | caught | L6:COVER:Module301:- L6:COVER:R108:- L6:COVER:U401:- |
| cm5-narrow-power | L3 copper vs current (narrowed tracks) | caught | L3:HEAT:-:-:+3V3_PI |
| cm5-edit-after-review | L0 stale review (touch) | caught | gate before edit: exit 0; after: exit 1 |
| cm5-an-edit-seed | needs the edit stage | NOT PLANTED |  |

Score: 3/3 planted seeds caught (4 seeds, 1 not planted).

## Reproduce

```
bun packages/board-workflow/test/parity-review.ts --board /home/shane/pcb-cmp/cm5_minima/proj2 --out DIR
bun packages/board-workflow/test/parity-review.ts --stress --cpl /home/shane/pcb-cmp/cm5_minima/pos.csv --board /home/shane/pcb-cmp/cm5_minima/proj2 --out DIR
bun packages/board-workflow/test/review-seeds.ts --seeds SEEDS.json --base cm5=/home/shane/pcb-cmp/cm5_minima/proj2 --out DIR
```
