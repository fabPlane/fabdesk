/**
 * board_engines: what the board workflow's engines are (KiCadRoutingTools, TraceMaker, Freerouting, KiCad CLI) and
 * installing them. The board tools already install a missing engine on first use (`board-host.ts` `engineEnsurer`);
 * this tool is for an agent that wants to see the state or install ahead of a long run. In the `board` toolset (the
 * engines serve only the board workflow, and the toolset is loaded wherever a placed board is) and global (engines
 * belong to the machine, not a project). Installs run as a durable job with progress lines; they share one download
 * with any board tool or Settings install already running.
 */
import { z } from "zod/v4";
import type { RouterCatalogId, RouterSnapshot } from "@fabdesk/protocol";
import { runDurable } from "../durable";
import { ToolError, defineTool, type ToolContext } from "../registry";
import { ok } from "./common";

const ENGINES = ["krt", "tracemaker", "freerouting"] as const satisfies readonly RouterCatalogId[];
/** What `all` installs: the engines board_route runs (Freerouting is bundled or a `route_run` choice). */
const WORKFLOW_ENGINES = ["krt", "tracemaker"] as const;

function row(s: RouterSnapshot): string {
  const head = `${s.id}: ${s.ready ? "ready" : s.state.replace("_", " ")}${s.versionInstalled ? ` ${s.versionInstalled}` : ""}${s.path ? ` at ${s.path}` : ""}`;
  const extra = [s.overriddenBy ? `from ${s.overriddenBy}` : "", s.error ? `error: ${s.error}` : "", s.notice ? `note: ${s.notice}` : "", !s.ready && !s.error ? s.installHint : ""];
  return [head, ...extra.filter(Boolean).map((l) => `  ${l}`)].join("\n");
}

async function status(ctx: ToolContext) {
  const routers = ctx.services.routers;
  if (!routers) throw new ToolError("this host has no router registry (engines are configured by env only)", "unavailable");
  const snaps = routers.list().routers.filter((r) => (ENGINES as readonly string[]).includes(r.id));
  const cli = await ctx.services.kicad.resolveCli().catch(() => null);
  const auto = ctx.services.settings().autoInstallEngines !== false;
  const text = [
    ...snaps.map(row),
    `kicad-cli: ${cli ? `ready at ${cli.path}` : "not found (ships with the app; or install KiCad / set KICAD_CLI)"}`,
    `automatic install on first use: ${auto ? "on" : "off (Settings autoInstallEngines)"}`,
  ].join("\n");
  return ok(text, {
    engines: snaps.map((s) => ({ id: s.id, state: s.state, ready: s.ready, ...(s.path ? { path: s.path } : {}), ...(s.versionInstalled ? { version: s.versionInstalled } : {}), ...(s.overriddenBy ? { overriddenBy: s.overriddenBy } : {}), ...(s.error ? { error: s.error } : {}), ...(s.notice ? { notice: s.notice } : {}) })),
    kicadCli: cli?.path ?? null,
    autoInstall: auto,
  });
}

export const board_engines = defineTool({
  name: "board_engines",
  toolset: "board",
  title: "Board engines: status and install",
  description:
    "The engines the board tools run: KiCadRoutingTools (krt: layout check/place/rank/route, last-mile router, rip and nudge steps, why), TraceMaker (layout route, fill:tracemaker) and Freerouting, plus the KiCad CLI. status (default): each one's state, version, path, override and last error. install: install `engine` (krt, tracemaker, freerouting, or all = krt + tracemaker) now; downloads are sha256-checked, KRT gets a private hash-locked Python (uv and CPython are fetched when the machine has neither; nothing needs to be preinstalled). Board tools also install a missing engine on first use, so this is for installing ahead of a long run or installing again after a failure. A set override (Settings krtDir, FABDESK_KRT_DIR, TRACEMAKER_BIN, FREEROUTING_JAR) that is broken is reported, not installed over. Installs take seconds to a few minutes and run as a board job (board_job).",
  inputSchema: {
    action: z.enum(["status", "install"]).default("status"),
    engine: z.enum([...ENGINES, "all"]).optional().describe("install: which engine; default all (krt + tracemaker)."),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: true },
  scope: "global",
  longRunning: true,
  handler: async ({ action, engine }, ctx) => {
    if (action === "status") return status(ctx);
    const routers = ctx.services.routers;
    if (!routers) throw new ToolError("this host has no router registry to install engines from", "unavailable");
    const ids: RouterCatalogId[] = !engine || engine === "all" ? [...WORKFLOW_ENGINES] : [engine];
    return runDurable(ctx, "board_engines", async (job) => {
      const lines: string[] = [];
      const note = (l: string) => {
        lines.push(l);
        job.progress(0.5, l);
      };
      const results = [];
      for (const id of ids) {
        job.signal.throwIfAborted();
        const r = await routers.ensure(id, { explicit: true, onLine: note });
        results.push(r);
        note(r.path ? `${id}: ready at ${r.path}` : `${id}: not installed: ${r.why ?? "unknown reason"}`);
      }
      const failed = results.filter((r) => !r.path);
      const text = [...lines, "", failed.length ? `${failed.length} of ${results.length} not installed` : `ready: ${results.map((r) => r.id).join(", ")}`].join("\n");
      return ok(text, { engines: results.map((r) => ({ id: r.id, ready: !!r.path, ...(r.path ? { path: r.path } : {}), ...(r.why ? { why: r.why } : {}), ...(r.installed ? { installed: true } : {}) })) });
    });
  },
});

export const boardEngineTools = [board_engines];
