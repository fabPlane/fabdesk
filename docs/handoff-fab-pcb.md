# Handoff: fabdesk on FabPlane PCB (backend)

Written 2026-09-08 at the end of the tscircuit → FabPlane PCB migration. Everything below is on
`main` in both repos. The long-form design and its history are in
[fab-pcb-migration.md](fab-pcb-migration.md); this file is what you need to run, change and
finish it.

## 1. What changed, in one paragraph

fabdesk used to compile an agent-written `circuit.tsx` with `@tscircuit/eval` into
`circuit.json`, and every tool (routing, DRC, render, export, sim) spoke that JSON. Now the agent
writes **`circuit.netlist.json`** (components, nets, board size), the **FabPlane PCB bridge**
(`TensorFleet/fab_pcb`) compiles it into **`board.kicad_pcb`** on a headless `kicad-cli
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
| agent guide | `packages/agents/src/agents-md.ts` | the `circuit.netlist.json` schema and workflow the agent is given |
| compile package | fab_pcb `packages/compile` | `Frontend → Netlist → .net → ImportNetlist → outline → autoplace → edge-clearance inset`; the `netlist-json` frontend; `bridge-job.ts` |
| route job | fab_pcb `packages/router/src/bridge-job.ts` | JS router (the old "capacity") or Freerouting; applied as one commit |
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

## 5. CI

- **fabdesk:** the workflows now init `vendor/fab_pcb` next to `vendor/fabplane`. fab_pcb is a
  private repo, so `FABDESK_SUBMODULE_SSH_KEY` needs a read-only deploy key for it appended (the
  js_autorouter key in that secret is dead weight now). Until that key exists, `bun install` in CI
  fails with "workspace … listed in bun.lock but not on disk". Procedure in
  [releases.md](releases.md) (`ssh-keygen -t ed25519 -C git@github.com:TensorFleet/fab_pcb`,
  `gh repo deploy-key add`, re-set the secret with both keys concatenated).
- **fab_pcb:** `bun (unit)` and `kicad-integration` have been red on `main` since before this work:
  the workflow fetches the fork pin from upstream GitLab (`KICAD_REPO`), which does not have it.
  Point `KICAD_REPO`/`KICAD_REF` at the fork and publish the Docker image at `KICAD_COMMIT`
  (fab_pcb `docs/07-upstream-sync.md`).

## 6. Open work, in the order I would do it

1. **Bundle the fork `kicad-cli` and the bridge** (phase 0; decided: bundled, not hosted).
   fab_pcb has macOS and Linux build scripts, no Windows one. Until then developers run the bridge
   by hand and nothing in fabdesk spawns it. `doctor` reports the bridge; a warning when the
   resolved `kicad-cli` is older than 10.99 is still missing.
2. **Footprint libraries in the bundle.** Headless servers ship none; compiles fail at
   `addNewFootprint` without them. The netlist file can name `libraries` (registered per project)
   and the search tool lists whatever the server's tables hold.
3. **Bridge follow-ups** (all found by the first end-to-end run, all worked around in fabdesk):
   the route job should save after applying (fabdesk saves after `route`/`unroute` itself);
   refresh `session.path` when a job creates a project (fabdesk adopts bare sessions by
   `GetProjectInfo`); a `Footprint.translate` in `@fp-pcb/client` (the compile inset moves the
   outline instead of parts); `ImportNetlist` should publish `DocumentChanged` (fork patch).
4. **Agent authoring quality.** The netlist schema and workflow are in `agents-md.ts` and the MCP
   prompts; nobody has run an agent through them yet. Expect iterations on footprint selection
   (`circuit_search_parts`) and on the placement the legacy autoplacer produces.
5. **Schematics.** A compiled netlist has no drawn schematic, so `verify_erc`,
   `render_schematic_svg` and schematic parity only apply to imported KiCad projects. Generating a
   schematic from the netlist (KiCad can create symbols/wires over the API) is the one capability
   tscircuit had that nothing replaces.
6. **Route Cinema on real boards.** Frames come from job progress (pass / connection events, no
   geometry); the JS router finished the test board before any progress streamed.
7. Small: `apps/desktop` user-data test assumes a case-sensitive filesystem; Freerouting stays
   internal-only at the tool layer; `docs/benchmarks.md` is historical.

## 7. Decisions already taken (do not relitigate without a reason)

- **Bundled fork, not hosted** — offline builds matter; hosted stays possible because the compile
  package and the adapter are the same either way.
- **Netlist-first** — the agent writes `circuit.netlist.json`; a tscircuit-compatible frontend was
  never built and is not planned.
- **fabdesk is a bridge client** — HTTP for jobs, the typed client over the bridge's WebSocket for
  reads and edits; never embed the bridge or `SessionManager` in core.
- Match mode `reference`, `updateFootprints`/`deleteExtraFootprints` on: the netlist is the truth.

## 8. Where the history is

- fabdesk PRs #136 (plan + submodule), #137 (compiler behind a flag), #139 (tscircuit removed);
  fab_pcb PRs #2 (compile package), #3 (bridge job). All merged to `main`.
- `docs/fab-pcb-migration.md` — the design, the review findings (§5), the experiment results
  (§6.1), the end-to-end run (§4.7).
- fab_pcb `docs/04-ipc-gaps.md` G28 — the three KiCad API behaviours the compile job hit.
