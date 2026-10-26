import { filledBoardRect, outlinePrimitives } from "./gerber";
import type { Primitive, ResolvedArtOptions } from "./types";

export function writeKicadPcb(o: ResolvedArtOptions, art: readonly Primitive[]): string {
  const graphics: string[] = [];
  let n = 0;
  const uuid = () => {
    n += 1;
    return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
  };
  for (const p of outlinePrimitives(o)) {
    if (p.kind === "line") graphics.push(grLine(p, "Edge.Cuts", uuid()));
  }
  if (o.fillCopper && !o.layers.includes("copper")) {
    for (const p of filledBoardRect(o)) graphics.push(primGraphic(p, "F.Cu", uuid(), true));
    for (const p of filledBoardRect(o)) graphics.push(primGraphic(p, "B.Cu", uuid(), true));
  }
  const layerFor = (layer: "silk" | "mask" | "copper"): string =>
    layer === "silk" ? "F.SilkS" : layer === "mask" ? "F.Mask" : "F.Cu";
  for (const layer of o.layers) {
    const name = layerFor(layer);
    for (const p of art) graphics.push(primGraphic(p, name, uuid(), p.kind !== "line"));
  }
  return `(kicad_pcb
	(version 20241229)
	(generator "fabplane")
	(generator_version "0.1")
	(general
		(thickness 1.6)
		(legacy_teardrops no)
	)
	(paper "A4")
	(title_block
		(title "board-art")
		(comment 1 "fabPlane silkscreen art")
	)
	(layers
		(0 "F.Cu" signal)
		(31 "B.Cu" signal)
		(36 "B.SilkS" user "B.Silkscreen")
		(37 "F.SilkS" user "F.Silkscreen")
		(38 "B.Mask" user)
		(39 "F.Mask" user)
		(44 "Edge.Cuts" user)
		(46 "B.CrtYd" user "B.Courtyard")
		(47 "F.CrtYd" user "F.Courtyard")
		(48 "B.Fab" user)
		(49 "F.Fab" user)
	)
	(setup
		(pad_to_mask_clearance 0)
		(allow_soldermask_bridges_in_footprints no)
	)
	(net 0 "")
${graphics.join("\n")}
)
`;
}

export function writeKicadPro(name = "board"): string {
  return JSON.stringify(
    {
      board: {
        "3dviewports": [],
        design_settings: {
          defaults: { board_outline_line_width: 0.15, silk_line_width: 0.15 },
        },
      },
      meta: { filename: `${name}.kicad_pro`, version: 3 },
      paper: "A4",
      text_variables: {},
    },
    null,
    2,
  );
}

function primGraphic(p: Primitive, layer: string, id: string, fill: boolean): string {
  if (p.kind === "circle") return grCircle(p, layer, id, fill);
  if (p.kind === "line") return grLine(p, layer, id);
  return grRect(p, layer, id, fill);
}

function grLine(p: Extract<Primitive, { kind: "line" }>, layer: string, id: string): string {
  return `\t(gr_line
		(start ${n(p.x1)} ${n(p.y1)})
		(end ${n(p.x2)} ${n(p.y2)})
		(stroke
			(width ${n(p.w)})
			(type default)
		)
		(layer "${layer}")
		(uuid "${id}")
	)`;
}

function grCircle(p: Extract<Primitive, { kind: "circle" }>, layer: string, id: string, fill: boolean): string {
  const r = p.d / 2;
  return `\t(gr_circle
		(center ${n(p.x)} ${n(p.y)})
		(end ${n(p.x + r)} ${n(p.y)})
		(stroke
			(width ${fill ? 0 : 0.05})
			(type default)
		)
		(fill ${fill ? "yes" : "no"})
		(layer "${layer}")
		(uuid "${id}")
	)`;
}

function grRect(p: Extract<Primitive, { kind: "rect" }>, layer: string, id: string, fill: boolean): string {
  return `\t(gr_rect
		(start ${n(p.x)} ${n(p.y)})
		(end ${n(p.x + p.w)} ${n(p.y + p.h)})
		(stroke
			(width 0)
			(type default)
		)
		(fill ${fill ? "yes" : "no"})
		(layer "${layer}")
		(uuid "${id}")
	)`;
}

function n(v: number): string {
  return (Math.round(v * 10000) / 10000).toString();
}
