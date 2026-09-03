/** `fabdesk-core doctor`: environment report (KiCad, ngspice, routers, agents, warnings). */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DoctorReport, Settings } from "@fabdesk/protocol";
import type { CoreConfig } from "./config";
import { errMsg } from "./log";

export async function runDoctor(o: { config: CoreConfig; settings: Settings }): Promise<DoctorReport> {
  const warnings: string[] = [];
  const kicad = await (async () => {
    try {
      const m = await import("@fabdesk/kicad");
      const cli = await m.findKicadCli(o.settings.kicadCliPath ?? undefined);
      return cli ? { found: true, path: cli.path, version: cli.version } : { found: false };
    } catch (e) {
      warnings.push(`kicad probe failed: ${errMsg(e)}`);
      return { found: false };
    }
  })();
  const ngspice = await (async () => {
    try {
      const m = await import("@fabdesk/sim");
      const p = await m.findNgspice(o.settings.ngspicePath ?? undefined);
      return p ? { found: true, path: p } : { found: false };
    } catch (e) {
      warnings.push(`ngspice probe failed: ${errMsg(e)}`);
      return { found: false };
    }
  })();
  const routers = await (async () => {
    try {
      const m = await import("@fabdesk/router");
      return (await m.availableRouters()).map((r) => ({ id: r.id, present: r.present, ready: r.ready, detail: `${r.detail}${r.version ? ` (${r.version})` : ""}` }));
    } catch (e) {
      warnings.push(`router probe failed: ${errMsg(e)}`);
      return [];
    }
  })();
  const agents = await (async () => {
    try {
      const m = await import("@fabdesk/agents");
      return await m.detectAgents(o.settings);
    } catch (e) {
      warnings.push(`agent detection failed: ${errMsg(e)}`);
      return [];
    }
  })();

  if (!kicad.found) warnings.push("KiCad not found: install KiCad 9/10 or set Settings.kicadCliPath (DRC, render and export tools need it)");
  if (!agents.some((a) => a.installed)) warnings.push("no agent CLI found (claude, codex, grok or cursor agent); the app can still be used as an MCP server");
  for (const a of agents) {
    // npm's Windows shims are batch files; Bun.spawn cannot start them, so runs die at launch (exit -1).
    if (a.installed && a.path && /\.(cmd|bat)$/i.test(a.path)) {
      warnings.push(`${a.id} resolves to an npm shim (${a.path}); agent runs cannot start it. Install the native build (claude: irm https://claude.ai/install.ps1 | iex) or point Settings.agents.${a.id}.binaryPath at the .exe`);
    }
  }
  if (o.config.channel === "public" && routers.some((r) => r.id === "freerouting" && r.present)) warnings.push("freerouting adapter present in a public build");
  const repoRoot = findRepoRoot();
  if (repoRoot && existsSync(join(repoRoot, "vendor", "fabplane", "node_modules"))) warnings.push("vendor/fabplane/node_modules exists: never run `bun install` inside vendor/fabplane (duplicate zod/hono instances)");
  if (o.config.authMode === "local") warnings.push("auth mode is local (FABDESK_AUTH_MODE=local)");

  return {
    version: o.config.version,
    channel: o.config.channel,
    bun: typeof Bun !== "undefined" ? Bun.version : "n/a",
    platform: `${process.platform}-${process.arch}`,
    kicad,
    ngspice,
    routers,
    agents,
    warnings,
  };
}

function findRepoRoot(): string | null {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "bunfig.toml")) && existsSync(join(dir, "vendor"))) return dir;
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function formatDoctor(r: DoctorReport): string {
  const lines = [
    `fabdesk-core ${r.version} (${r.channel}) on ${r.platform}, bun ${r.bun}`,
    `KiCad:   ${r.kicad.found ? `${r.kicad.path} (${r.kicad.version ?? "?"})` : "not found"}`,
    `ngspice: ${r.ngspice.found ? r.ngspice.path : "not found (spicey fallback)"}`,
    `Routers: ${r.routers.map((x) => `${x.id}${x.ready ? " ✓" : x.present ? " (not ready)" : " ✗"} ${x.detail}`).join("; ") || "none"}`,
    "Agents:",
    ...r.agents.map((a) => `  ${a.id.padEnd(7)} ${a.installed ? `${a.version ?? ""} ${a.path ?? ""}`.trim() : `not installed — ${a.installHint}`}`),
  ];
  if (r.warnings.length) lines.push("Warnings:", ...r.warnings.map((w) => `  - ${w}`));
  return lines.join("\n");
}
