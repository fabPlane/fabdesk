# Using Fabdesk as an MCP server

Fabdesk exposes its PCB tools (build, route, DRC, render, export, …) over the Model Context
Protocol. Any MCP-capable coding agent can drive a Fabdesk project from the terminal.

Two transports are available:

| Transport | Command / URL | When to use |
| --- | --- | --- |
| **stdio** | `fabdesk-core mcp` | Recommended. The subprocess proxies to the running Fabdesk app (so the GUI shows live routing frames and results) and falls back to a standalone in-process server when the app is not running (`--standalone` forces this). |
| **streamable HTTP** | `http://127.0.0.1:<port>/mcp` with `Authorization: Bearer <token>` | When the client supports remote MCP servers. Port and token are in `daemon.json` (see below). |

Only the **core** toolset (`pcb_environment`, `project_status`, `circuit_build`, `circuit_read_errors`, `route_run`,
`verify_drc`, `render_board`, `load_toolset`) is listed at start. Ask the agent to call
`load_toolset` with `project`, `circuit`, `route`, `kicad`, `verify`, `render`, `export`, `sim` or `app`
(drive the running desktop window; see [app-automation.md](app-automation.md))
to enable more; the tool list refreshes automatically.

## Locating the binary

| Platform | Path |
| --- | --- |
| macOS | `/Applications/fabPlane.app/Contents/Resources/core/fabdesk-core` |
| Linux (AppImage) | `<mount>/resources/core/fabdesk-core`, or `~/.local/bin/fabdesk` after `fabdesk-core install-cli` |
| Windows | `C:\Users\<you>\AppData\Local\Programs\fabPlane\resources\core\fabdesk-core.exe` |
| Development checkout | `bun run /path/to/fabdesk/apps/core/src/main.ts` |

Run `fabdesk-core install-cli` once to get a `fabdesk` symlink in `~/.local/bin`; the snippets
below use the full macOS path — substitute yours.

Run `fabdesk-core doctor` to confirm KiCad, ngspice, routers and agent CLIs are detected.

### Project selection

Tools take an optional `project` argument (project id, name or absolute path). When you start
`fabdesk-core mcp` inside a directory containing `fabdesk.json`, or pass `--project <dir>`, that
project becomes the default and the argument can be omitted.

## Claude Code

```bash
claude mcp add --transport stdio fabdesk -- "/Applications/fabPlane.app/Contents/Resources/core/fabdesk-core" mcp
# scope it to the current project directory instead of the user profile:
claude mcp add --scope project --transport stdio fabdesk -- "/Applications/fabPlane.app/Contents/Resources/core/fabdesk-core" mcp
```

Tools appear as `mcp__fabdesk__<tool>`; allow them all with `--allowedTools "mcp__fabdesk__*"` or in
`.claude/settings.json`:

```json
{ "permissions": { "allow": ["mcp__fabdesk__*"] } }
```

Streamable HTTP alternative (port/token from `daemon.json`):

```bash
claude mcp add --transport http fabdesk http://127.0.0.1:PORT/mcp --header "Authorization: Bearer TOKEN"
```

## Cursor

`.cursor/mcp.json` in the project (or `~/.cursor/mcp.json` globally):

```json
{
  "mcpServers": {
    "fabdesk": {
      "command": "/Applications/fabPlane.app/Contents/Resources/core/fabdesk-core",
      "args": ["mcp"]
    }
  }
}
```

HTTP variant:

```json
{
  "mcpServers": {
    "fabdesk": {
      "url": "http://127.0.0.1:PORT/mcp",
      "headers": { "Authorization": "Bearer TOKEN" }
    }
  }
}
```

## Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.fabdesk]
command = "/Applications/fabPlane.app/Contents/Resources/core/fabdesk-core"
args = ["mcp"]
```

HTTP variant (token from an environment variable, never inline):

```toml
[mcp_servers.fabdesk]
url = "http://127.0.0.1:PORT/mcp"
bearer_token_env_var = "FABDESK_TOKEN"
```

One-off: `codex exec -c 'mcp_servers.fabdesk.command="/Applications/fabPlane.app/Contents/Resources/core/fabdesk-core"' -c 'mcp_servers.fabdesk.args=["mcp"]' "call project_status"`.

## Grok CLI

```bash
grok mcp add fabdesk "/Applications/fabPlane.app/Contents/Resources/core/fabdesk-core" mcp --scope user
```

or `.grok/config.toml` in the project:

```toml
[mcp_servers.fabdesk]
command = "/Applications/fabPlane.app/Contents/Resources/core/fabdesk-core"
args = ["mcp"]
```

Allow the tools with `--allow "MCPTool(fabdesk__*)"`.

## Where is `daemon.json`?

The running app writes `daemon.json` (`{version, pid, port, host, token, startedAt, channel, authMode}`,
mode 0600) to the Fabdesk home directory:

| Platform | `FABDESK_HOME` default |
| --- | --- |
| macOS | `~/Library/Application Support/fabdesk` |
| Linux | `$XDG_CONFIG_HOME/fabdesk` (`~/.config/fabdesk`) |
| Windows | `%APPDATA%\fabdesk` |

`fabdesk-core mcp` reads it to find the live daemon. Set `FABDESK_HOME` to relocate it.

## Running the daemon by hand

```bash
fabdesk-core serve --port 0                 # prints {"ok":true,"port":N,"pid":…,"version":…}
FABDESK_AUTH_MODE=local fabdesk-core serve  # skip fabplane login (dev builds, or with a .fabdesk-dev marker)
curl -s http://127.0.0.1:PORT/health
curl -s -H "Authorization: Bearer TOKEN" http://127.0.0.1:PORT/tools/manifest | jq '.[].name'
```

The daemon rejects requests that carry a browser `Origin` other than `null`, `file://`,
`app://fabdesk` or `http://localhost:*`, and MCP requests whose `Host` header is not the bound
address (DNS-rebinding protection).
