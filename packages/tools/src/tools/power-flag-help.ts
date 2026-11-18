import { NetlistFile } from "@fabdesk/protocol";
import { readFile } from "node:fs/promises";
import { jailPath } from "../fs";
import type { DesignService } from "../services";

/** Failure-only diagnosis. Bound total latency and unique lookups; never hold up the build for a bridge. */
export async function powerFlagHelp(projectDir: string, entrypoint: string, describePart: DesignService["describePart"]) {
  let ref = "#FLG01";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const diagnose = async (): Promise<string[]> => {
    const file = NetlistFile.parse(JSON.parse(await readFile(await jailPath(projectDir, entrypoint), "utf8")));
    const refs = new Set(file.netlist.components.map((c) => c.ref));
    for (let n = 1; refs.has(ref); n++) ref = `#FLG${String(n + 1).padStart(2, "0")}`;
    const components = new Map(file.netlist.components.map((c) => [c.ref, c]));
    const ids = new Set<string>();
    for (const net of file.netlist.nets) for (const node of net.nodes) {
      const symbol = components.get(node.ref)?.libSource;
      if (!symbol) throw new Error("missing symbol");
      ids.add(`${symbol.lib}:${symbol.part}`);
    }
    if (expired || ids.size > 64) return [];
    const pending = [...ids];
    const parts = new Map<string, Awaited<ReturnType<typeof describePart>>>();
    await Promise.all(Array.from({ length: Math.min(8, pending.length) }, async () => {
      while (!expired && pending.length) {
        const id = pending.shift()!;
        parts.set(id, await describePart("symbol", id, projectDir));
      }
    }));
    if (expired) return [];
    return file.netlist.nets.filter((net) => {
      const types = net.nodes.map((node) => {
        const symbol = components.get(node.ref)!.libSource!;
        const pin = parts.get(`${symbol.lib}:${symbol.part}`)?.pins?.find((p) => p.number === node.pin);
        if (!pin) throw new Error("missing pin");
        return pin.electricalType;
      });
      return types.includes("PT_POWER_IN") && !types.includes("PT_POWER_OUT");
    }).map((net) => net.name);
  };
  let nets: string[];
  try {
    nets = await Promise.race([
      diagnose().catch(() => { expired = true; return []; }),
      new Promise<string[]>((resolve) => { timer = setTimeout(() => { expired = true; resolve([]); }, 500); }),
    ]);
  } finally {
    expired = true;
    clearTimeout(timer);
  }
  const names = nets.slice(0, 8).join(", ") + (nets.length > 8 ? `, +${nets.length - 8} more` : "");
  return {
    nets,
    text: `${nets.length ? `Nets ${names}` : "Some nets"} have power-input pins but nothing KiCad counts as a power source.\n` +
      "If they really are supplied (a connector, or a part whose output pin is passive), add one PWR_FLAG per net:\n" +
      JSON.stringify({ ref, value: "PWR_FLAG", footprint: "", libSource: { lib: "power", part: "PWR_FLAG" } }) +
      " and net node " + JSON.stringify({ ref, pin: "1" }) + "\nIf nothing supplies them, fix the circuit instead.",
  };
}
