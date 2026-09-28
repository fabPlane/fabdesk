# H6 durable asynchronous routing evidence

Date: 2026-09-17 (Asia/Bangkok)

Base: `92b2473d8f48cc231814cf9350b527a9e2caaeb7` (accepted H5 candidate)

Branch: `experiment/async-routing-h6`
Worktree: `/home/shane/fabdesk-async-routing-h6`

Recommendation: **GO** for an isolated non-model integration evaluation.

## Contract and lifecycle

- `route_run` keeps its existing router, deadline, target, rule, and settings inputs. It adds
  `applyPolicy: "auto" | "manual"` (default `auto`) and now returns a durable route ID normally in
  under two seconds rather than holding the request for the router lifetime.
- `route_status({runId?})` reads the latest or exact persisted run. Its compact record includes
  phase/pass, routed/total/remaining, violations when reported, elapsed/deadline/timestamps,
  heartbeat freshness, start/current PCB revisions, candidate and application states, at most 20
  recent diagnostics, and durable artifact paths. Copper geometry and complete router logs remain
  in files.
- `route_cancel({runId})` now requires the exact route ID and is idempotent. It cannot cancel a
  different project or newer route.
- `route_apply({runId, expectedPcbRevision})` is new. It applies one validated candidate only when
  the expected, starting, and current PCB revisions agree; it reopens the written board and restores
  the prior bytes on any failure.
- Compatibility: `route_run` remains the start capability and auto-apply remains the default, but
  callers that previously expected the terminal result from the start response must now poll
  `route_status`. `route_cancel` no longer accepts an ambiguous empty request.

The route run ID is the authoritative public and persistence identity. The bridge's internal job ID
does not escape as a competing identity. The core-owned `RouteTaskQueue` retains every task promise,
serializes routes per project, and permits independent projects to run concurrently.

State machine:

`queued -> running -> completed | timed_out | failed`

`queued/running -> cancel_requested -> cancelling -> cancelled`

On daemon startup, any persisted nonterminal state becomes `interrupted`. A completed candidate has
its own `manual | pending | applying | applied | stale | rejected | failed | not_available`
application state and remains separate from computation state.

## Snapshot, candidate, and apply identities

At start, Fabdesk hashes `board.kicad_pcb`, copies the exact bytes plus `board.kicad_pro` into the
run's isolated snapshot, and routes only that snapshot. The canonical board is never exposed to
incremental router writes. A usable terminal result preserves:

- `candidate.kicad_pcb`, addressed by SHA-256 and `<runId>:<hash-prefix>` identity;
- full `result.json`, `frames.jsonl`, and `router.log`;
- compact `progress.json`; and
- `diff.json`, covering footprint placement/geometry, outline/board geometry, nets, tracks, vias,
  zones, keepouts, texts, and remaining connectivity.

Footprint, outline, net, keepout, text, and unauthorized zone changes reject the candidate. Apply is
an atomic whole-native-board replacement guarded by the exact revision. The previous bytes are kept
in memory until reopen validation succeeds and are atomically restored if it fails.

## Controlled timeout-class reproduction

`scripts/async-routing-h6-controlled-qualification.ts` reduces the observed 300-second MCP timeout
class to a deterministic 350 ms slow route. The old synchronous boundary occupied the request for
350.510 ms. H6 returned the durable start handle in **11.352 ms / 611 bytes** while routing continued.
An independent status call returned in **1.130 ms / 1,993 bytes**, reporting pass 1, 2/7 routed,
5 remaining, 5 violations, and a fresh heartbeat. Final status returned in **0.442 ms / 3,091
bytes** with a reopenable candidate. The canonical SHA-256 remained
`a5a3b8945f071aae3fb8d918e5c40192c603e398d3a584853d37bc6e45b09297`.

The dedicated controlled suite additionally proved:

- exact cancellation reaches only the named worker, is idempotent, produces `cancelled`, and leaves
  canonical bytes unchanged;
- manual completion preserves a candidate without changing the canonical board;
- expected-revision apply succeeds and returns the candidate revision;
- stale manual and auto apply preserve the ready candidate and do not mutate the edited board;
- a controlled reopen failure restores the prior native bytes and persists `application=failed`;
- per-project serialization queues a second route while another project remains independent; and
- startup recovery marks active work `interrupted` while retaining candidate metadata and artifacts.

## Packaged real-router smoke

One isolated capacity-router smoke used a disposable two-resistor synthetic project, fresh core and
bridge ports/state/socket directories, and packaged KiCad at
`/home/shane/fabdesk-evals/builds/shared-001/pcb-linux-x64/kicad/bin/kicad-cli`, version **10.99.0**.
It did not use PCBGolf or any existing project/runtime.

- Run: `run_mu5dvtwdhij4kz`; runtime: `async-routing-h6-real-smoke-final`.
- Start: **12.564 ms / 804 bytes**, state `running`.
- First independent status: **2,110 bytes**, state `running`.
- Final status: **3,525 bytes**, state `completed`; route elapsed 1,231 ms.
- Apply: **1,386.101 ms / 507 bytes**, state `applied`.
- Starting/canonical-before-apply revision:
  `60b212a0f0feee1a85e0ff1127f998bc153cfc5f1697d241e6c506fe98139ee2`.
- Candidate/result revision:
  `a8df10116d365416a17e4b8158ea23b362684d5da90df2a5b90cef68ecbbb5c1`.
- Candidate reopened, routed 2/2 connections, added 12 track rows and no vias, changed remaining
  connectivity from 2 to 0, and changed none of footprint placement/geometry, outline, nets, zones,
  keepouts, or texts.

Only the smoke-owned core, bridge, and KiCad children were stopped. Its disposable directory was
moved to trash after evidence capture.

## Qualification results

- Controlled async lifecycle: **5 passed**, 0 failed.
- Core route queue: **1 passed**, 0 failed.
- `@fabdesk/tools`: **61 passed**, 0 failed (includes H1-H4 native inspection/edit/routing focused
  coverage and H6).
- `@fabdesk/core`: **231 passed**, 2 optional native-KiCad tests skipped, 0 failed (includes DB,
  HTTP, restart, and queue coverage).
- H5 saved hierarchy focused suite: **3 passed**, 0 failed.
- Workspace typecheck: passed for core, desktop, relay, and every root package.
- Relevant executable: `apps/core/dist/linux-x64/fabdesk-core` built successfully (1,331 modules).
- `git diff --check`: passed.
- Real packaged-router smoke: passed.

A whole-workspace `bun run test` was also attempted. All affected tools/core suites passed, but the
unaffected `@fabdesk/kicad` `boardStats` test selected the host KiCad CLI, whose older command set
lacks `pcb export stats`. Forcing global `KICAD_CLI` conflicts with that package's bundled-preference
tests. This environment-only failure is outside the H6 changes; the required packaged 10.99 runtime
was separately proven by the real smoke above.

## Limitations

- The available packaged bridge did not contain a Freerouting jar, so the bounded real smoke used
  the packaged capacity router. Freerouting's progress schema is supported and controlled lifecycle
  behavior is router-independent, but this qualification did not run a real Freerouting job.
- Freerouting exposes an applicable candidate only after its bridge job returns a summary. If it
  cannot emit a partial session before cancellation, process exit, or daemon interruption, Fabdesk
  truthfully records that no partial candidate is available; it does not manufacture one from
  progress frames.
- Interrupted computations are not resumed after restart. They remain durably queryable as
  `interrupted`, with any already-written candidate/artifacts preserved and never auto-applied.
