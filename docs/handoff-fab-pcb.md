# Handoff: fabdesk on FabPlane PCB (backend)

Written 2026-09-08 at the end of the tscircuit → FabPlane PCB migration. Everything below is on
`main` in both repos. The long-form design and its history are in
[fab-pcb-migration.md](fab-pcb-migration.md); this file is what you need to run, change and
finish it.

## 1. What changed, in one paragraph

fabdesk used to compile an agent-written `circuit.tsx` with `@tscircuit/eval` into
`circuit.json`, and every tool (routing, DRC, render, export, sim) spoke that JSON. Now the agent
writes **`circuit.netlist.json`** (components, nets, board size), the **FabPlane PCB bridge**
(`fabPlane/fab_pcb`) compiles it into **`board.kicad_pcb`** on a headless `kicad-cli
api-server` built from our KiCad fork, routes it there too, and fabdesk's remaining tools run the
fork's `kicad-cli` on that file. fabdesk's packages carry **no tscircuit-ecosystem dependency** and
no `circuit.json` contract. The board is the source of truth; the netlist is the source.

## 2. The parts

```
agent (MCP) ──► fabdesk daemon (apps/core, Bun/Hono)
                  │  DesignService  ──HTTP jobs (compile, route) + WebSocket (typed client)──►  @fp-pcb/bridge :4020
                  │                                                                                │ spawns one per project
                  │  KicadService   ──subprocess──►  fork kicad-cli (DRC, ERC, render, SVG, exports)  kicad-cli api-server
                  │  SimService     ──reads circuit.netlist.json──►  spicey / ngspice                  (KiCad fork, branch web-api)
```

| piece | repo / path | role |
| --- | --- | --- |
| `DesignService` contract | `packages/tools/src/services.ts` | build, query, route, cancelRoute, unroute, scope, searchFootprints, status, release |
| its implementation | `apps/core/src/fp-pcb-design.ts` | compile/route = bridge jobs; everything else via `@fp-pcb/client` on the project's session |
| sessions | `apps/core/src/fp-pcb-session.ts` | one bridge session per project dir; adopts a bare session that holds the project; opens the board explicitly when only the `.kicad_pro` was opened |
| bridge client | `apps/core/src/fp-pcb-bridge.ts` | `/health`, `/sessions`, compile + route jobs followed over SSE, cancel via `DELETE`; errors are `ToolError` codes |
| wire types | `packages/protocol/src/fp-pcb.ts` | mirrors of the bridge's JSON and of `NetlistFile` — kept in sync by hand with fab_pcb |
| tools | `packages/tools/src/tools/*.ts` | `circuit_build`, `route_run`, `verify_drc`, `render_*`, `export_*`, `sim_*`, `circuit_query`, `circuit_search_parts`, `route_*`, `project_import_kicad` (adopts a board) |
| agent guide | `packages/agents/src/agents-md.ts` | the `circuit.netlist.json` schema and workflow the agent is given; a Viagrid section when `board.template` is set |
| prefab blank | `packages/tools/src/templates/viagrid-9055.ts`, `tools/verify.ts` (`verify_viagrid`) | Opulo's Viagrid 9055 as a compile board spec (outline, 180 free vias, 4 holes, rules; `viagridToBoard` for the frame); `circuit_build` sends it in place of the netlist's board when `fabdesk.json` `board.template` is set, `route_run` adds `preset: laser-prefab` ([viagrid-9055.md](viagrid-9055.md)) |
| compile package | fab_pcb `packages/compile` | `Frontend → Netlist → .net → ImportNetlist → outline (+ a blank's vias/holes) → autoplace → edge-clearance inset`; `rules.ts` puts `board.rules` on the board; the `netlist-json` frontend; `bridge-job.ts` |
| route job | fab_pcb `packages/router/src/bridge-job.ts` | JS router (the old "capacity") or Freerouting; applied as one commit. `options.preset: laser-prefab` = tscircuit's Solver8, layer changes only through free vias, which the apply *claims* (`UpdateItems` net) — summary `claimedVias`, `preset` |
| bridge | fab_pcb `packages/bridge` | spawns/supervises `kicad-cli api-server`, relays WebSocket ⇄ nng, mounts the jobs |

fabdesk consumes `@fp-pcb/proto` and `@fp-pcb/client` as root workspaces from the `vendor/fab_pcb`
submodule (pinned; bump with `bun run submodules:update`). The bridge itself is **not** a
workspace — it runs as a separate process from a fab_pcb checkout (its router depends on
`@tscircuit/capacity-autorouter`, which stays out of fabdesk's tree on purpose).

## 3. Running it locally (macOS, verified 2026-09-07)

Prerequisites on the machine:

- The KiCad fork checkout with a release build: `~/projects/tensorfleet/kicad` (branch `web-api`,
  built by fab_pcb's `packages/kicad-patches/build-macos.sh`), giving
  `build/release/kicad/KiCad.app/Contents/MacOS/kicad-cli` (10.99). **Stock KiCad 10.0.4 cannot
  read the boards the fork writes** — every `kicad-cli` fabdesk resolves must be the fork.
- Stock KiCad installed for its footprint libraries (`/Applications/KiCad/KiCad.app/Contents/SharedSupport/footprints`).
- A fab_pcb checkout with `bun install` done (not `vendor/fab_pcb` — never install inside vendor).

Start the bridge (terminal 1):

```bash
cd <fab_pcb checkout>
KICAD_SRC=$HOME/projects/tensorfleet/kicad \
KICAD10_FOOTPRINT_DIR=/Applications/KiCad/KiCad.app/Contents/SharedSupport/footprints \
WORKSPACE_ROOT=/tmp/fp-pcb-ws PORT=4020 \
bun run --filter @fp-pcb/bridge start
```

Start the daemon (terminal 2; `.fabdesk-dev` is what lets `FABDESK_AUTH_MODE=local` work on a public build):

```bash
mkdir -p /tmp/fabdesk-dev && touch /tmp/fabdesk-dev/.fabdesk-dev
FABDESK_TOKEN=devtoken FABDESK_AUTH_MODE=local \
FABDESK_PROJECTS_DIR=/tmp/fabdesk-projects \
KICAD_CLI=$HOME/projects/tensorfleet/kicad/build/release/kicad/KiCad.app/Contents/MacOS/kicad-cli \
KICAD10_FOOTPRINT_DIR=/Applications/KiCad/KiCad.app/Contents/SharedSupport/footprints \
bun run --cwd apps/core src/main.ts serve --port 47999 --data-dir /tmp/fabdesk-dev --local-auth
```

`curl -H 'Authorization: Bearer devtoken' http://127.0.0.1:47999/doctor` should show `kicad`
found at the fork and `routers[0].id == "fp-pcb"` ready. Settings equivalents: `kicadCliPath`,
`fpPcbBridgeUrl` (env `FABDESK_FP_PCB_BRIDGE_URL`).

A board from scratch, over HTTP (the MCP tools are the same handlers):

```bash
H='Authorization: Bearer devtoken'; U=http://127.0.0.1:47999
PID=$(curl -s -H "$H" -H 'content-type: application/json' -X POST $U/projects -d '{"name":"Blink"}' | jq -r .id)
curl -s -H "$H" -X PUT --data-binary @netlist.json "$U/projects/$PID/files/circuit.netlist.json"
call() { curl -s -H "$H" -H 'content-type: application/json' -X POST "$U/tools/$1?sync=1" -d "{\"project\":\"$PID\",\"args\":$2}" | jq -r .text; }
call circuit_build '{}'          # Build OK in ~3.6 s: 3 components, 3 nets, 3 footprints added, 3 placed.
call route_run '{"timeoutMs":60000}'   # 3/3 connections routed, 21 tracks
call verify_drc '{}'             # 0 errors, 0 unconnected (silkscreen warnings are expected)
call render_board '{"view":"top"}'
```

with `netlist.json`:

```json
{
  "netlist": {
    "components": [
      { "ref": "J1", "value": "PWR", "footprint": "Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical" },
      { "ref": "R1", "value": "330", "footprint": "Resistor_SMD:R_0603_1608Metric" },
      { "ref": "D1", "value": "RED", "footprint": "LED_SMD:LED_0603_1608Metric" }
    ],
    "nets": [
      { "name": "VIN", "nodes": [{ "ref": "J1", "pin": "1" }, { "ref": "R1", "pin": "1" }] },
      { "name": "LED_A", "nodes": [{ "ref": "R1", "pin": "2" }, { "ref": "D1", "pin": "2" }] },
      { "name": "GND", "nodes": [{ "ref": "D1", "pin": "1" }, { "ref": "J1", "pin": "2" }] }
    ]
  },
  "board": { "widthMm": 20, "heightMm": 15 }
}
```

Project layout afterwards: `circuit.netlist.json`, `board.kicad_pcb` / `.kicad_pro` / `.kicad_sch`
(stub), `.fabdesk/compile.net` (what the job handed KiCad), `reports/{build,drc}.json`,
`renders/`, `.fabdesk/runs/<id>/frames.jsonl`.

The same on a **Viagrid 9055 blank** (verified 2026-09-08, 4 parts, 0805 footprints):

```bash
call project_set_board '{"template":"viagrid-9055"}'   # before the first build: the blank is drawn only on a board without an outline
call circuit_build '{}'          # Build OK in 2.8 s: … blank drawn (180 free vias, 4 holes); warning prefab_placement
call route_run '{"timeoutMs":180000}'   # Route … (capacity, laser-prefab) … 0 vias (1 factory vias claimed), 45 tracks
call verify_viagrid '{}'         # 180 factory vias on the board, 1 claimed, 0 added; violations: pad_near_hole (J1, autoplaced onto the corner)
call circuit_query '{"select":"vias"}'   # the claimed via carries its net; the other 179 have none
```

What that run shows is the state of the port: build, route, claiming and the check all work on
the bridge; the parts sit where KiCad's autoplacer put them (top-left corner = the top via row), so
DRC reports a pad-to-via clearance and the header near a hole. Placement input is open work (§6).

## 4. Verifying changes

```bash
bun run typecheck    # runs `fp-pcb:types` first (declarations for the vendored client), then every package
bun run test         # every package; apps/desktop has one pre-existing failure on case-insensitive filesystems
```

fab_pcb (in its checkout): `bun run typecheck && bun run test:unit`, and with the fork:
`KICAD_SRC=<fork> bun test packages/compile/test/apply.kicad.test.ts` and
`KICAD_SRC=<fork> bun test packages/bridge/test/compile.kicad.test.ts` (the live compile-job
tests), `bun run --filter @fp-pcb/compile experiment` (the exploratory run with timings).

Gotchas that cost time already:

- **Bun honours tsconfig `paths` at runtime.** The declaration mapping for `@fp-pcb/*` lives in
  `apps/core/tsconfig.typecheck.json` (read by `tsc` only). Put it in a config Bun reads and the
  daemon dies on startup importing a `.d.ts`.
- The vendored client's sources fail fabdesk's `exactOptionalPropertyTypes`; that is why `fp-pcb:types`
  exists. If fab_pcb ever adopts those options, drop the mapping.
- Do not run `prettier --write` on pre-existing fabdesk files: the repo declares `printWidth: 100`
  but is not formatted to it, so you get hundreds of lines of noise. New files only.
- `NewProject` wants the `.kicad_pro` path (an extension-less path becomes a directory);
  `currentBoard()` is empty afterwards; `AddLibraryTableRow` needs `enabled: true` or the row is
  saved disabled; `UpdateItems` on a footprint moves only its anchor (children snap back). All
  recorded as G28 in fab_pcb `docs/04-ipc-gaps.md`.
- **`SetNetClasses` breaks `AutoplaceFootprints` for footprints imported afterwards** (G29):
  `basic_string` from the fork, for the rest of the session. The compile job therefore sets
  minimum constraints before the apply and the `Default` net class after autoplace, and a failed
  autoplace is the `autoplace_failed` warning, not a failed build — a rebuild in a session that
  already set rules leaves new footprints where the import spread them.
- KiCad's netlist importer warns `Via connected to unknown net ()` once per free via; the compile
  filters those out of `import_warnings`. KiCad DRC reports a claimed via a track merely crosses as
  `via_dangling` (a warning): on a blank that is what an unused factory via under a trace is.

## 5. CI

- **fabdesk:** workflows initialise `vendor/fabplane` with its read-only deploy key, then check out
  the pinned `fabPlane/fab_pcb` commit with `FAB_PCB_RELEASE_TOKEN`. The fabPlane organization
  disables deploy keys, so do not append a fab_pcb key to `FABDESK_SUBMODULE_SSH_KEY`. Without
  token access, `bun install` fails with "workspace … listed in bun.lock but not on disk". See
  [releases.md](releases.md).
- **fab_pcb:** `bun (unit)` and `kicad-integration` have been red on `main` since before this work:
  the workflow fetches the fork pin from upstream GitLab (`KICAD_REPO`), which does not have it.
  Point `KICAD_REPO`/`KICAD_REF` at the fork and publish the Docker image at `KICAD_COMMIT`
  (fab_pcb `docs/07-upstream-sync.md`).

## 6. Open work, in the order I would do it

1. **Bundle the fork `kicad-cli` and the bridge** (phase 0; decided: bundled, not hosted).
   fabdesk stages TensorFleet/kicad's rolling `nightly` release into `apps/desktop/kicad-bundle/`
   (`scripts/stage-kicad-bundle.ts`, assets like `kicad-cli-macos-arm64.tar.gz` via `manifest.json`)
   and `after-pack` copies it to `Resources/kicad/`; the core prefers that path unless Settings /
   `KICAD_CLI` override. Remaining: wait for the first successful nightly publish; Windows build
   script in fab_pcb `kicad-patches/` if needed beyond nightly; footprint libraries in the bundle;
   bridge spawn. `doctor` warning when the resolved `kicad-cli` is older than 10.99 is still missing.
2. **Footprint libraries in the bundle.** Headless servers ship none; compiles fail at
   `addNewFootprint` without them. The netlist file can name `libraries` (registered per project)
   and the search tool lists whatever the server's tables hold.
3. **Bridge follow-ups** (all found by the first end-to-end run, all worked around in fabdesk):
   the route job should save after applying (fabdesk saves after `route`/`unroute` itself);
   refresh `session.path` when a job creates a project (fabdesk adopts bare sessions by
   `GetProjectInfo`); a `Footprint.translate` in `@fp-pcb/client` (the compile inset moves the
   outline instead of parts); `ImportNetlist` should publish `DocumentChanged` (fork patch).
4. **Placement input.** The netlist carries no positions and the legacy autoplacer packs parts
   into the outline's corner, ignoring a blank's vias (the Viagrid run above). Options: a
   `placement` per component in `circuit.netlist.json` applied after the import (needs the
   footprint translate from item 3, since `UpdateItems` moves only the anchor), or a placement
   tool over the typed client. Until then a Viagrid board needs its parts moved in KiCad.
5. **Agent authoring quality.** The netlist schema and workflow are in `agents-md.ts` and the MCP
   prompts; nobody has run an agent through them yet. Expect iterations on footprint selection
   (`circuit_search_parts`) and on the placement the legacy autoplacer produces.
6. **Schematics.** The compiler now generates a native KiCad schematic from the netlist. The agent
   must run `verify_erc` and must call `render_schematic_svg` explicitly; `render_board` creates PCB
   PNGs and does not populate the Schematic tab. Generated pin positions are translated from
   library-local coordinates to absolute sheet coordinates before placement.
7. **Route Cinema on real boards.** Frames come from job progress (pass / connection events, no
   geometry); the JS router finished the test board before any progress streamed.
8. Small: `apps/desktop` user-data test assumes a case-sensitive filesystem; Freerouting stays
   available on every channel; `docs/benchmarks.md` is historical.

## 7. Decisions already taken (do not relitigate without a reason)

- **Bundled fork, not hosted** — offline builds matter; hosted stays possible because the compile
  package and the adapter are the same either way.
- **Netlist-first** — the agent writes `circuit.netlist.json`; a tscircuit-compatible frontend was
  never built and is not planned.
- **fabdesk is a bridge client** — HTTP for jobs, the typed client over the bridge's WebSocket for
  reads and edits; never embed the bridge or `SessionManager` in core.
- Match mode `reference`, `updateFootprints`/`deleteExtraFootprints` on: the netlist is the truth.

## 8. Where the history is

- fabdesk PRs #136 (plan + submodule), #137 (compiler behind a flag), #139 (tscircuit removed,
  then merged with `main`'s Viagrid 9055 feature and ported to this stack); fab_pcb PRs #2
  (compile package), #3 (bridge job), #4 (prefab blanks: board rules/vias/holes in the compile,
  the laser-prefab preset and via claiming in the router). All merged to `main`.
- `docs/fab-pcb-migration.md` — the design, the review findings (§5), the experiment results
  (§6.1), the end-to-end run (§4.7).
- fab_pcb `docs/04-ipc-gaps.md` G28 — the three KiCad API behaviours the compile job hit; G29 —
  the `SetNetClasses` / autoplace bug.
- `docs/viagrid-9055.md` — the Viagrid feature as first built on tscircuit, with a note on top
  saying what the port changed.
