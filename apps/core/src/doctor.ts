/** `fabdesk-core doctor`: environment report (KiCad, ngspice, the FabPlane PCB bridge, agents, warnings). */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DoctorReport, Settings } from "@fabdesk/protocol";
import { fpPcbBridgeUrl, type CoreConfig } from "./config";
import { FpPcbBridgeClient } from "./fp-pcb-bridge";
import { errMsg } from "./log";

const MINIMUM_FP_PCB_KICAD = [10, 99] as const;

/** True when a KiCad version string identifies a build older than the FabPlane API fork. */
export function isUnsupportedFpPcbKicad(version: string): boolean {
  const match = version.match(/^(\d+)\.(\d+)/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major < MINIMUM_FP_PCB_KICAD[0] || (major === MINIMUM_FP_PCB_KICAD[0] && minor < MINIMUM_FP_PCB_KICAD[1]);
}

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
  // The bridge runs the design server (compile + routing); reported in the `routers` slot the report has always had.
  const routers = await (async () => {
    const url = fpPcbBridgeUrl(o.settings.fpPcbBridgeUrl);
    try {
      const h = await new FpPcbBridgeClient({ url, timeoutMs: 3_000 }).health();
      const ready = h.ok && h.kicadCliExists !== false;
      return [{ id: "fp-pcb", present: true, ready, detail: `${url}${h.kicadCli ? ` (kicad-cli: ${h.kicadCli})` : ""}${h.kicadCliExists === false ? " — kicad-cli missing on the bridge" : ""}` }];
    } catch (e) {
      return [{ id: "fp-pcb", present: false, ready: false, detail: `${url}: ${errMsg(e)}` }];
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

  if (!kicad.found) warnings.push("KiCad not found: install the FabPlane KiCad build or set Settings.kicadCliPath (DRC, render and export tools need it)");
  else if (kicad.version && isUnsupportedFpPcbKicad(kicad.version))
    warnings.push(
      `KiCad ${kicad.version} at ${kicad.path ?? "the resolved path"} is older than 10.99; use the bundled FabPlane KiCad fork because stock KiCad cannot run the PCB bridge contract`,
    );
  if (!routers[0]?.present) warnings.push(`FabPlane PCB bridge not reachable at ${routers[0]?.detail ?? fpPcbBridgeUrl(o.settings.fpPcbBridgeUrl)}: start it (bun run --filter @fp-pcb/bridge start in a fab_pcb checkout) or set Settings.fpPcbBridgeUrl / FABDESK_FP_PCB_BRIDGE_URL; circuit_build and route_run need it`);
  if (!agents.some((a) => a.installed)) warnings.push("no agent CLI found (claude, codex, grok or cursor agent); the app can still be used as an MCP server");
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
    `Bridge:  ${r.routers.map((x) => `${x.id}${x.ready ? " ✓" : x.present ? " (not ready)" : " ✗"} ${x.detail}`).join("; ") || "none"}`,
    "Agents:",
    ...r.agents.map((a) => `  ${a.id.padEnd(7)} ${a.installed ? `${a.version ?? ""} ${a.path ?? ""}`.trim() : `not installed — ${a.installHint}`}`),
  ];
  if (r.warnings.length) lines.push("Warnings:", ...r.warnings.map((w) => `  - ${w}`));
  return lines.join("\n");
}
