# fabPlane plugin

Open PCB, schematic, 3D and CAD views beside your conversation, and manage your project's parts shopping list.

## Before installing

Install the fabPlane desktop app from https://fabplane.com. Open it and run
`fabdesk-core install-cli` once to put `fabdesk` on your PATH. On Windows, add the app's
`resources\core` folder to PATH instead. Restart your chat host after changing PATH.

The plugin starts **your local** `fabdesk mcp --apps` process. Your board files stay on your
computer. Shopping lists and inventory use fabplane.com and require signing in from the
fabPlane desktop app's **Settings → Account**. Signing in to the website alone does not
sign in the local server.

## Install and try it

Use this repository's plugin marketplace and install **fabPlane**. Run **Set up** to check
KiCad and open the Boards view. Then try:

- “Import my KiCad project from this folder as a new fabPlane project.” Include the folder path.
- “Open the PCB view for this project.” Try PCB, Schematic, 3D and CAD drawings.
- “Open the shopping list for this project.” Sign in first, then sync from the BOM.

Import creates a fabPlane project with copies of your files. The original folder remains
unchanged. Rendering and exports need KiCad; native board operations and FreeCAD operations
also need their respective bridges running. The plugin does not bundle those applications.

## Package and release

`plugin.json`, `mcp.json`, `skills/` and `assets/` form the portable package. The
`.codex-plugin`, `.codex.mcp.json`, `.claude-plugin` and `.mcp.json` files preserve compatibility
with existing hosts. Keep their identities, versions and server settings in step.

The logo is the same asset as `apps/desktop/build/icon.png`. The SVG icons reuse the official
website's pixel mark and provide contrasting colors for light and dark interfaces.

Before merging, run `bun run typecheck` and `bun run test` from the repository root, then
check import, board views and signed-in shopping in a supported MCP Apps host. After merging,
users can install from the repository marketplace. A public ChatGPT directory release is a
separate submission and review step; a local stdio server is not a public HTTPS service.
The temporary tunnel URLs used during testing are not included in this package.

See [the MCP Extensions guide](../../docs/mcp-extensions.md) for the tool and entrypoint details,
and [OpenAI's packaging guide](https://developers.openai.com/plugins/build/plugins) for distribution.
