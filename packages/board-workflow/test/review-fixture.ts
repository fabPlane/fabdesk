/** The review tests' project: a USB connector facing inward, an MCU with a FAULT output nobody reads, a far decoupler; a fake kicad-cli. */
import { writeFile } from "node:fs/promises";
import type { CliResult, ReviewEnv } from "../src/index";

export const fp = (ref: string, x: number, y: number, pads: Array<[string, string, number, number]>, extra = "", value = "10k") => `
	(footprint "Lib:${ref}"
		(layer "F.Cu")
		(at ${x} ${y})
		(property "Reference" "${ref}" (at 0 0))
		(property "Value" "${value}" (at 0 0))
		${extra}
		${pads.map(([n, net, px, py]) => `(pad "${n}" smd rect (at ${px} ${py}) (size 0.6 0.6) (layers "F.Cu" "F.Paste") (net "${net}"))`).join("\n")}
	)`;

export const PCB = `(kicad_pcb (version 20250114)
	(layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
	(gr_rect (start 0 0) (end 40 30) (layer "Edge.Cuts"))
	${fp("J1", 2, 15, [["1", "SIG", -1.5, 0], ["2", "SIG2", -1.5, 1]], '(fp_rect (start -3 -4) (end 3 4) (layer "F.CrtYd"))', "USB")}
	${fp("U1", 20, 20, [["1", "VDD", 0, 0], ["2", "GND", 1, 0], ["3", "SIG", 2, 0], ["4", "SIG2", 3, 0]], "", "MCU")}
	${fp("C1", 30, 20, [["1", "VDD", -0.5, 0], ["2", "GND", 0.5, 0]], "", "100n")}
)`;

export const comp = (ref: string, value: string, lib: string, part: string, extra = "") => `<comp ref="${ref}"><value>${value}</value><footprint>F:x</footprint><libsource lib="${lib}" part="${part}" description="d"/>${extra}</comp>`;
export const node = (ref: string, pin: string, fn: string, type: string) => `<node ref="${ref}" pin="${pin}" pinfunction="${fn}" pintype="${type}"/>`;
export const NETLIST = `<?xml version="1.0" encoding="UTF-8"?><export version="E"><components>
${comp("J1", "USB", "Connector", "USB_C")}${comp("U1", "MCU", "MCU", "X")}${comp("C1", "100n", "Device", "C")}
</components><nets>
<net code="1" name="VDD">${node("U1", "1", "VDD", "power_in")}${node("C1", "1", "~", "passive")}</net>
<net code="2" name="GND">${node("U1", "2", "GND", "power_in")}${node("C1", "2", "~", "passive")}</net>
<net code="3" name="SIG">${node("J1", "1", "1", "passive")}${node("U1", "3", "IO1", "bidirectional")}</net>
<net code="4" name="SIG2">${node("U1", "4", "FAULT", "open_collector")}</net>
<net code="5" name="SIG3">${node("J1", "2", "2", "passive")}</net>
</nets></export>`;

export type Fake = { ercViolations?: unknown[]; drcFails?: boolean; gerberFails?: boolean; touch?: () => Promise<void>; calls: string[][] };
export function fakeEnv(f: Fake = { calls: [] }): ReviewEnv {
  return {
    kicadVersion: "fake 1.0",
    kicad: async (args): Promise<CliResult> => {
      f.calls.push(args);
      const o = args.indexOf("-o");
      const out = o >= 0 ? args[o + 1]! : "";
      const sub = args.slice(0, 3).join(" ");
      if (sub.startsWith("sch export netlist")) await writeFile(out, NETLIST);
      else if (sub.startsWith("sch erc")) await writeFile(out, JSON.stringify({ sheets: [{ violations: f.ercViolations ?? [{ type: "pin_not_connected", severity: "error", description: "Pin not connected", items: [{ description: "Pin 3 of U1", pos: { x: 1, y: 2 } }] }] }] }));
      else if (sub.startsWith("pcb drc")) {
        if (!f.drcFails) await writeFile(out, JSON.stringify({ violations: [], unconnected_items: [], schematic_parity: [] }));
      } else if (sub.startsWith("pcb render")) await writeFile(out, "png");
      else if (sub.startsWith("pcb export gerbers") && f.gerberFails) return { stdout: "", stderr: "plot failed", exitCode: 1 };
      await f.touch?.();
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  };
}
