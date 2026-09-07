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

This is the whole problem. `buildCircuit` is what turns agent-written TypeScript
into a design. kicad-web has no analogue: its document model _is_ the KiCad file,
mutated through `BeginCommit → CreateItems/UpdateItems/DeleteItems → EndCommit`.
The closest paths, `Schematic.syncToBoard()` and `Board.importNetlist()`, both
start from a schematic that already exists.

Two ways out, and they are very different products:

- **(a) Keep tscircuit as the compiler only.** `circuit.tsx` stays the authoring
  format; `@tscircuit/eval` still produces circuit.json; feed it into KiCad via a
  netlist and `Board.importNetlist`. Preserves the agent workflow and every prompt.
  But it does not remove tscircuit — it _demotes_ it to one package.
- **(b) Drop `circuit.tsx`.** The agent authors by driving KiCad commits directly.
  This rewrites how every agent tool works, every tool description, the MCP surface,
  `packages/agents`, and the UI's editor story. It is a different product, not a
  migration.

**Nothing else in this document can be scheduled until (a) or (b) is chosen.**

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
Adopting fab_pcb does not get tscircuit out of the dependency tree; it moves it one
level down. If removing the tscircuit _dependency_ is the actual goal, this repo is
not the way to do it.

## 4. What I'd recommend

Do **not** rip and replace. Two options that are actually schedulable:

**Option A — compiler split (lowest risk, keeps the product).**
Adopt fab_pcb for everything _downstream_ of the design: routing (§2 #4–#7, a
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

## 5. Rough sizing (assuming §3.1(a) and §3.2 resolved)

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
