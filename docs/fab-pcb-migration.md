# Migrating fabdesk off tscircuit onto FabPlane PCB (`fab_pcb`)

Status: **tscircuit is gone from fabdesk (branch `retire-tscircuit`, §4.7); the compile package and bridge
job are fab_pcb PRs #2/#3.** Pinned to `fab_pcb` `757de90` (KiCad fork `280274cc3d`, tag
`fp-pcb/2026-09-07-upstream-be90a7e200`). §5 reviews the skeleton, §6 is the viability verdict.

## 0. The headline

### Packaged runtime identity

The desktop assigns every launch an opaque `FABDESK_RUNTIME_ID` and owns both core and bridge
processes with `FABDESK_DESKTOP_PID`. Before reusing a bridge, it validates the health response's
runtime ID, owner PID, resolved `kicadCli`, workspace root, and configured JavaScript-router module.
If the default port belongs to another runtime, the bundled bridge starts on a fresh loopback port;
an explicit `FABDESK_FP_PCB_BRIDGE_URL` fails with an identity-mismatch error instead. Core health,
its daemon handshake, and the embedded MCP server carry the same launch identity. Project roots are
passed unchanged to core and bridge, and each supervisor stops only the child process it spawned.

`fabPlane/fab_pcb` is **FabPlane PCB**: a headless KiCad stack on the KiCad IPC API
(`kicad-cli api-server` from a KiCad fork, protobuf over nng), packages
`@fp-pcb/{proto,client,bridge,renderer,router}`. It is not a tscircuit fork and it has no
circuit-source compiler of its own.

So this is not a dependency swap. It is an inversion of which artifact is the source of truth:

|                 | today                                     | after                                                            |
| --------------- | ----------------------------------------- | ---------------------------------------------------------------- |
| source of truth | `circuit.tsx` → `circuit.json`            | `.kicad_sch` / `.kicad_pcb`, held open by a KiCad server process |
| KiCad files     | derived output of `circuit-json-to-kicad` | the design itself                                                |
| `circuit.json`  | the data contract every package speaks    | gone, or a lossy export                                          |
| operations      | synchronous, over JSON files on disk      | async jobs against a supervised per-project process              |

Everything below follows from that one change.

## 1. Where tscircuit actually lives

The blast radius is ~35 files in 8 packages, but it funnels through **one interface**:
`TscircuitService` in [packages/tools/src/services.ts](../packages/tools/src/services.ts) —
10 methods, implemented by [packages/tscircuit](../packages/tscircuit) (1,162 LOC) and wired
up in `apps/core/src/services.ts`. That interface is the migration boundary. Nothing in
`packages/tools` imports tscircuit directly; it all goes through `ctx.services.tscircuit.*`.

Outside that boundary, four packages depend on the circuit.json _format_ itself:

| package           |   LOC | tscircuit-format dependency                                         |
| ----------------- | ----: | ------------------------------------------------------------------- |
| `packages/kicad`  | 1,542 | `circuit-json-to-kicad` (convert), `kicad-to-circuit-json` (import) |
| `packages/router` | 1,824 | `@tscircuit/capacity-autorouter`, SRJ types                         |
| `packages/sim`    |   395 | `circuit-json-to-spice`                                             |
| `packages/ui`     |     — | `circuit-to-svg` in `board/SvgTab.tsx`                              |

## 2. Call-site map

### `TscircuitService`, method by method

| #   | method                                                                                          | `fab_pcb` equivalent                                                                               | verdict                                            |
| --- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 1   | `buildCircuit({projectDir, entrypoint})` — `circuit.tsx` → `circuit.json` via `@tscircuit/eval` | **`@fp-pcb/compile`** (new, §4.3): `Frontend` → `Netlist` → `ImportNetlist`                        | ✅ **replaced by the new package**                 |
| 2   | `runChecks(cj)` — `@tscircuit/checks` `runAllChecks`                                            | `BoardDrc` / `SchematicErc` (`client/src/model/checks.ts`)                                         | ⚠️ replaced, but see §3.3                          |
| 3   | `queryCircuit(cj, select, filter)`                                                              | `Board.getFootprints/getPads/nets/itemsByNet`, `Schematic.getSymbols/netlist`, `Document.getItems` | ✅ maps, becomes async                             |
| 4   | `extractSimpleRouteJson(cj, opts)`                                                              | `router/src/extract.ts` (`RouteInput`) + `js-router.ts` (→ `SimpleRouteJson`)                      | ✅ **upgrade**                                     |
| 5   | `connectionsForComponents(cj, refs)`                                                            | `Board.connectedItems`, `Board.itemsByNet`, `Board.ratsnest(nets)`                                 | ✅ **upgrade** (ratsnest is a better repair scope) |
| 6   | `mergeTraces(cj, traces, map)`                                                                  | `router/src/apply.ts` — `CreateItems` in one commit; or the bridge's route job end to end          | ✅ **upgrade** (KiCad owns geometry)               |
| 7   | `unrouteCircuit(cj, connections?)`                                                              | `Board.globalDeletion({tracks, vias})` / `DeleteItems` by net                                      | ✅ maps                                            |
| 8   | `schematicSvg(cj)` — `circuit-to-svg`, returns a string                                         | `SchematicJobs.exportSvg(path)` — async job, writes a file                                         | ⚠️ shape change                                    |
| 9   | `pcbSvg(cj)`                                                                                    | `BoardJobs.exportSvg(path)`                                                                        | ⚠️ shape change                                    |
| 10  | `FileCacheEngine` / `withRegistryFetchCache` — caches `@tsci/*` registry fetches                | n/a                                                                                                | ✅ deleted with #1                                 |

### Outside the interface

| call site                                                                        | `fab_pcb` equivalent                                                       | verdict                    |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------- |
| `packages/kicad/src/convert.ts` — `circuit-json-to-kicad`                        | unnecessary; KiCad _is_ the document                                       | ✅ **delete** (phase 5)    |
| `packages/kicad/src/import.ts` — `kicad-to-circuit-json` (largest single file)   | **kept through phase 3** as the bridge back to `circuit.json` (§4.4)       | ⚠️ delete later            |
| `packages/kicad/src/{drc,exports,render}.ts` — stock `kicad-cli` subprocesses    | `BoardJobs.*` / `SchematicJobs.*` over IPC                                 | ⚠️ rewrite, roughly 1:1    |
| `packages/sim/src/netlist.ts` — `circuit-json-to-spice`                          | `SchematicJobs.exportNetlist(format: spice)`                               | ✅ **upgrade**             |
| `packages/router/src/adapters/capacity.ts` — `@tscircuit/capacity-autorouter`    | `@fp-pcb/router` `js-router.ts` imports **the same package**               | ⛔ **not removed**         |
| `packages/tools/src/tools/circuit.ts` — `registry-api.tscircuit.com` part search | `Libraries` (KiCad symbol/footprint tables)                                | ⚠️ different part universe |
| `packages/ui/src/board/SvgTab.tsx` — client-side `circuit-to-svg`                | `@fp-pcb/renderer` (PixiJS), or server SVG jobs                            | ⚠️ rewrite                 |
| MCP: `circuit_build` tool, `circuit.tsx` resource, tool descriptions             | `circuit_build` drives the compile job; source file becomes the frontend's | ⚠️ follows from #1         |

## 3. The four things that actually decide this — re-verdict at `757de90`

### 3.1 There is no `circuit.tsx` compiler on the other side — unchanged in fact, changed in shape

**What the compiler is for.** `buildCircuit` ([build.ts:78](../packages/tscircuit/src/build.ts))
is 157 lines of glue around `@tscircuit/eval`. It does five jobs: (1) runs the project's
TypeScript; (2) fetches parts from `registry.tscircuit.com`; (3) generates footprint geometry
procedurally (`footprint="0402"` → pads); (4) auto-lays-out schematic and PCB; (5) derives the
netlist from selectors like `.R1 > .pin1`. The reason a compiler exists is not that circuits need
compiling — it is that **the agent needs a text-shaped, re-runnable authoring surface with
line-numbered errors** (`parseThrownError`, [build.ts:41](../packages/tscircuit/src/build.ts)).

**What KiCad does instead**, job by job:

| job                     | KiCad                                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 1. run code             | ⛔ **no.** Nothing in the IPC API runs code. The only true gap.                                                                      |
| 2. remote part registry | ⚠️ different — `Libraries` (symbol/footprint tables). Better corpus for fab, different namespace, no npm-style import.               |
| 3. footprints           | ✅ **better** — real fab-proven footprints with 3D models via `ImportNetlist` + `fp-lib-table`.                                      |
| 4. layout               | ⚠️ split. PCB: `AutoplaceFootprints` (needs an outline; offboard-only unless ids are passed). Schematic auto-layout: ⛔ **nothing**. |
| 5. netlist → design     | ✅ **native** — `ImportNetlist`, `syncToBoard`, `annotate`, full schematic item creation.                                            |

**The skeleton has fixed the architecture of the answer.** The stable half is
`Netlist → .net → ImportNetlist`; "what text does the agent write" is now a **frontend** choice
(`Frontend` in `packages/compile/src/types.ts`), not a system choice. Costs that stand: part
selection moves to KiCad lib ids; no parametric code; no schematic auto-layout (so no drawn
schematic, no ERC, no BOM-from-schematic until a placer exists). **New cost found in review:
library provisioning.** `addNewFootprint` needs the footprint library to resolve; a headless
server has none unless the image or bundle ships `kicad-footprints` or the frontend emits a
project-local `.pretty` + `fp-lib-table` (`circuit-json-to-kicad` already generates the
`.kicad_mod` text — that is how a future `tscircuit` frontend keeps procedural footprints).
`FrontendResult.libraries` exists for exactly this.

### 3.2 A forked `kicad-cli` is required — maintenance now automated; distribution unchanged; a third option exists

Requires KiCad 10.99+ with `kicad-cli api-server` from the fork's `web-api` branch, pinned at
`280274cc3d`. Stock KiCad 10.0.4 (what `packages/kicad/src/cli.ts` resolves today) has no such
command.

**What changed.** `docs/07-upstream-sync.md` + `tooling/upstream-sync/{sync,land}.sh`: a daily
task merges upstream KiCad into `web-api`, rebuilds, runs the fork's QA suite and the web suites,
opens two PRs, and lands alignment tags (`fp-pcb/<date>-<name>`) on both repos. "Keeping the fork
rebased" is no longer a cost line. **What did not change:** `packages/kicad-patches/` still has
`build-macos.sh`, `build-linux.sh`, `docker/` only. No Windows build, no signing/notarisation
pipeline, and `DEFAULT_KICAD_CLI` still points at a local checkout build.

**The third option.** `docs/architecture.html` now documents hosting: one `kicad-cli` per open
project owned by a bridge session, from "one box behind a reverse proxy" (≈10–20 active users
per 8 cores) to container-per-session using the existing Linux image. Sizing: server start
0.6–1.1 s, idle ≈40 MB, DRC on a 94-footprint 4-layer board 2.4–4 s, Freerouting minutes.
That makes **fabdesk core → hosted fp-pcb backend** a concrete alternative to bundling a forked
binary in the desktop app:

|                    | bundled fork in the desktop app                                       | hosted fp-pcb backend                                                                                                                                                                                      |
| ------------------ | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| distribution       | 3 platform builds, signing, GPL redistribution, no Windows script yet | none on the client; one Linux image (exists)                                                                                                                                                               |
| offline            | works                                                                 | compile needs network; today's product builds offline. Hybrid possible if `KICAD_CLI` points at a fork build                                                                                               |
| agent-loop latency | ~0.05 ms per request                                                  | a compile is **one** HTTP job with the source inline, so WAN RTT is paid once per build. Chatty inspect/query phases hurt more                                                                             |
| file staging       | none                                                                  | compile: none (`netlist_path` is project-relative, resolved server-side). The KiCad project must live on the server for the session; fabdesk's local project dir needs sync via `/files` or object storage |
| cost per user      | user's CPU                                                            | see sizing; Freerouting needs a job queue                                                                                                                                                                  |
| security           | KiCad listener on the user's loopback                                 | listener has no origin check → in-pod behind the bridge; bridge auth + per-user roots are on the "to build" list                                                                                           |
| must exist first   | build/sign pipeline for 3 OSes                                        | login, per-user roots, session controller, storage sync, footprint libraries in the image                                                                                                                  |

**Decision (2026-09-07): bundled fork.** fabPlane keeps building offline, so phase 0 is the
`kicad-cli` build/sign/notarise pipeline for macOS, Linux and Windows plus GPL redistribution —
Windows is the missing piece (`kicad-patches/` has no Windows script; fabdesk's `vm:windows`
harness is the natural host for one). Hosted stays open later at no design cost: the
`@fp-pcb/compile` package and the fabdesk adapter are the same either way (§4.2).

### 3.3 Everything becomes stateful and async — nature unchanged, fabdesk-side work shrinks

The bridge now mounts **jobs**: `POST /sessions/:id/route`, `GET …/:job` (JSON or SSE), `DELETE`
cancels (`@fp-pcb/router/bridge-job`). A compile job follows the same shape (§4.3), so
`buildCircuit` becomes `POST` + SSE follow — which maps onto what fabdesk already has
(`longRunning`, `ctx.progress`, `RouteRunStore`). Session lifecycle fabdesk must own either way:
one session per project, created lazily on first compile, recreated on 404 after idle reaping.
Mocking an HTTP job in `packages/tools/test/mock-services.ts` is simpler than faking a process.
`runChecks` (#2) still loses the cheap pre-DRC pass: every check now needs a live server.

### 3.4 It does not remove tscircuit — unchanged, slightly worse

The bridge owns its router dependency, so a bridge deployment carries the selected capacity
router. Fabdesk remains isolated from that implementation and communicates only through the
FabPlane PCB bridge contract.

## 4. Execution plan

### 4.1 What the two servers are today

|              | `@fp-pcb/bridge`                                                                                                              | `@fabdesk/core`                                                                                |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| server       | `Bun.serve`, port 4020                                                                                                        | Hono, ~45 routes                                                                               |
| surface      | `/health`, `/sessions`, `/sessions/:id/{log,events}`, `/sessions/:id/route[/:job]`, `/files`, `/ws` (protobuf frames), static | projects, files, sketches, threads + messages, `/mcp`, jobs, route runs, bench, auth, settings |
| dependencies | `@fp-pcb/client`, `@fp-pcb/router`                                                                                            | tools, tscircuit, kicad, router, sim, agents, auth, MCP SDK, Sentry                            |
| domain logic | **route jobs** (mounted from the router package; the bridge itself stays transport + supervision)                             | the whole product                                                                              |

They overlap on exactly one concept — jobs — and that overlap is the seam.

### 4.2 fabdesk is a bridge client, local or hosted

The router precedent settles the shape: a domain package exports a library API **and** a
mountable job (`createRouteJobs` / `matchRouteJobPath`); the bridge imports the package and calls
`jobs.handle(req, session, jobId)`; the package never imports the bridge. `@fp-pcb/compile`
does the same. fabdesk core then talks HTTP to a bridge — locally via `startBridge({ port: 0 })`
(exported from `@fp-pcb/bridge`), or hosted — with **zero** `fab_pcb` workspace packages in
core's dependency tree: mirror the job types into `@fabdesk/protocol` the way
`packages/tools/src/services.ts` already mirrors sibling packages. Embedding `SessionManager`
in-process is still possible but would pull router + capacity-autorouter + Freerouting resolution
into core; not worth it.

### 4.3 The seam

Library (`packages/compile`, drafted):

```
compile(source, board, opts) -> CompileResult { ok, diagnostics[], counts, netlistPath?, durationMs }
  Frontend.build(source) -> { netlist, board?, libraries?, diagnostics }
  validateNetlist -> ImportNetlist(dryRun) -> outline commit -> ImportNetlist -> autoplace(addedIds)
```

Nothing touches the board until the netlist validates **and** a dry-run import resolves every
footprint against the real `fp-lib-table`; a failed compile leaves the board as it was.

Job (PR 2, mirrors the route job):

| route                               | behaviour                                                                                                                                                  |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /sessions/:id/compile`        | body `{ source: CompileSource, board?, matchMode?, deleteExtraFootprints?, updateFootprints?, autoplace?, save?, netlistPath?, message? }` → `202 { job }` |
| `GET /sessions/:id/compile[/:job]`  | jobs + registered frontend kinds / one job; `Accept: text/event-stream` streams `state`, `progress`, `done`, `error`                                       |
| `DELETE /sessions/:id/compile/:job` | cancel; honoured between stages (REQ/REP is not interruptible)                                                                                             |

States: `queued → frontend → validating → checking → outlining → importing → placing → saving →
done | failed | cancelled`. A compile is **three undo entries** (outline commit, KiCad's own
"Update Netlist" commit, autoplace commit); document it, do not fight it. `save` defaults on
because everything downstream in fabdesk reads the file.

### 4.4 Phases — netlist-first

The earlier plan put `@tscircuit/eval` behind the seam first. That builds the hardest frontend
before the apply path has ever run against a server. Reversed:

| phase | work                                                                                                                                                                                                                                                                                                     | tscircuit present     |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| 0     | **Bundled fork (decided, §3.2):** build/sign/notarise `kicad-cli` for macOS, Linux, Windows — add a Windows script to `kicad-patches/`. Ship `kicad-footprints` in the bundle. Run the §6 experiment.                                                                                                    | yes                   |
| 1     | `fab_pcb` PR 1: `@fp-pcb/compile` library — rename, the §5 fixes, JSON netlist frontend (`circuit.netlist.json` = `{ netlist, board }`), `FrontendResult.libraries`                                                                                                                                      | yes                   |
| 2     | **landed on fab_pcb (stacked on #2)** — `@fp-pcb/compile/bridge-job` mounted at `/sessions/:id/compile`; live `apply.kicad.test.ts` + `compile.kicad.test.ts` against the fork; libraries registered from `FrontendResult.libraries`; A.8 inset. `DocumentChanged` fork patch still open (gaps doc G28). | yes                   |
| 3     | **landed behind a flag (§4.6)** — bridge client in `apps/core`; `buildCircuit` adapter = compile job → `importKicadPcb(board.kicad_pcb)` → `circuit.json` → `BuildResult`; `boardIsStale` trap closed                                                                                                    | yes                   |
| 4     | `fab_pcb`: `tscircuit` frontend for existing `circuit.tsx` projects, emitting project-local `.pretty` for procedural footprints                                                                                                                                                                          | yes, inside `fab_pcb` |
| 5     | **landed (§4.7)** — `packages/tscircuit`, `router`, `router-freerouting`, `convert.ts`, and `import.ts` deleted; every tool KiCad-native through the bridge or the fork `kicad-cli`; sim/BOM/netlist export from the netlist source                                                                      | no                    |

Phase 3's `importKicadPcb` bridge is why `circuit.json` is not a blocker: it is exactly what
`project_import_kicad` does today (927 LOC fabdesk owns) and emits the `source_*` elements routing
needs. Sim over an imported board is lossy until phase 5; accept it.

### 4.5 Constraints to plan around

1. **Cross-repo workflow.** `vendor/*` is never edited here; every `fab_pcb` step is a PR to
   `fabPlane/fab_pcb`, then `bun run submodules:update` (now covers `vendor/fab_pcb`). Do not
   add `vendor/fab_pcb/packages/*` to fabdesk's workspaces: the HTTP-client shape needs none.
2. **§3.2 is decided (bundled).** The gate is now the three-platform fork build, Windows first.
3. **Footprint libraries.** The Docker image ships none and no `fp-lib-table`; fixtures need
   `KICAD10_FOOTPRINT_DIR`. A compile pipeline is inert until this is solved (image, bundle, or
   frontend-emitted `.pretty`).
4. **The staleness trap (phase 3).** `boardIsStale` in `packages/tools/src/tools/core.ts` is
   `mtime(circuit.json) > mtime(board.kicad_pcb)`. After compile → save → import, `circuit.json`
   is newer, so the next `verify_drc` / `render_board` would run `circuit-json-to-kicad` and
   **overwrite the KiCad-native board**. The adapter must bump the board's mtime or record
   `board.source: "kicad"` in `fabdesk.json` and short-circuit the check.
5. **CI for the integration test.** `ci.yml`'s `kicad-integration` job is `continue-on-error`
   with a placeholder `KICAD_REF`; no image is published at the pin. Publishing the image at
   `KICAD_COMMIT` and flipping that flag is `fab_pcb` infra work, and it is what makes
   `apply.kicad.test.ts` enforceable.

### 4.6 Phase 3 status — landed in fabdesk 2026-09-07, behind a flag

What is in the tree (all unit-tested against stubs; nothing has met a live bridge):

- `packages/protocol/src/fp-pcb.ts` — the bridge wire types (health, sessions, compile
  request/job/result, SSE event names), mirrored so core carries **no** `fab_pcb` workspace
  package. The `/sessions/:id/compile` shape is §4.3's; it is a client of a contract until
  `fab_pcb` PR 2 lands.
- `apps/core/src/fp-pcb-bridge.ts` — `FpPcbBridgeClient`: session reuse by project path, compile
  with SSE follow and a JSON fallback, cancel via `DELETE`, `ToolError` codes
  (`unavailable` / `not_found` / `cancelled`) the tools already understand.
- `apps/core/src/fp-pcb-compiler.ts` — `fpPcbBuildCircuit` behind `TscircuitService.buildCircuit`:
  `circuit.netlist.json` → compile job (project created by the job when `board.kicad_pro` is
  absent) → `board.kicad_pcb` → `importKicadPcb` → `circuit.json`, returning
  `boardSource: "kicad"`. `chooseCompiler`: setting `compiler: "fp-pcb"` (env `FABDESK_COMPILER`)
  prefers the new path when the project has a netlist; a `*.netlist.json` entrypoint forces it;
  tsx-only projects keep tscircuit, so flipping the flag breaks nothing.
- The §4.5.4 trap is closed: `BoardSettings.source` (`tscircuit` | `kicad`), `boardIsStale`
  returns false for a KiCad-owned board, `kicad_convert` refuses to overwrite one, and
  `circuit_build` records ownership on a successful build only.
- Settings `compiler` and `fpPcbBridgeUrl` (env `FABDESK_FP_PCB_BRIDGE_URL`, default
  `http://127.0.0.1:4020`). No settings UI yet; the env vars are the dev switch.

Still open before the flag does anything end to end:

1. ~~`fab_pcb` PR 2~~ — landed: the bridge answers `POST /sessions/:id/compile` (contract as §4.3; `done` carries `revision`).
2. **Nothing spawns the bridge.** Dev runs it by hand from a `fab_pcb` checkout (not `vendor/`,
   which has no `node_modules`). Bundling it is phase 0.
3. **File-format compatibility — confirmed (§6.1).** Stock `kicad-cli` 10.0.4 fails to load the
   fork-written board (`Failed to load board`, file version `20260831`); the fork's own CLI handles
   it and produces the DRC JSON `runDrc` already parses. Constraint: with `compiler: fp-pcb`,
   `kicadCliPath` **must** be the fork binary. Follow-up: a `doctor` / build warning when the
   compiler is fp-pcb and the resolved `kicad-cli` is older than 10.99.
4. ~~`importKicadPcb` strict on a fresh board~~ — verified (§6.1): 40 elements, 2 components, 4
   pads, 2 routable nets, design rules from the `.kicad_pro`, no warnings.
5. `packages/agents/src/agents-md.ts` still tells the agent to write `circuit.tsx`; netlist
   authoring guidance is phase 4.

### 4.7 Phase 5 — tscircuit removed (2026-09-07, branch `retire-tscircuit`)

fabdesk's own packages carry no tscircuit-ecosystem dependency and no `circuit.json` contract.

- **Removed:** `packages/tscircuit`, `packages/router`, `packages/router-freerouting`, the former
  private-router submodule, `packages/kicad/src/{convert,import,net-names}.ts`,
  `circuit-json-to-spice`, `circuit-to-svg`, the in-process bench (`bench route`, `/bench/route`),
  `BoardSettings.source`, `Settings.compiler`, the `TscircuitService` and `RouterService` seams.
- **Replaced by:** `DesignService` (`packages/tools/src/services.ts`) implemented in
  `apps/core/src/fp-pcb-design.ts` on a per-project bridge session (`fp-pcb-session.ts`, typed
  `@fp-pcb/client` over the bridge's WebSocket): build = compile job, route = route job,
  query/unroute/scope/footprint search = client calls. DRC, ERC, renders, exports stay on the fork
  `kicad-cli` (`packages/kicad`, plus a PCB SVG export). SPICE, BOM and the KiCad netlist export come
  from `circuit.netlist.json` / the compile job's `.net`. The route cinema keeps working on job
  progress (events, no geometry).
- **Source of truth:** `circuit.netlist.json` (`NetlistFile` in `@fabdesk/protocol`, the
  `@fp-pcb/compile` `netlist-json` frontend's format). New projects start with an empty one; the
  agent guide (`packages/agents/src/agents-md.ts`) and the MCP prompts teach it.
- **Vendored client typing:** `@fp-pcb/{proto,client}` are root workspaces; `bun run fp-pcb:types`
  emits their declarations and `tsconfig.base.json` `paths` map to them, so fabdesk's stricter
  compiler options do not re-check fab_pcb's sources.
- **Current behavior:** Fabdesk supervises the bundled bridge and supplies the same bundled KiCad
  environment to the bridge and core. Compiling a netlist creates both a native KiCad board and
  schematic, so ERC, schematic parity, and schematic SVG rendering apply. SVG rendering remains
  explicit: `render_board` writes PCB PNGs; `render_schematic_svg` and `render_pcb_svg` populate
  their corresponding tabs. New projects default to Freerouting with automatic fab_router fallback.

#### First end-to-end run — 2026-09-07

fabdesk daemon (`retire-tscircuit`) → bridge (fab_pcb #3, fork `280274cc3d`) → fork `kicad-cli`, on a
three-part board (2-pin header, 0603 resistor, 0603 LED; stock footprints via `KICAD10_FOOTPRINT_DIR`):

| step                                            | result                                                                        |
| ----------------------------------------------- | ----------------------------------------------------------------------------- |
| `circuit_build`                                 | 3 footprints resolved, placed, saved — 3.6 s (compile job 1.8 s)              |
| `route_run` (capacity = the bridge's JS router) | 3/3 in 64–121 ms, 21 tracks, applied as one commit                            |
| `verify_drc` on the saved file                  | 0 errors, 0 unconnected, 2 silkscreen warnings (reference text near the edge) |
| `render_board`, `render_pcb_svg`                | `renders/top.png`, `renders/pcb.svg`                                          |

Three seams the run found, all fixed on the fabdesk side and worth a bridge follow-up:

1. **The route job saves before routing, not after applying** (its save feeds the DSN export), so
   the file lagged the session and DRC on the file disagreed with the ratsnest. `DesignService`
   now saves after `route` and `unroute`. Bridge follow-up: a `save` flag on the route job like the
   compile job has.
2. **A session the compile job created a project in stays listed as bare** (`path: null`), so a
   restarted daemon could not find it by path and spawned a second server on the same project.
   fabdesk now adopts a bare session whose `GetProjectInfo` names this project. Bridge follow-up:
   refresh `session.path` when a job creates or opens a project.
3. **A session spawned on `board.kicad_pro` loads the project but opens no board.** fabdesk prefers
   `board.kicad_pcb` as the session path and opens the board explicitly otherwise.

Also found: Bun honours tsconfig `paths` at runtime, so the declaration mapping for
`@fp-pcb/{proto,client}` lives in `apps/core/tsconfig.typecheck.json` (used by `tsc` only), not in
the base config the daemon runs under.

## 5. Skeleton review — what was wrong and what PR 1 does about it

Verified against the fork source at `280274cc3d`:

| #   | finding                                                                                                                                                                                                                                                                                                       | fix                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A.1 | `reportDiagnostics` graded lines by `/error/i`, but `WX_STRING_REPORTER::Report` (`common/reporter.cpp:98`) drops severity and the real failures read `Cannot add R1 (footprint 'X' not found).` — an import with `errorCount: 1` came back `ok: true`.                                                       | Grade by `errorCount` / `warningCount` only; the report text is detail on one diagnostic.                                                              |
| A.2 | A partially failed import still drew the outline and autoplaced, breaking "a failed compile never touches the board" at the apply stage.                                                                                                                                                                      | `importNetlist({ dryRun: true })` first — it resolves footprints against the real `fp-lib-table`, which `validateNetlist` cannot — and stop on errors. |
| A.3 | Outline drawn _after_ import and `autoplace([])`. Headless `OnNetlistChanged` spreads new footprints from `{0,0}` (`headless_pcb_context.cpp:215`); `autoplace([])` means offboard-only (`api_handler_pcb.cpp:4483`); the rectangle's corner is the origin, so spread footprints inside it were never placed. | Outline first; `autoplace(addedIds, { includeOffboard: true })` where `addedIds` is the footprint diff around the import.                              |
| A.4 | `updateFootprints` / `deleteExtraFootprints` defaulted off — "update PCB from schematic" defaults. Changing R1 from 0402 to 0603 in source left the old footprint.                                                                                                                                            | Both default **on** for a source-of-truth compile; `matchMode: "reference"` stays.                                                                     |
| A.5 | `autoplace_failed` branch unreachable: every non-completed result maps to `APR_NO_BOARD_OUTLINE`.                                                                                                                                                                                                             | One branch, honest wording.                                                                                                                            |
| A.6 | `AutoplaceFootprints` returns `AS_BUSY` if the caller holds an open commit.                                                                                                                                                                                                                                   | The job uses its own `KiCadClient` with `clientName` `fp-pcb/bridge/<session>/compile` (PR 2).                                                         |
| A.7 | No footprint libraries on headless servers.                                                                                                                                                                                                                                                                   | `FrontendResult.libraries` in the IR; provisioning is phase 0 (§4.5.3).                                                                                |
| —   | `handleImportNetlist` bumps the revision but never publishes `DocumentChanged` (`api_handler_pcb.cpp:2088`): a browser tab on the session never learns about imported footprints.                                                                                                                             | Job `done` event carries `revision`; fork patch to publish (PR 2).                                                                                     |

## 6. Viability verdict

**Viable as scoped, with one gating decision and one missing prerequisite.** The library +
netlist frontend + local integration test are viable now: the fork build exists on this machine
(`../kicad/build/release/…/kicad-cli` at the pin), stock footprints are installed, and every API
call the pipeline makes is exercised by `fab_pcb`'s own conformance suite. As a _product_ path the
**bundled-fork** decision (§3.2) makes phase 0 the three-platform `kicad-cli` build — a known,
bounded engineering cost with Windows as the open item. The prerequisite the earlier plan missed is **footprint libraries on headless servers**
(§4.5.3) — without them a compile succeeds at validation and fails at every `addNewFootprint`.

**The de-risking experiment — run 2026-09-07, results in §6.1.** As designed: spawn the fork build with
`KICAD10_FOOTPRINT_DIR` pointing at the installed footprints, `newProject` in a temp dir, write a
two-component `.net` (`R1` `Resistor_SMD:R_0402_1005Metric`, `D1` `LED_SMD:LED_0603_1608Metric`,
two nets), then `importNetlist(dryRun)` → `importNetlist` → outline commit →
`autoplace(ids, includeOffboard)` → DRC → save, timing each step and dumping `report` verbatim.
That confirms or refutes A.1, A.3, the `DocumentChanged` gap and the library dependency in one
run, and it _is_ the body of `apply.kicad.test.ts`. Repeat inside the Docker image with the bridge
in a sibling container to get the cold-start + provisioning number the hosted decision needs.

### 6.1 Experiment results — 2026-09-07, fork `280274cc3d`, macOS

Script: `packages/compile/bench/experiment.ts` on `fab_pcb` (`bun run experiment`). Bare
`api-server`, no project, `KICAD10_FOOTPRINT_DIR` at the stock footprints.

| step                                            | result                                                                                                                   | time                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| spawn bare `api-server` + connect               | ok                                                                                                                       | 0.4–0.5 s                                   |
| `NewProject(<dir>/name.kicad_pro)` + open board | ok. An extension-less path is a _directory to create_; `currentBoard()` is empty afterwards — call `project.openBoard()` | 0.1–1.0 s                                   |
| `ImportNetlist` dry run                         | 0 errors, 2 footprints resolved, board untouched                                                                         | 1.2–1.8 s cold (library load), 5–22 ms warm |
| outline commit (20 × 10 mm)                     | revision 0 → 1                                                                                                           | 3 ms                                        |
| `ImportNetlist`                                 | 2 footprints, 2 nets connected, revision → 2                                                                             | 1 ms                                        |
| footprints after import                         | D1 (1.54, 0.80) mm, R1 (0.95, 3.08) mm — **spread from the origin, inside the outline** (A.3)                            | —                                           |
| `AutoplaceFootprints(added, includeOffboard)`   | placed 2 → (1, 3), (1, 5) mm                                                                                             | 1 ms                                        |
| DRC                                             | 2 unconnected (expected) + **2 `copper_edge_clearance`** + silk clipped by edge (A.8)                                    | 3 ms                                        |
| `SaveDocument`                                  | `(kicad_pcb (version 20260831) …`                                                                                        | 22 ms                                       |
| `applyNetlist` on a second fresh project        | identical: 2 added, 2 placed, no diagnostics                                                                             | 22 ms end to end                            |

Library provisioning (A.7):

| configuration                                | dry run                                                                                                                                                                               |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| no `KICAD10_FOOTPRINT_DIR`, no project table | 2 errors — `R1 footprint 'R_0402_1005Metric' not found in any libraries in the footprint library table.` then `Cannot add R1 (footprint 'Resistor_SMD:R_0402_1005Metric' not found).` |
| project-local `fp-lib-table` only            | resolves                                                                                                                                                                              |

Reading the fork-written board:

| tool                                                 | outcome                                                                                                      |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| stock `kicad-cli` 10.0.4 `pcb drc`, `pcb export svg` | **`Failed to load board`, exit 3**                                                                           |
| fork `kicad-cli` `pcb drc`, `pcb export svg`         | ok — 7 violations + 2 unconnected in the JSON `runDrc` parses; SVG plotted                                   |
| fabdesk `importKicadPcb`, strict                     | ok — 40 elements, 2 `source_component`, 4 pads, 2 routable nets, design rules from `.kicad_pro`, no warnings |

**Conclusions.**

1. The apply order holds and A.1–A.5 are verified on a live server, not just reasoned. The report
   text carries no severity; a project-local `fp-lib-table` is sufficient provisioning, so
   `FrontendResult.libraries` → table row is the mechanism. §4.6 items 3 and 4 are settled.
2. **Stock and fork do not mix.** Phase 3 works only with the fork binary doing DRC, render and
   export too. Under the bundled-fork decision that is the natural single-binary shape; until the
   bundle exists, dev sets `kicadCliPath` to the fork build.
3. **A.8, new:** the legacy autoplacer packs footprints into the top-left corner and ignores the
   copper-to-edge rule (0.5 mm required, 0.0 / 0.22 mm actual). A fresh compile therefore fails DRC
   on edge clearance every time. The compile job must inset the placement region by the edge
   clearance (shrink the outline it hands to the placer, or offset afterwards) before this is
   agent-visible.
4. `NewProject` wants the `.kicad_pro` path — fabdesk's adapter already passes it — and the job
   must open the board explicitly afterwards.
5. Not exercised: `DocumentChanged` publication after `ImportNetlist` (only the revision counter
   was watched; it bumps 0 → 1 → 2 as expected).

## 7. Superseded

The first draft of this doc recommended keeping `@tscircuit/eval` as the compiler behind the seam
and embedding `SessionManager` in `apps/core`. Both are reversed above (§4.2, §4.4) on the
strength of the router job precedent that landed on `fab_pcb` `main` between drafts.

Project library writes use one host-managed transaction per native session. The host keeps a private recovery snapshot in `.fabdesk/library-recovery/`, refuses detected external changes before each client table-write RPC, and carries the snapshot through session-loss recovery. A detected conflict keeps the newer disk table and both recorded versions for inspection. Search/description refresh saved project overrides before returning geometry.

Direct filesystem writers must close the native session before changing library tables, or use `circuit_library` for supported registration. The native bridge can perform internal table saves that an uncoordinated filesystem writer does not participate in; the host cannot promise atomic compare-and-swap against arbitrary external programs. This bounded writer contract is distinct from recovery after detected client-side conflicts. Never describe table restoration alone as a guarantee for every external edit during a remote compile.
