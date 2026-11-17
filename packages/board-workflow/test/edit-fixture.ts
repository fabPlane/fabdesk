/** A small project for edit tests: a board (KiCad 10.99 transform format) and one schematic sheet that agree with it. */
// ---- a small project: board (KiCad 10.99 transform format) and one schematic sheet that agree with it
export const fpT = (ref: string, x: number, y: number, pads: Array<[string, string, number, number]>, opts: { value?: string; box?: number[]; rot?: number; side?: string } = {}) => {
  const [bx0, by0, bx1, by1] = opts.box ?? [-1, -0.6, 1, 0.6];
  return `
	(footprint "Lib:${ref.replace(/\d+$/, "")}X"
		(layer "${opts.side ?? "F"}.Cu")
		(uuid "fp-${ref}")
		(transform
			(translate ${x} ${y})
			(rotate ${opts.rot ?? 0})
			(scale 1 1)
		)
		(property "Reference" "${ref}"
			(at 0 -1 ${opts.rot ?? 0})
			(layer "F.SilkS")
			(uuid "pr-${ref}")
		)
		(property "Value" "${opts.value ?? "100n"}"
			(at 0 1 ${opts.rot ?? 0})
			(layer "F.Fab")
			(uuid "pv-${ref}")
		)
		(fp_rect (start ${bx0} ${by0}) (end ${bx1} ${by1}) (layer "F.CrtYd") (uuid "cy-${ref}"))
		${pads.map(([n, net, px, py]) => `(pad "${n}" smd rect (at ${px} ${py} ${opts.rot ?? 0}) (size 0.6 0.6) (layers "F.Cu" "F.Paste") (net "${net}") (uuid "pad-${ref}-${n}"))`).join("\n\t\t")}
	)`;
};
export const seg = (x1: number, y1: number, x2: number, y2: number, net: string, layer = "F.Cu") =>
  `\n	(segment (start ${x1} ${y1}) (end ${x2} ${y2}) (width 0.2) (layer "${layer}") (net "${net}") (uuid "sg-${x1}-${y1}-${x2}-${y2}-${net}"))`;

export const BOARD = `(kicad_pcb (version 20261025) (generator "pcbnew") (generator_version "10.99")
	(layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
	(gr_rect (start 0 0) (end 60 40) (layer "Edge.Cuts"))
	${fpT("J1", 5, 5, [["1", "VIN", 0, 0], ["2", "GND", 1.5, 0]], { box: [-1, -1, 3, 1], value: "CONN" })}
	${fpT("U1", 30, 20, [["1", "VIN", -1, 0], ["2", "SIG", 1, 0], ["3", "GND", 0, 1]], { box: [-2, -2, 2, 2], value: "IC" })}
	${fpT("R1", 20, 10, [["1", "SIG", -0.5, 0], ["2", "SIG2", 0.5, 0]], { value: "10k" })}
	${fpT("R2", 20, 14, [["1", "SIG2", -0.5, 0], ["2", "GND", 0.5, 0]], { value: "1k" })}
	${fpT("C1", 40, 10, [["1", "VIN", -0.5, 0], ["2", "GND", 0.5, 0]])}
	${fpT("C2", 40, 14, [["1", "VIN", -0.5, 0], ["2", "GND", 0.5, 0]])}
	${fpT("C3", 40, 18, [["1", "VIN", -0.5, 0], ["2", "GND", 0.5, 0]])}
	${seg(19.5, 10, 10, 10, "SIG")}
	${seg(20.5, 10, 19.5, 14, "SIG2")}
	${seg(39.5, 18, 29, 20, "VIN")}
	${seg(40.5, 18, 40.5, 25, "GND")}
	(via (at 40.5 25) (size 0.5) (drill 0.3) (layers "F.Cu" "B.Cu") (net "GND") (uuid "via1"))
)`;
export const PRO = JSON.stringify({ net_settings: { classes: [{ name: "Default", track_width: 0.15, clearance: 0.13 }] }, board: { design_settings: { rules: { min_track_width: 0.1, min_clearance: 0.1 } } } });

const pinRows = (x: number, y: number) => ({ p1: [x, y - 3.81], p2: [x, y + 3.81] });
const sym = (ref: string, value: string, x: number, y: number, nets: [string, string], lib = "Device:C") => {
  const p = pinRows(x, y);
  const lab = (net: string, [px, py]: number[]) => `
	(global_label "${net}" (shape passive) (at ${px} ${py} 180) (effects (font (size 1 1))) (uuid "lb-${ref}-${net}")
		(property "Intersheetrefs" "\${INTERSHEET_REFS}" (at ${px} ${py} 0) (effects (font (size 1 1)) (hide yes))))`;
  return `
	(symbol (lib_id "${lib}") (at ${x} ${y} 0) (unit 1) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no) (uuid "sy-${ref}")
		(property "Reference" "${ref}" (at ${x + 2} ${y} 0) (effects (font (size 1 1))))
		(property "Value" "${value}" (at ${x + 2} ${y + 2} 0) (effects (font (size 1 1))))
		(property "Footprint" "Lib:${ref.replace(/\d+$/, "")}X" (at ${x} ${y} 0) (effects (font (size 1 1)) (hide yes)))
		(pin "1" (uuid "pn1-${ref}"))
		(pin "2" (uuid "pn2-${ref}"))
		(instances (project "t" (path "/root-uuid" (reference "${ref}") (unit 1)))))${lab(nets[0], p.p1!)}${lab(nets[1], p.p2!)}`;
};
const libSym = (id: string) => `
		(symbol "${id}"
			(symbol "${id.split(":")[1]}_1_1"
				(pin passive line (at 0 3.81 270) (length 2.54) (name "~" (effects (font (size 1 1)))) (number "1" (effects (font (size 1 1)))))
				(pin passive line (at 0 -3.81 90) (length 2.54) (name "~" (effects (font (size 1 1)))) (number "2" (effects (font (size 1 1)))))))`;
export const SHEET = `(kicad_sch (version 20250114) (generator "eeschema")
	(uuid "root-uuid")
	(lib_symbols${libSym("Device:C")}${libSym("Device:R")}
	)${sym("C1", "100n", 50, 50, ["VIN", "GND"])}${sym("C2", "100n", 70, 50, ["VIN", "GND"])}${sym("C3", "100n", 90, 50, ["VIN", "GND"])}${sym("R1", "10k", 110, 50, ["SIG", "SIG2"], "Device:R")}${sym("R2", "1k", 130, 50, ["SIG2", "GND"], "Device:R")}
)
`;

/** The same fixtures in KiCad's footprint-at spelling, including implicit zero rotations. */
export const atVariant = (text: string) => text.replace(/\(transform\s+\(translate ([-\d.]+) ([-\d.]+)\)\s+\(rotate ([-\d.]+)\)\s+\(scale 1 1\)\s*\)/g,
  (_m, x: string, y: string, r: string) => `(at ${x} ${y}${Number(r) ? " " + r : ""})`);
