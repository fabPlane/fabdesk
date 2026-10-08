> **Historical.** The in-process routing benchmark (`bench route`, `/bench/route`) was removed together with tscircuit; routing now runs on the FabPlane PCB bridge, whose own bench lives in `fab_pcb/packages/router/bench`. Kept for the numbers.

# Benchmarks: real boards through the app

`fabdesk-core bench route` (and `POST /bench/route`) routes one project's board N times through the
same `RouterHost` worker path the UI uses, streams the frames to the Route Cinema, and writes a
report to `<project>/.fabdesk/bench/<timestamp>.json`. The first fixture is the six-layer VAIO CM5
carrier B2.23 (`scripts/bench/vaio-b223.ts`).

## What is measured

Per benchmark: import timings (`reports/import.json`: parse, convert, net linking), SRJ extraction
time and size (layer count and names, connections, endpoints, obstacles, how much pre-routed copper
became obstacles), router probe, machine (CPU model, thread count, load averages, Bun version).

Per run: wall time around `RouterHost.route`, the adapter's own `stats.wallMs`, process CPU
(user+system, whole process, so the worker thread is included) and RSS before/after, frames received
by the sink and frames the adapter throttled, connection frames, frame bytes, complete/open counts,
vias, segments, `timedOut`, the router's `detail` (what it approximated or refused) and a SHA-256
of the routed copper (`resultHash`, order-independent, 0.1 µm) so identical results are visible.

Summary: median/min/max of wall, router wall, complete, open and frames, failures, timeouts and the
number of distinct result hashes -- separately for the **cold** run (run 1: fresh worker, cold module
cache) and the **warm** runs, plus all. Use `--repeat 5` or more (runbook section 10); one run is a
functional baseline, not a speedup claim.

## Scenarios

Both start from the project's `circuit.json` (the imported board is the routed baseline).

- `full`: every routed connection is unrouted and the whole board is routed from scratch. Copper
  pours stay as fixed obstacles owned by their net.
- `repair`: the connections attached to `--refs` (default: the nine corrected footprints of the
  B2.23.1 runbook, U701 U702 U704 U707 Q701 D403 D703 U705 U706) are unrouted and routed with
  `onlyConnections`; every other trace, via and pour stays as fixed copper of its net. Nets that own a
  copper pour (GND) are excluded and listed in the report. This is a **net-level** repair (all copper
  of those nets), not the runbook's junction-splitting one.

`--pours omit` drops the pours from the obstacles. It is a diagnostic, recorded as such in the
report, and not a fair same-input comparison.

## Running the VAIO fixture

```sh
# Verifies the pinned commit + SHA-256, imports into ~/fabdesk/vaio-b223-bench, runs one repair route.
bun run scripts/bench/vaio-b223.ts
# More repetitions / other router / whole board:
bun run scripts/bench/vaio-b223.ts --repeat 5 --timeout-ms 300000
bun run scripts/bench/vaio-b223.ts --router capacity --scenario full
```

With the dev app running the script talks to its daemon (`daemon.json`), so the project appears in
the app and the Route Cinema shows every run's frames. Routing runs through the FabPlane PCB bridge;
record the selected router when benchmarking router options.

Direct CLI:

```sh
FABDESK_CHANNEL=internal bun run apps/core/src/main.ts bench route --project ~/fabdesk/vaio-b223-bench \
  --router freerouting --scenario repair --repeat 5 --timeout-ms 300000 --json /tmp/bench.json
```

The env-gated test `FABDESK_VAIO_BENCH=1 FABDESK_CHANNEL=internal bun test packages/kicad/test/vaio-bench.test.ts`
does the import + SRJ + one repair route in-process and prints the numbers.

## What the runbook's constraints mean here

- No KiCad is launched for import or routing: `.kicad_pcb` is parsed as data (`kicadts` +
  `kicad-to-circuit-json`); nets are re-derived by `@fabdesk/kicad`'s importer because the nightly
  file format references nets by name and the converter drops them.
- The strict scenario uses `--router freerouting`. The FabRouter capacity router is available for
  comparison; its result detail records any geometry limitations.
- The importer fails closed (`reports/import.json.failures`) on net-name collisions, copper it could
  not link to a net, blind/buried/micro vias, and a layer-count disagreement; rule areas, unfilled
  zones and copper graphics it cannot convert are listed under `dropped`, never silently flattened.
  One collision-detecting canonical net mapping (`nets.canonical`, aliases kept) covers pads, tracks,
  vias and zones.
- DRC with `kicad-cli` (`verify_drc`) is a separate, optional verification step on the converted
  board; the benchmark does not run it.
- Router time limits are cooperative, so a large unit of work can overshoot `--timeout-ms`; the
  report keeps `wallMs` and `timedOut` separately.

## Route Cinema under load

Large boards produce frames of thousands of shapes. The route tool scales the attempt-frame gate with
the problem size (33/100/200 ms; `minFrameIntervalMs` overrides), the core bus coalesces attempt
frames per subscriber, and the store keeps the newest 400 frames per run (structural frames always)
and counts what it never received from `seq` gaps. The cinema status line shows frames/s received,
the last draw time, shapes drawn and the dropped count. Statics are painted once to an offscreen
layer; copper is extended by the frame delta while following live and rebuilt only on seeks.
