# Board and cross-device regressions

The board run in `desktop-mobile-board-run.md` is split into three repeatable suites. The split
keeps failures attributable: router algorithm changes belong in `fabPlane/fab_pcb`; the tool
pipeline and both clients belong here.

## Fabdesk board pipeline

`docs/router-cases/manifest.json` is the case list and `scripts/board-regressions.ts` is the runner.
It drives a real daemon and bridge through exactly the public tool path:

```
create -> build -> place -> DRC before routing -> route -> DRC after routing -> delete
```

Run the PR tier against a local daemon:

```bash
FABDESK_URL=http://127.0.0.1:47831 FABDESK_TOKEN=... bun run regressions:boards:pr
```

Use `--case <id>` for one case and `--output <file>` for the JSON report. The PR tier contains a
small known-passing board. The nightly tier adds the reduced failures from the 22-board run.

The pre-route report is the placement/compiler baseline. Unconnected items are expected before a
route; courtyard, footprint and pad-edge errors found there are not attributed to the router. The
post-route check subtracts errors already present in that baseline and reports only errors routing
introduced. Gating cases reject forbidden new rules and open connections. `observe` cases are known
router failures: their cooperative router timeout and quality are recorded until a fix promotes
them to `gate`, but exceeding the runner's hard timeout or a failed bridge health probe always
fails immediately.

Do not baseline exact track geometry or a single DRC total. The useful contract is termination,
truthful open-connection reporting, and zero newly introduced shorts, clearance errors, crossings,
mask bridges and track-to-edge violations.

## Cross-device workflow

Cross-device tests live in fabdesk because `apps/core`, `apps/desktop`, `apps/mobile` and
`packages/client-core` live here. `apps/core/test/cross-device-regression.test.ts` is the fast PR
scenario: two simultaneous event consumers see the same run, one disconnects, and its reconnect
recovers the terminal live-run state and complete message history. UI-specific desktop/emulator
journeys remain a slower nightly/release layer.

## Router corpus

The authoritative pure-router corpus belongs in `fabPlane/fab_pcb`. Its fixtures should be the
normalized `RouteInput` presented to the router, so compiler or footprint-library changes cannot
silently change the test input. Real KiCad integration then applies the result and uses KiCad DRC as
the final oracle. A small passing subset gates each router PR; reduced fine-pitch, coarse-bus and
bridge-wedge cases run nightly. Promote a known failure to a gating expectation in the same PR that
fixes it.
