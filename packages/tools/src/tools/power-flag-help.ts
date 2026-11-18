import { NetlistFile } from "@fabdesk/protocol";
import { readFile } from "node:fs/promises";
import { jailPath } from "../fs";
import type { DesignService } from "../services";

type Diagnosis = { nets: string[]; unconnectedPins: Array<{ ref: string; pin: string; name: string }> };

/** Failure-only diagnosis. Bound total latency and unique lookups; never hold up the build for a bridge. */
export async function powerFlagHelp(projectDir: string, entrypoint: string, describePart: DesignService["describePart"]) {
  let ref = "#FLG01";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const diagnose = async (): Promise<Diagnosis | undefined> => {
    const file = NetlistFile.parse(JSON.parse(await readFile(await jailPath(projectDir, entrypoint), "utf8")));
    const refs = new Set(file.netlist.components.map((c) => c.ref));
    for (let n = 1; refs.has(ref); n++) ref = `#FLG${String(n + 1).padStart(2, "0")}`;
    const components = new Map(file.netlist.components.map((c) => [c.ref, c]));
    const ids = new Set<string>();
    for (const component of file.netlist.components) {
      const symbol = component.libSource;
      if (symbol) ids.add(`${symbol.lib}:${symbol.part}`);
    }
    if (expired || ids.size > 64) return undefined;
    const pending = [...ids];
    const parts = new Map<string, Awaited<ReturnType<typeof describePart>>>();
    await Promise.all(Array.from({ length: Math.min(8, pending.length) }, async () => {
      while (!expired && pending.length) {
        const id = pending.shift()!;
        parts.set(id, await describePart("symbol", id, projectDir));
      }
    }));
    if (expired) return undefined;
    const pinsFor = (component: typeof file.netlist.components[number]) => {
      const symbol = component.libSource;
      const pins = symbol && parts.get(`${symbol.lib}:${symbol.part}`)?.pins;
      if (!pins) throw new Error("missing symbol pins");
      return pins;
    };
    const wired = new Map<string, Set<string>>();
    const nets = file.netlist.nets.filter((net) => {
      const types = net.nodes.flatMap((node) => {
        const component = components.get(node.ref);
        if (!component) throw new Error("missing component");
        const pins = pinsFor(component).filter((p) => p.number === node.pin);
        if (!pins.length) throw new Error("missing pin");
        const numbers = wired.get(node.ref) ?? new Set<string>();
        numbers.add(node.pin);
        wired.set(node.ref, numbers);
        return pins.map((p) => p.electricalType);
      });
      return types.includes("PT_POWER_IN") && !types.includes("PT_POWER_OUT");
    }).map((net) => net.name);
    const unconnectedPins: Diagnosis["unconnectedPins"] = [];
    for (const component of file.netlist.components) {
      if (!component.libSource) continue;
      const pins = pinsFor(component);
      const numbers = wired.get(component.ref);
      for (const pin of pins) {
        if (pin.electricalType !== "PT_POWER_IN" || numbers?.has(pin.number)) continue;
        if (file.netlist.noConnects?.some((n) => n.ref === component.ref && n.pin === pin.number)) continue;
        if (pins.some((p) => numbers?.has(p.number) && p.name === pin.name && p.position.x === pin.position.x && p.position.y === pin.position.y)) continue;
        if (!unconnectedPins.some((p) => p.ref === component.ref && p.pin === pin.number && p.name === pin.name)) {
          unconnectedPins.push({ ref: component.ref, pin: pin.number, name: pin.name });
        }
      }
    }
    return { nets, unconnectedPins };
  };
  let diagnosis: Diagnosis | undefined;
  try {
    diagnosis = await Promise.race([
      diagnose().catch(() => { expired = true; return undefined; }),
      new Promise<undefined>((resolve) => { timer = setTimeout(() => { expired = true; resolve(undefined); }, 500); }),
    ]);
  } finally {
    expired = true;
    clearTimeout(timer);
  }
  const { nets, unconnectedPins } = diagnosis ?? { nets: [], unconnectedPins: [] };
  const lines: string[] = [];
  if (unconnectedPins.length) {
    const names = unconnectedPins.slice(0, 8).map((p) => `${p.ref} pin ${p.pin} (${p.name})`).join(", ") +
      (unconnectedPins.length > 8 ? `, +${unconnectedPins.length - 8} more` : "");
    lines.push(names + (unconnectedPins.length === 1
      ? " is a power input on no net; connect it."
      : " are power inputs on no net; connect them."));
  }
  // A completed diagnosis with no candidates cannot honestly blame a net. Leave the original ERC error alone.
  if (nets.length || !diagnosis) {
    const names = nets.slice(0, 8).join(", ") + (nets.length > 8 ? `, +${nets.length - 8} more` : "");
    lines.push(`${nets.length ? `Nets ${names}` : "Some nets"} have power-input pins but nothing KiCad counts as a power source.\n` +
      "If they really are supplied (a connector, or a part whose output pin is passive), add one PWR_FLAG per net:\n" +
      JSON.stringify({ ref, value: "PWR_FLAG", footprint: "", libSource: { lib: "power", part: "PWR_FLAG" } }) +
      " and net node " + JSON.stringify({ ref, pin: "1" }) + "\nIf nothing supplies them, fix the circuit instead.");
  }
  return { nets, unconnectedPins, text: lines.join("\n") };
}
