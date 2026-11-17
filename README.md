# fabPlane

Desktop AI PCB generator for macOS, Linux and Windows. Sketch a board or describe it; a coding
agent (Claude Code, Codex, Cursor, Grok) drives fabPlane's MCP tools to write a
netlist (`circuit.netlist.json`), build it into a KiCad board on the FabPlane PCB design server, route it with live progress,
and verify it locally (DRC, ERC, SPICE, renders).

fabPlane runs standalone or as an MCP server inside Claude Code / Codex / Cursor / Grok.

## Layout

| Path                   | What                                                                                                                                                                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/core`            | `fabdesk-core`: Bun daemon (compiled sidecar). Talks to the FabPlane PCB bridge (compile + routing on `kicad-cli api-server`), runs the KiCad CLI for DRC/render/export, and hosts the MCP server.                                        |
| `apps/desktop`         | Electron shell (electron-vite + React). Thin client over `fabdesk-core`.                                                                                                                                                                  |
| `apps/mobile`          | **Experimental** Expo client for iOS/Android. Pairs with a `fabdesk-core` over a tailnet. Own lockfile, not a root workspace — see [docs/mobile.md](docs/mobile.md) and [docs/mobile-testing-handoff.md](docs/mobile-testing-handoff.md). |
| `packages/protocol`    | Shared zod schemas: control API, event stream, route frames, handshake.                                                                                                                                                                   |
| `packages/tools`       | Tool registry (single source of truth) + MCP / HTTP / WebMCP / AGENTS.md adapters.                                                                                                                                                        |
| `packages/kicad`       | `kicad-cli` wrappers: DRC/ERC gate, renders, SVG, exports (local CLI helpers).                                                                                                                                                   |
| `packages/sim`         | SPICE netlist + spicey / ngspice.                                                                                                                                                                                                         |
| `packages/agents`      | Agent adapters: claude, codex, cursor, grok.                                                                                                                                                                                              |
| `packages/auth-client` | fabplane.com device-code login, credential store, local mode.                                                                                                                                                                             |
| `packages/client-core` | Platform-agnostic client: `CoreClient`, the event reducer, query hooks, stores, transports. Shared by the desktop and the mobile app.                                                                                                     |
| `packages/ui`          | React components: chat, board panel, route cinema, sketch pad.                                                                                                                                                                            |
| `vendor/fab_pcb`       | git submodule → `fabPlane/fab_pcb` (FabPlane PCB). `packages/{proto,client}` are consumed as workspaces; the bridge runs as its own process.                                                                                              |

## Setup

Requires Bun 1.4.x and Node 22 (Electron tooling). Desktop installers bundle the FabPlane KiCad
fork from the rolling [`nightly` release](https://github.com/TensorFleet/kicad/releases/tag/nightly)
on [`TensorFleet/kicad`](https://github.com/TensorFleet/kicad) (`Resources/kicad/`). Leave Settings →
kicad-cli blank to use it, or set `Settings.kicadCliPath` / `KICAD_CLI` to override. Dev builds
without a staged release still fall back to `PATH` / stock installs.

```bash
git clone --recurse-submodules https://github.com/fabPlane/fabdesk.git
cd fabdesk
bun install
bun run typecheck
bun run test
bun run dev
```

Projects use `FABDESK_PROJECTS_DIR` when set. Otherwise, existing `~/Fabdesk` or `~/fabdesk`
workspaces are preserved, except when that directory is a Fabdesk source checkout. New workspaces
use `~/Fabdesk Projects`, keeping project files separate from a conventional `~/fabdesk` clone.
The daemon and desktop PCB/CAD bridges use the same directory resolver; no existing files are moved.

`bun run dev` starts **fabPlane Dev**, an isolated Electron identity (separate userData, single-instance
lock, core home and port) so it can run at the same time as an installed production fabPlane. See
[docs/dev-loop.md](docs/dev-loop.md).

Rules:

- Install dependencies from this repository root. The root lockfile also owns its public workspace dependencies; do not install inside submodules.
- Source builds and pull-request checks require no TensorFleet membership, private backend checkout, or deployment credentials.
- `circuit_build` and `route_run` need a running FabPlane PCB bridge (`bun run --filter @fp-pcb/bridge start` in a `fab_pcb` checkout with the fork `kicad-cli`); set `FABDESK_FP_PCB_BRIDGE_URL` when it is not on `http://127.0.0.1:4020`.

## Error reporting

Crash and error reports go to Sentry only when a DSN is configured (`SENTRY_DESKTOP_DSN` at runtime, or the
`SENTRY_DESKTOP_DSN` repo secret baked into release builds); development builds send nothing. Users can opt
out in Settings → Privacy. Reports never include prompts, board files, tokens or project paths. See
[docs/sentry.md](docs/sentry.md).

Agent-run debugging is separate from crash reporting: every in-app run gets a portable `llm-dump.json`
with its ordered agent/MCP/KiCad timeline and pre-tool project snapshots. Complete dumps are also kept
in Fabdesk's existing SQLite database for simple lookup and export, with no extra service required. See
[docs/agent-run-telemetry.md](docs/agent-run-telemetry.md).

## Auth

fabPlane signs in through fabplane.com using the OAuth device-authorization flow. For local
development set `FABDESK_AUTH_MODE=local` (honored only in non-public channels or with a
`.fabdesk-dev` marker in the fabPlane config dir).

Backend handoff (running the daemon against the FabPlane PCB bridge, CI keys, open work): [docs/handoff-fab-pcb.md](docs/handoff-fab-pcb.md).

Final cross-repository PR stack, merge order, issue mapping, and Linux packaging evidence: [docs/final-pcb-pr-stack-handoff.md](docs/final-pcb-pr-stack-handoff.md).

`kicad_stats` additionally requires the optional `kicad-cli pcb export stats` command.
Some stock and packaged KiCad builds omit it, regardless of version. `doctor` probes
the command and reports when board statistics are unavailable; other supported exports,
DRC and rendering remain usable.

## CI Linux runners

Trusted Linux workflows pick the repository NAS runner by default. Set the Actions
variable `FORCE_BLACKSMITH_LINUX=true` (or `LINUX_RUNNER=blacksmith`) to pin Blacksmith
until it is unset. A short `NAS_RUNNER_OUTAGE_UNTIL` lease still covers brief outages.
See [docs/ci-runner-policy.md](docs/ci-runner-policy.md).

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for local checks and pull requests and
[SECURITY.md](SECURITY.md) for private vulnerability reporting. Bundled engines,
routers, libraries and artwork keep their own licenses; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

The mobile app is experimental. Signed installers, Apple notarization and hosted
sharing are separate from building the source. Current migration/release limits
are recorded in [docs/fabplane-repository-cutover.md](docs/fabplane-repository-cutover.md).

## License

Original FabDesk source in this repository is licensed under [Apache-2.0](LICENSE).
Submodule repositories and third-party components are outside that grant and
retain their own terms; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
