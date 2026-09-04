# fabPlane

Desktop AI PCB generator for macOS, Linux and Windows. Sketch a board or describe it; a coding
agent (Claude Code, Codex, Cursor, Grok) drives fabPlane's MCP tools to write a
[tscircuit](https://tscircuit.com) circuit, convert it to KiCad, route it with live visual routing,
and verify it locally (DRC, ERC, SPICE, renders).

fabPlane runs standalone or as an MCP server inside Claude Code / Codex / Cursor / Grok.

## Layout

| Path | What |
|---|---|
| `apps/core` | `fabdesk-core`: Bun daemon (compiled sidecar). Hosts tscircuit, KiCad CLI, the router worker and the MCP server. |
| `apps/desktop` | Electron shell (electron-vite + React). Thin client over `fabdesk-core`. |
| `packages/protocol` | Shared zod schemas: control API, event stream, route frames, handshake. |
| `packages/tools` | Tool registry (single source of truth) + MCP / HTTP / WebMCP / AGENTS.md adapters. |
| `packages/tscircuit` | circuit.tsx → circuit-json, checks, SimpleRouteJson extraction, trace merge, SVG. |
| `packages/kicad` | circuit-json → `.kicad_*`, DRC/ERC gate, renders, exports (wraps `@pcb/pcb/kicad-cli`). |
| `packages/router` | `RouterAdapter`, capacity-autorouter adapter, Bun Worker host, frame protocol. |
| `packages/router-freerouting` | js_autorouter adapter. **Internal builds only.** |
| `packages/sim` | SPICE netlist + spicey / ngspice. |
| `packages/agents` | Agent adapters: claude, codex, cursor, grok. |
| `packages/auth-client` | fabplane.com device-code login, credential store, local mode. |
| `packages/ui` | React components: chat, board panel, route cinema, sketch pad. |
| `vendor/fabplane` | git submodule → `TensorFleet/fabplane.com`. Shared `@pcb/*` packages. |
| `vendor/js_autorouter` | git submodule → `TensorFleet/js_autorouter`. Private, GPL-derivative; never shipped in public builds. |

## Setup

Requires Bun 1.4.x, Node 20+ (Electron tooling), KiCad 9/10 (detected, not bundled).

```bash
git clone --recurse-submodules git@github.com:TensorFleet/fabdesk.git   # add --recurse-submodules; public builds can skip vendor/js_autorouter
bun install
bun run typecheck
bun test
bun run dev
```

`bun run dev` starts **fabPlane Dev**, an isolated Electron identity (separate userData, single-instance
lock, core home and port) so it can run at the same time as an installed production fabPlane. See
[docs/dev-loop.md](docs/dev-loop.md).

Rules:

- **Never run `bun install` inside `vendor/fabplane`** from this checkout. The root lockfile owns every
  dependency; a nested `node_modules` creates duplicate `zod`/`hono` instances.
- Shared fabplane code is changed by PRs to `TensorFleet/fabplane.com`, then `bun run submodules:update`.
- `vendor/js_autorouter` is optional. `FABDESK_CHANNEL=internal` builds include it; public builds must not.

## Error reporting

Crash and error reports go to Sentry only when a DSN is configured (`SENTRY_DESKTOP_DSN` at runtime, or the
`SENTRY_DESKTOP_DSN` repo secret baked into release builds); development builds send nothing. Users can opt
out in Settings → Privacy. Reports never include prompts, board files, tokens or project paths. See
[docs/sentry.md](docs/sentry.md).

## Auth

fabPlane signs in through fabplane.com using the OAuth device-authorization flow. For local
development set `FABDESK_AUTH_MODE=local` (honored only in non-public channels or with a
`.fabdesk-dev` marker in the fabPlane config dir).
