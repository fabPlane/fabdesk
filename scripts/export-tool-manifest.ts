/**
 * Writes fabdesk's MCP tool manifest in the shape fabplane-cli keeps as `spec/fabdesk-tools.json`.
 * The weekly `fabplane-cli-sync` workflow runs it and opens a PR on fabPlane/fabplane-cli when the
 * tools change.
 *
 *   bun scripts/export-tool-manifest.ts [out.json]
 */
import { createRegistry } from "../packages/tools/src/tools/index";
import pkg from "../apps/core/package.json";

const tools = createRegistry().manifest();
const manifest = {
  source: "fabdesk",
  fabdeskVersion: pkg.version,
  generatedAt: new Date().toISOString().slice(0, 10),
  toolCount: tools.length,
  tools,
};
const json = `${JSON.stringify(manifest, null, 2)}\n`;
const out = process.argv[2];
if (out) await Bun.write(out, json);
else process.stdout.write(json);
