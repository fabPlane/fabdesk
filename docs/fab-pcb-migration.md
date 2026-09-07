# Migrating fabdesk off tscircuit onto FabPlane PCB (`fab_pcb`)

Status: **design + a drafted `@fp-pcb/compile` skeleton; nothing in fabdesk's tscircuit
path has moved.** Pinned to `fab_pcb` `757de90` (KiCad fork `280274cc3d`, tag
`fp-pcb/2026-09-07-upstream-be90a7e200`). §5 reviews the skeleton, §6 is the viability verdict.

## 0. The headline

`TensorFleet/fab_pcb` is **FabPlane PCB**: a headless KiCad stack on the KiCad IPC API
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

`@fp-pcb/router` depends on `@tscircuit/capacity-autorouter@0.0.885`, and the bridge now depends
on `@fp-pcb/router`, so even a bridge-only deployment carries it. Removing it is a `fab_pcb`
decision (swap `js-router.ts` to `vendor/js_autorouter`), out of scope for compile.

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

| phase | work                                                                                                                                                                                                  | tscircuit present     |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| 0     | **Bundled fork (decided, §3.2):** build/sign/notarise `kicad-cli` for macOS, Linux, Windows — add a Windows script to `kicad-patches/`. Ship `kicad-footprints` in the bundle. Run the §6 experiment. | yes                   |
| 1     | `fab_pcb` PR 1: `@fp-pcb/compile` library — rename, the §5 fixes, JSON netlist frontend (`circuit.netlist.json` = `{ netlist, board }`), `FrontendResult.libraries`                                   | yes                   |
| 2     | `fab_pcb` PR 2: `apply.kicad.test.ts` against the fork build, `bridge-job.ts`, bridge mount, `compile.kicad.test.ts`, fork patch so `ImportNetlist` publishes `DocumentChanged`                       | yes                   |
| 3     | fabdesk: bridge client in `apps/core`; `buildCircuit` adapter = compile job → `importKicadPcb(board.kicad_pcb)` → `circuit.json` → `BuildResult`; fix the `boardIsStale` trap (§4.5)                  | yes                   |
| 4     | `fab_pcb`: `tscircuit` frontend for existing `circuit.tsx` projects, emitting project-local `.pretty` for procedural footprints                                                                       | yes, inside `fab_pcb` |
| 5     | Retire `packages/tscircuit`; delete `convert.ts`; routing, DRC, exports, sim, render onto jobs; then delete `import.ts`                                                                               | no                    |

Phase 3's `importKicadPcb` bridge is why `circuit.json` is not a blocker: it is exactly what
`project_import_kicad` does today (927 LOC fabdesk owns) and emits the `source_*` elements routing
needs. Sim over an imported board is lossy until phase 5; accept it.

### 4.5 Constraints to plan around

1. **Cross-repo workflow.** `vendor/*` is never edited here; every `fab_pcb` step is a PR to
   `TensorFleet/fab_pcb`, then `bun run submodules:update` (now covers `vendor/fab_pcb`). Do not
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

**Cheapest de-risking experiment (~1 hour, no Docker):** spawn the fork build with
`KICAD10_FOOTPRINT_DIR` pointing at the installed footprints, `newProject` in a temp dir, write a
two-component `.net` (`R1` `Resistor_SMD:R_0402_1005Metric`, `D1` `LED_SMD:LED_0603_1608Metric`,
two nets), then `importNetlist(dryRun)` → `importNetlist` → outline commit →
`autoplace(ids, includeOffboard)` → DRC → save, timing each step and dumping `report` verbatim.
That confirms or refutes A.1, A.3, the `DocumentChanged` gap and the library dependency in one
run, and it _is_ the body of `apply.kicad.test.ts`. Repeat inside the Docker image with the bridge
in a sibling container to get the cold-start + provisioning number the hosted decision needs.

## 7. Superseded

The first draft of this doc recommended keeping `@tscircuit/eval` as the compiler behind the seam
and embedding `SessionManager` in `apps/core`. Both are reversed above (§4.2, §4.4) on the
strength of the router job precedent that landed on `fab_pcb` `main` between drafts.
