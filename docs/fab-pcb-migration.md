# Migrating fabdesk off tscircuit onto fab_pcb (kicad-web)

Status: **design only, no code moved.** The `vendor/fab_pcb` submodule is added
(tracking `main`); nothing else in the tree has changed.

## 0. The headline

`TensorFleet/fab_pcb` is not a tscircuit fork. It is **`kicad-web`**: a headless
KiCad UI built on the KiCad IPC API (protobuf over nng to `kicad-cli api-server`),
with packages `@kicad-web/{proto,client,bridge,renderer,router}`. There is no
`fp-pcb` identifier anywhere in the repo, and `main` is its only branch.

So this is not a dependency swap. It is an inversion of which artifact is the
source of truth:

|                 | today                                     | after                                                            |
| --------------- | ----------------------------------------- | ---------------------------------------------------------------- |
| source of truth | `circuit.tsx` → `circuit.json`            | `.kicad_sch` / `.kicad_pcb`, held open by a KiCad server process |
| KiCad files     | derived output of `circuit-json-to-kicad` | the design itself                                                |
| `circuit.json`  | the data contract every package speaks    | gone, or a lossy export                                          |
| operations      | synchronous, over JSON files on disk      | async RPC against a supervised per-project process               |

Everything below follows from that one change.

## 1. Where tscircuit actually lives

The blast radius is ~35 files in 8 packages, but it funnels through **one interface**:
`TscircuitService` in [packages/tools/src/services.ts](../packages/tools/src/services.ts) —
10 methods, implemented by [packages/tscircuit](../packages/tscircuit) (1,162 LOC)
and wired up in `apps/core/src/services.ts`. That interface is the migration boundary.
Nothing in `packages/tools` imports tscircuit directly; it all goes through
`ctx.services.tscircuit.*`.

Outside that boundary, four packages depend on the circuit.json _format_ itself:

| package           |   LOC | tscircuit-format dependency                                         |
| ----------------- | ----: | ------------------------------------------------------------------- |
| `packages/kicad`  | 1,542 | `circuit-json-to-kicad` (convert), `kicad-to-circuit-json` (import) |
| `packages/router` | 1,824 | `@tscircuit/capacity-autorouter`, SRJ types                         |
| `packages/sim`    |   395 | `circuit-json-to-spice`                                             |
| `packages/ui`     |     — | `circuit-to-svg` in `board/SvgTab.tsx`                              |

## 2. Call-site map

### `TscircuitService`, method by method

| #   | method                                                                                          | fab_pcb equivalent                                                                                 | verdict                                            |
| --- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 1   | `buildCircuit({projectDir, entrypoint})` — `circuit.tsx` → `circuit.json` via `@tscircuit/eval` | **none**                                                                                           | ⛔ **hard gap**                                    |
| 2   | `runChecks(cj)` — `@tscircuit/checks` `runAllChecks`                                            | `BoardDrc` / `SchematicErc` (`client/src/model/checks.ts`)                                         | ⚠️ replaced, but see §3.2                          |
| 3   | `queryCircuit(cj, select, filter)`                                                              | `Board.getFootprints/getPads/nets/itemsByNet`, `Schematic.getSymbols/netlist`, `Document.getItems` | ✅ maps, becomes async                             |
| 4   | `extractSimpleRouteJson(cj, opts)`                                                              | `router/src/extract.ts` (`RouteInput`) + `js-router.ts` (→ `SimpleRouteJson`)                      | ✅ **upgrade**                                     |
| 5   | `connectionsForComponents(cj, refs)`                                                            | `Board.connectedItems`, `Board.itemsByNet`, `Board.ratsnest(nets)`                                 | ✅ **upgrade** (ratsnest is a better repair scope) |
| 6   | `mergeTraces(cj, traces, map)`                                                                  | `router/src/apply.ts` — `CreateItems` in one commit                                                | ✅ **upgrade** (KiCad owns geometry)               |
| 7   | `unrouteCircuit(cj, connections?)`                                                              | `Board.globalDeletion({tracks, vias})` / `DeleteItems` by net                                      | ✅ maps                                            |
| 8   | `schematicSvg(cj)` — `circuit-to-svg`, returns a string                                         | `SchematicJobs.exportSvg(path)` — async job, writes a file                                         | ⚠️ shape change                                    |
| 9   | `pcbSvg(cj)`                                                                                    | `BoardJobs.exportSvg(path)`                                                                        | ⚠️ shape change                                    |
| 10  | `FileCacheEngine` / `withRegistryFetchCache` — caches `@tsci/*` registry fetches for eval       | n/a                                                                                                | ✅ deleted with #1                                 |

### Outside the interface

| call site                                                                        | fab_pcb equivalent                                    | verdict                    |
| -------------------------------------------------------------------------------- | ----------------------------------------------------- | -------------------------- |
| `packages/kicad/src/convert.ts` — `circuit-json-to-kicad`                        | unnecessary; KiCad _is_ the document                  | ✅ **delete**              |
| `packages/kicad/src/import.ts` — `kicad-to-circuit-json` (largest single file)   | unnecessary; ditto                                    | ✅ **delete**              |
| `packages/kicad/src/{drc,exports,render}.ts` — stock `kicad-cli` subprocesses    | `BoardJobs.*` / `SchematicJobs.*` over IPC            | ⚠️ rewrite, roughly 1:1    |
| `packages/sim/src/netlist.ts` — `circuit-json-to-spice`                          | `SchematicJobs.exportNetlist(format: spice)`          | ✅ **upgrade**             |
| `packages/router/src/adapters/capacity.ts` — `@tscircuit/capacity-autorouter`    | fab_pcb's `js-router.ts` imports **the same package** | ⛔ **not removed**         |
| `packages/tools/src/tools/circuit.ts` — `registry-api.tscircuit.com` part search | `Libraries` (KiCad symbol/footprint tables)           | ⚠️ different part universe |
| `packages/ui/src/board/SvgTab.tsx` — client-side `circuit-to-svg`                | `@kicad-web/renderer` (PixiJS), or server SVG jobs    | ⚠️ rewrite                 |
| MCP: `circuit_build` tool, `circuit.tsx` resource, tool descriptions             | no source file to build                               | ⛔ follows from #1         |

## 3. The four things that actually decide this

### 3.1 There is no `circuit.tsx` compiler on the other side — ⛔

**What the compiler is for.** `buildCircuit` ([build.ts:78](../packages/tscircuit/src/build.ts))
is 157 lines of glue around `@tscircuit/eval`. It does five jobs:

1. **Runs the project's TypeScript** — `CircuitRunner.executeWithFsMap()` over an
   fsMap of every source file, then `renderUntilSettled()`. Arbitrary user code,
   React-style component tree with hooks.
2. **Fetches parts over the network** — `import { useRedLed } from "@tsci/seveibar.red-led"`,
   npm-style packages from `registry.tscircuit.com`, cached by `FileCacheEngine`.
3. **Generates footprint geometry procedurally** — `footprint="0402"` becomes
   `pcb_smtpad` / `pcb_silkscreen_path` / `pcb_courtyard_rect` computed in code.
4. **Auto-lays-out** — schematic placement and trace routing
   (`@tscircuit/schematic-trace-solver`, `minicssgrid`); PCB placement wherever
   `pcbX`/`pcbY` is omitted.
5. **Derives the netlist** — selectors like `.R1 > .pin1` become `source_trace` / `source_port`.

The reason a compiler exists at all is not that circuits need compiling. It is that
the **agent needs a text-shaped, re-runnable authoring surface with line-numbered
errors** — `parseThrownError` ([build.ts:41](../packages/tscircuit/src/build.ts))
exists purely so the agent can fix and retry. That loop is the product.

**What KiCad can do instead**, job by job:

| job                     | KiCad                                                                                                                                          |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. run code             | ⛔ **no.** No scripting anywhere in the IPC API. The only true gap.                                                                            |
| 2. remote part registry | ⚠️ different — `Libraries` (KiCad symbol/footprint tables). Better corpus for fab, different namespace, no npm-style import.                   |
| 3. footprints           | ✅ **better** — `assignFootprints`, `updateFootprintsFromLibrary`; real fab-proven footprints with 3D models instead of generated pads.        |
| 4. layout               | ⚠️ split. PCB: `Board.autoplace()` (needs a board outline; returns `APR_NO_BOARD_OUTLINE` without one). Schematic auto-layout: ⛔ **nothing**. |
| 5. netlist → design     | ✅ **native** — `importNetlist`, `syncToBoard`, `annotate`, full schematic item creation (`KOT_SCH_SYMBOL`, wires, labels, junctions).         |

It can also build from nothing headless (`KiCad.newProject()`,
`newDocument(DOCTYPE_SCHEMATIC)`); gap G8 in their tracker is done. **Four of five
jobs land, three as upgrades.**

**So the decision is: what text does the agent write instead of TSX?**

- **(a) Keep TSX.** tscircuit survives as one package, demoted to the compiler.
  Cheapest, changes no prompts. But the compiler is `@tscircuit/eval`, an external
  dependency you do not control.
- **(b) A KiCad netlist** — recommended. A specified format KiCad ingests natively,
  and it keeps every property that makes the agent loop work: text, diffable,
  deterministic rebuild, errors back via `NetlistImportResult{errorCount,
warningCount, report}`. Pipeline is all existing calls: `newProject` → draw
  outline → `importNetlist` → `annotate` → `assignFootprints` → `autoplace`.
- **(c) Emit `.kicad_sch` S-expressions.** Full fidelity, but gnarly to emit
  reliably and there is no line-level error reporting — KiCad parses it or does not.
- **(d) Drive `CreateItems` from tools.** No text artifact at all; loses
  diffability and re-runnability. Worst fit for an agent loop.

**The three costs of (b):**

- **Part selection gets harder.** The agent picks `Resistor_SMD:R_0402_1005Metric`
  instead of `footprint="0402"`. Needs a library-search tool to replace the registry
  search; most of the agent-quality work lands here.
- **Parametric code is lost.** No loops, no reuse, no `useRedLed()`. A netlist is flat.
- **Schematic auto-layout is the hard one, and it is open-ended.** A netlist carries
  no geometry. Either ship netlist-only (no drawn schematic → no ERC, no
  BOM-from-schematic, nothing for a human to review) or write a schematic placer —
  re-implementing the one genuinely unique thing tscircuit has.

### 3.2 fab_pcb needs a custom KiCad build — ⛔ the real cost

kicad-web requires KiCad **10.99+** with `kicad-cli api-server`, from the fork at
commit `8cc9377988` (`vendor/fab_pcb/packages/proto/KICAD_COMMIT`), built by
`packages/kicad-patches/build-macos.sh` / `build-linux.sh`. The fork's `web-api`
branch carries 21 API commits that the client depends on. Stock KiCad (10.0.4, what
fabdesk resolves today in `packages/kicad/src/cli.ts`) **has no `api-server`
command at all**.

For a shipping desktop app that means bundling a forked `kicad-cli` for macOS,
Linux and Windows, keeping it rebased on KiCad, and handling GPL redistribution.
That is a build/release/licensing programme, not a TypeScript refactor, and it
dwarfs every code change listed above. There is currently no Windows build script
in `kicad-patches` at all.

### 3.3 Everything becomes stateful and async — ⚠️

Today `queryCircuit`, `extractSimpleRouteJson`, `mergeTraces`, `unrouteCircuit`,
`spiceNetlist` and both SVG methods are **synchronous pure functions over a JSON
array**. After the migration each is an RPC to a per-project `kicad-cli api-server`
process that the daemon must spawn, supervise, serialise (KiCad's REQ/REP allows
exactly one request in flight) and recover when it dies.

Consequences: `CoreServices` goes fully async; `packages/tools` handlers change
signature; the mock services in `packages/tools/test/mock-services.ts` become
process fakes; every fixture-based test in `packages/kicad/test` and
`packages/tscircuit/test` (which today just load a `.circuit.json`) needs a live
server or a recorded-protobuf harness. Long jobs (gerbers, STEP) block the socket.

### 3.4 It does not remove tscircuit — ⛔

`vendor/fab_pcb/packages/router/src/js-router.ts` imports
`@tscircuit/capacity-autorouter`, the same package `packages/router` uses today.
Adopting fab*pcb does not get tscircuit out of the dependency tree; it moves it one
level down. If removing the tscircuit \_dependency* is the actual goal, this repo is
not the way to do it.

## 4. Execution plan: move compile into the fab_pcb backend first

Agreed direction: **relocate the compile capability into the fab_pcb backend, hook
fabdesk up to it, and retire tscircuit only once the new path works.** A strangler
migration — the seam moves before the implementation does.

### 4.1 What the two servers are today

|              | `@kicad-web/bridge`                                                                                        | `@fabdesk/core`                                                                                                    |
| ------------ | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| server       | `Bun.serve`, port 4020                                                                                     | Hono, ~45 routes                                                                                                   |
| surface      | `/health`, `/sessions`, `/sessions/:id/{log,events}`, `/files`, `/ws` (binary protobuf frames), static SPA | projects, files, sketches, threads + messages, `/mcp`, jobs, route runs, bench, auth, settings, doctor, opensource |
| dependencies | **one** (`@kicad-web/client`)                                                                              | tools, tscircuit, kicad, router, sim, agents, auth, MCP SDK, Sentry                                                |
| domain logic | **none** — process supervision and transport only                                                          | the whole product                                                                                                  |

The bridge is a _transport_; core is the _application_. They overlap on nothing, so
this is additive rather than a merge.

### 4.2 Put compile in a library package, not in the bridge's HTTP surface

Two facts make this the right shape:

- `NngIpcTransport` is exported from `@kicad-web/client` and speaks the unix socket
  directly from Bun.
- `SessionManager` / `Session` are exported from `@kicad-web/bridge`'s index.

So **fabdesk core can drive a KiCad server in-process without running a second HTTP
server on 4020.** If compile lands as a bridge HTTP endpoint, fabdesk is forced into
an extra process and an extra hop for every build.

Recommended: a new **`@kicad-web/compile`** package that both consume — the bridge
exposes it over HTTP for the web app, fabdesk core imports it directly. One
implementation, two front doors.

### 4.3 The seam

```
compile(source, session) -> { ok, errors[], warnings[], counts }
  source -> netlist -> newProject | importNetlist -> annotate
         -> assignFootprints -> autoplace
```

Errors come back from `NetlistImportResult{errorCount, warningCount, report}`, which
preserves the fix-and-retry loop `parseThrownError` gives today.

### 4.4 Phases

| phase | work                                                                                                                                                                                                                 | tscircuit still present? |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| 1     | Create `@kicad-web/compile` in fab_pcb. Internals still `@tscircuit/eval` — fab_pcb already depends on `@tscircuit/capacity-autorouter`, so this is not a new precedent. Expose via the bridge; export as a library. | yes, in fab_pcb          |
| 2     | Point fabdesk's `TscircuitService` implementation at the new package. `packages/tscircuit` becomes a thin adapter. Nothing in `packages/tools` changes — the interface holds.                                        | yes                      |
| 3     | Swap the compile internals to netlist-native (§3.1(b)). **fabdesk does not change.**                                                                                                                                 | no                       |
| 4     | Retire `packages/tscircuit`; delete `convert.ts` + `import.ts` (§2).                                                                                                                                                 | no                       |
| 5     | Routing, DRC, exports, sim, render onto the fab_pcb equivalents (§2).                                                                                                                                                | —                        |

Phase 3 is where the hard problem from §3.1 lands (part selection, no parametric
code, schematic auto-layout) — but by then it is behind a stable seam, so it can
take as long as it takes without blocking anything.

### 4.5 Constraints to plan around

1. **Cross-repo workflow.** `vendor/*` are submodules; per AGENTS.md they are not
   edited in fabdesk. Every step above is a PR to `TensorFleet/fab_pcb` followed by
   `bun run submodules:update` — which currently only updates `vendor/fabplane` and
   needs extending to `vendor/fab_pcb`.
2. **This pushes fab_pcb's architecture.** Its document model deliberately _is_ the
   KiCad file; it has no concept of a design source. Adding compile gives it one.
   TensorFleet owns both repos, so this is a call to make deliberately rather than a
   blocker.
3. **§3.2 is still the gate.** None of this runs without a `kicad-cli` that has
   `api-server`. `DEFAULT_KICAD_CLI` points at a local KiCad checkout build. Shipping
   fabPlane still means bundling a forked binary on three platforms.

## 5. Superseded — earlier options

Kept for reference; §4 supersedes them.

**Option A — compiler split (lowest risk, keeps the product).**
Adopt `fab_pcb` for everything _downstream_ of the design: routing (§2 #4–#7, a
genuine upgrade), DRC/ERC, exports, sim netlist, rendering. Keep `@tscircuit/eval`
as the `circuit.tsx` compiler and hand its output to KiCad via `importNetlist`.
Rename `packages/tscircuit` → `packages/compile` so the name stops implying more
than it does. Still requires §3.2.

**Option B — fix the naming, skip the migration.**
If the goal was really "stop having tscircuit's name all over our codebase", the
cheap version is: rename `@fabdesk/tscircuit` → `@fabdesk/circuit`, rename the
`services.tscircuit` key, and reword the ~15 comments and tool descriptions. A day
of work, no behaviour change, no KiCad fork. This buys none of fab_pcb's upside.

Either way, **§3.2 is the gate**. Before any code moves, the question to settle is
whether fabPlane is willing to ship a forked `kicad-cli` on three platforms.

## 6. Rough sizing (assuming §3.1(a) and §3.2 resolved)

| phase | work                                                                          | scale                                    |
| ----- | ----------------------------------------------------------------------------- | ---------------------------------------- |
| 0     | Build + ship forked `kicad-cli` for mac/linux/windows                         | **largest item; unbounded until scoped** |
| 1     | Session supervisor in `apps/core`: spawn/pin/recover `api-server` per project | ~1 new package                           |
| 2     | `CoreServices` → async; `packages/tools` handlers + mocks                     | ~3,400 LOC touched                       |
| 3     | Routing onto `@kicad-web/router` (extract/apply)                              | replaces ~800 LOC, net simplification    |
| 4     | DRC/ERC/exports/render onto `BoardJobs`/`SchematicJobs`                       | rewrites ~1,500 LOC                      |
| 5     | Delete `convert.ts` + `import.ts`; sim onto `exportNetlist`                   | net **−1,500 LOC**                       |
| 6     | UI: `circuit-to-svg` → `@kicad-web/renderer` or SVG jobs                      | 1 tab, plus renderer integration         |
| 7     | Test harness: fixtures → live-server or recorded protobuf                     | every test in 4 packages                 |
