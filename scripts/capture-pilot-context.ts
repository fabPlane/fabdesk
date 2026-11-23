/** Capture actual Codex rollout context for preflight; refuses requested-only model/effort claims. */
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
export function capturePilotContext(rollout: string) {
  const events = rollout.split("\n").filter(Boolean).map(line=>JSON.parse(line));
  const meta = events.find(e=>e.type==="session_meta")?.payload;
  const turn = events.find(e=>e.type==="turn_context")?.payload;
  if (!meta || !turn || typeof turn.model!=="string" || typeof turn.effort!=="string") throw Error("Actual session metadata and model/effort context are required before timing");
  const messages = [];
  for (const event of events) {
    if (event.type==="response_item" && event.payload?.type==="message" && ["system","developer","user"].includes(event.payload.role)) messages.push(event.payload);
    if (event.type==="response_item" && event.payload?.role==="assistant") break;
  }
  const instructions = JSON.stringify({base:meta.base_instructions,messages});
  const catalogs = messages.flatMap(m=>(m.content??[]).flatMap((c:any)=>typeof c.text==="string" && c.text.includes("## Skills")?[c.text.slice(c.text.indexOf("## Skills"))]:[]));
  if (!catalogs.length) throw Error("Actual skill catalog was not captured; do not substitute a requested allowlist");
  return { capturedAt: new Date().toISOString(), sessionId: meta.id??meta.session_id, model:turn.model, effort:turn.effort, cwd:turn.cwd??meta.cwd, instructions, skillCatalog:catalogs.join("\n\n"), disabledPluginIds:turn.disabled_plugin_ids??[], approvalPolicy:turn.approval_policy, permissions:turn.permission_profile??turn.sandbox_policy, cliVersion:meta.cli_version, sourceSha256:createHash("sha256").update(rollout).digest("hex"), limitation:"The actual initial rollout is captured. Attach actual runtime settings, MCP/plugin configuration, backend provenance and viewport separately; this does not establish whole-runtime equivalence." };
}
if (import.meta.main) { const [input,output]=process.argv.slice(2); if(!input||!output)throw Error("usage: bun scripts/capture-pilot-context.ts rollout.jsonl NEW-context.json");await writeFile(output,JSON.stringify(capturePilotContext(await readFile(input,"utf8")),null,2)+"\n",{flag:"wx"}); }
