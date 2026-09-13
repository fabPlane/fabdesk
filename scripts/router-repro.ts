/**
 * Reproduce a routing case against a running fabdesk-core: create a project from a
 * `docs/router-cases/<name>.netlist.json`, build, route, run DRC and print the violations by rule.
 *
 *   FABDESK_URL=http://127.0.0.1:47831 FABDESK_TOKEN=… bun scripts/router-repro.ts docs/router-cases/ps1-serial-dongle.netlist.json
 *
 * Options: `--router freerouting` (internal channel only), `--settings '{"effort":"high"}'` passed to
 * route_run, `--keep` to leave the project in place (default: deleted with its files afterwards).
 * The daemon needs a FabPlane PCB bridge and the KiCad fork — see docs/handoff-fab-pcb.md §3.
 */
import { basename } from "node:path";

const url = (process.env["FABDESK_URL"] ?? "http://127.0.0.1:47831").replace(/\/$/, "");
const token = process.env["FABDESK_TOKEN"];
if (!token) throw new Error("FABDESK_TOKEN is required (the daemon token from daemon.json)");
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
if (!file) throw new Error("usage: bun scripts/router-repro.ts <case.netlist.json> [--router r] [--settings json] [--keep]");
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const keep = args.includes("--keep");
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${url}${path}`, { method, headers, ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}) });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}
async function tool(project: string, name: string, toolArgs: Record<string, unknown> = {}): Promise<string> {
  // A tool that reports a problem (DRC with errors) answers 422 with the same body shape.
  const res = await fetch(`${url}/tools/${name}?sync=1`, { method: "POST", headers, body: JSON.stringify({ project, args: toolArgs }) });
  if (!res.ok && res.status !== 422) throw new Error(`${name} → ${res.status} ${await res.text()}`);
  const out = (await res.json()) as { text?: string; error?: string };
  return out.text ?? out.error ?? JSON.stringify(out);
}

const netlist = await Bun.file(file).text();
const name = `router-case-${basename(file).replace(/\.netlist\.json$/, "")}-${Date.now().toString(36)}`;
const project = await api<{ id: string; path: string }>("POST", "/projects", { name });
console.log(`project ${project.id} at ${project.path}`);
try {
  await api("PUT", `/projects/${project.id}/files/circuit.netlist.json`, netlist);
  const started = performance.now();
  console.log((await tool(project.id, "circuit_build")).split("\n")[0]);
  const routeArgs: Record<string, unknown> = { timeoutMs: 300_000 };
  const router = opt("router");
  if (router) routeArgs["router"] = router;
  const settings = opt("settings");
  if (settings) routeArgs["settings"] = JSON.parse(settings);
  console.log((await tool(project.id, "route_run", routeArgs)).split("\n").slice(0, 2).join(" "));
  console.log((await tool(project.id, "verify_drc")).split("\n")[0]);
  console.log(`total ${((performance.now() - started) / 1000).toFixed(1)} s`);
  const drc = await api<{ violations: Array<{ rule: string; severity: string; description: string; items: Array<{ description: string }> }> }>(
    "GET",
    `/projects/${project.id}/files/reports/drc.json`,
  );
  const byRule = new Map<string, number>();
  for (const v of drc.violations) byRule.set(`${v.severity} ${v.rule}`, (byRule.get(`${v.severity} ${v.rule}`) ?? 0) + 1);
  for (const [k, n] of [...byRule].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`);
  const examples = drc.violations.filter((v) => v.severity === "error").slice(0, 6);
  for (const v of examples) console.log(`  e.g. ${v.rule}: ${v.description} — ${v.items.map((i) => i.description).join(" | ")}`);
} finally {
  if (!keep) await api("DELETE", `/projects/${project.id}?purge=1`);
  else console.log(`kept ${project.path}`);
}
