# Board workflow against stock Claude Code: paired slice, 2026-11-12/13

The question: does Fabdesk with the board workflow do PCB work better than a stock agent? A small paired slice (owner
approved: 4 tasks, one run per arm), on the same boards, tasks and model, graded the same way.

## Setup

- Harness: `~/pcb-cmp/harness` (`slice-2026-11-12.sh`, `slice-2026-11-12b.sh` for the Fabdesk re-runs on the PR branch).
  Tasks in `~/pcb-cmp/tasks`; results in `~/pcb-cmp/results-slice-2026-11-12`; one job at a time under a 24 GiB scope.
- **stock**: Claude Code 2.1.322, `claude-opus-5-5`, effort medium, no MCP servers, bypass permissions, kicad-cli nightly.
- **bw**: Fabdesk core from this branch (worktree `~/fabdesk-worktrees/integration`), same model and effort, the board
  toolset, KRT installed on demand into the arm's data dir, TraceMaker 0.12.1.
- Grading: `grade.py` copies start and final project and runs the Python toolkit's `check_acceptance` (A1-A9, refilled
  DRC, schematic parity) on both, plus the task's geometric check and collateral (parts moved, nets changed). PASS =
  task check passes, nothing regressed, nothing else moved. The grader is independent of the code under test.

## Results

| Task | Board | stock | bw (commit) | How bw got there |
| --- | --- | --- | --- | --- |
| cm5-cap (ECO, schematic + board) | cm5_minima, 6 layers | PASS, 460 s | PASS, 496 s (340db2b7) | `board_edit` + `board_check` (11 `board_*` calls) |
| vme-reroute (reroute IC10's nets) | vme-wren, 12 layers, 1508 parts | PASS, 1695 s | PASS, 3836 s (ffd59fac) | KRT `finish` ran past its budget on the whole 160 x 233 mm board; the agent cancelled it and wrote its own grid router in Python, then `board_check` |
| jetson-reroute (reroute U14's nets) | jetson, 10 layers, 1125 parts | PASS, 1090 s | PASS, 2644 s (ffd59fac) | KRT `finish` routed all 40 opens but also stubbed ~20 other nets; the agent hand-built a board with only the target nets' copper |
| jetson-usbswap (swap two USB-C ports + support parts) | jetson | **FAIL**, 8715 s (board untouched) | **FAIL**, timeout at 10829 s (6c39aacb; board untouched) | `board_edit` built the swap (40 parts) as a candidate; its last mile took the candidate from 152 opens to 1 (`finish`, rejected for a new `solder_mask_bridge` DRC class) or 2 (`rip`, rejected: a USB pair worse); targeted pair re-routes ran 12-30 min each on jetson and the 180-min limit ended the run before anything was adopted |

## What the slice found (and what was fixed)

Fabdesk's runs on the two large boards exposed defects that unit tests and parity on small boards had not. Each was
fixed on this branch before the next run:

| Run | Defect | Fix |
| --- | --- | --- |
| vme / jetson, bw at 52e07b66 | `project_set_board` capped `layers` at 8: the run stopped at project setup on 10- and 12-layer boards | bcb48677 (32 layers) |
| vme, bw at 23d7bf2b | three parallel KRT candidates, each estimated at ~4 GiB (0.06 GiB/MB of file) while one used 16.25 GiB: OOM | 7c3eb8ec, 41999ccf (grid-based estimate, refusal when it cannot fit, light scan) |
| vme, bw at ffd59fac | a candidate past its budget was still scored | 83718a48 |
| jetson-reroute, bw at ffd59fac | `finish` changed ~20 nets beyond the open ones; the gate accepted it | 6d6a10b5 (`finish` keeps only the open nets' new copper; every `try` line names other nets changed) |
| (review of 6d6a10b5) | `keepCopperOfNets` quadratic: ~8 min on jetson | da13d7c6 |
| jetson-usbswap, bw at ffd59fac | `board_edit` compute inside the daemon: impact 151 s of blocked event loop, apply >6.8 GiB; the core grew to 20 GB and the machine ran out of memory | 39e767b9, e4b50da8, 75ad8907 (edit in a child process: daemon peak 0.10 GiB, event-loop lag 4 ms; cancel kills the child's group; no orphans) |
| jetson-usbswap, bw at 39e767b9 | the merge rebuilt the 86 MB board text per copper item (`addNewCopper`, `replaceCopper` 512 s, `nameCopperNets`, `removeSpans`, `splice`): the daemon sat at 100% CPU > 10 min | bb711538, bc5d7912 (one-pass rebuilds: `replaceCopper` 4.9 s) |
| jetson-usbswap, bw at bc5d7912 | two parallel KRT candidates on a 7.5 GiB estimate; a rip / pair-routing run reached 12.9 GiB: OOM | 6c39aacb, c5a65d56 (board-content term reserves; only the grid term refuses) |

## Reading the results

Both arms passed three of four tasks and left the USB-C swap board unchanged. Fabdesk took longer on each task in this slice; the reroute runs also needed agent-written routing or copper edits. This slice does not establish an advantage over stock Claude Code. It exposed the integration and resource defects listed above. Later Codex held-out results are recorded separately in PR #448; these measurements used earlier commits and should not be read as a repeat of those runs.
