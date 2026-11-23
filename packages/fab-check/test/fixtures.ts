import { writeGerberLayer } from "@fabdesk/board-art";
import type { DesignPart, PackageFile } from "../src/types";

export function gerber(
  name: string,
  fileFunction: string,
  primitives: Parameters<typeof writeGerberLayer>[0]["primitives"],
): PackageFile {
  return {
    name,
    bytes: new TextEncoder().encode(
      writeGerberLayer({ functionComment: name, fileFunction, primitives }),
    ),
  };
}

export function outline(w = 20, h = 12): PackageFile {
  return gerber("gerbers/board-Edge_Cuts.gbr", "Profile,NP", [
    { kind: "line", x1: 0, y1: 0, x2: w, y2: 0, w: 0.15 },
    { kind: "line", x1: w, y1: 0, x2: w, y2: h, w: 0.15 },
    { kind: "line", x1: w, y1: h, x2: 0, y2: h, w: 0.15 },
    { kind: "line", x1: 0, y1: h, x2: 0, y2: 0, w: 0.15 },
  ]);
}

export function openOutline(w = 20, h = 12): PackageFile {
  return gerber("gerbers/board-Edge_Cuts.gbr", "Profile,NP", [
    { kind: "line", x1: 0, y1: 0, x2: w, y2: 0, w: 0.15 },
    { kind: "line", x1: w, y1: 0, x2: w, y2: h, w: 0.15 },
    { kind: "line", x1: w, y1: h, x2: 0, y2: h, w: 0.15 },
  ]);
}

export function copper(name: string, fn: string, primitives: Parameters<typeof writeGerberLayer>[0]["primitives"]) {
  return gerber(name, fn, primitives);
}

export function drill(name = "gerbers/board.drl", hits: Array<{ x: number; y: number; d?: number }> = [{ x: 2, y: 2, d: 0.3 }]): PackageFile {
  const tools = new Map<number, string>();
  const lines = ["M48", "METRIC,TZ"];
  for (const hit of hits) {
    const d = hit.d ?? 0.3;
    if (!tools.has(d)) {
      const id = String(tools.size + 1).padStart(2, "0");
      tools.set(d, id);
      lines.push(`T${id}C${d.toFixed(3)}`);
    }
  }
  lines.push("%", "G90", "G05");
  let last = "";
  for (const hit of hits) {
    const id = tools.get(hit.d ?? 0.3)!;
    if (id !== last) {
      lines.push(`T${id}`);
      last = id;
    }
    lines.push(`X${hit.x.toFixed(3)}Y${hit.y.toFixed(3)}`);
  }
  lines.push("T00", "M30", "");
  return { name, bytes: new TextEncoder().encode(lines.join("\n")) };
}

export function csv(name: string, text: string): PackageFile {
  return { name, bytes: new TextEncoder().encode(text) };
}

const empty = (): Parameters<typeof writeGerberLayer>[0]["primitives"] => [];

/** A small 2-layer package with mask, silk, outline and drill. */
export function completePackage(opts: {
  copper?: Parameters<typeof writeGerberLayer>[0]["primitives"];
  silk?: Parameters<typeof writeGerberLayer>[0]["primitives"];
  mask?: Parameters<typeof writeGerberLayer>[0]["primitives"];
  omit?: Array<"drill" | "mask" | "silk" | "outline" | "paste">;
} = {}): PackageFile[] {
  const omit = new Set(opts.omit ?? []);
  const traces = opts.copper ?? [{ kind: "line" as const, x1: 2, y1: 2, x2: 10, y2: 2, w: 0.3 }];
  const files: PackageFile[] = [
    copper("gerbers/board-F_Cu.gbr", "Copper,L1,Top", traces),
    copper("gerbers/board-B_Cu.gbr", "Copper,L2,Bot", [{ kind: "line", x1: 2, y1: 8, x2: 10, y2: 8, w: 0.3 }]),
  ];
  if (!omit.has("mask")) {
    files.push(gerber("gerbers/board-F_Mask.gbr", "Soldermask,Top", opts.mask ?? empty()));
    files.push(gerber("gerbers/board-B_Mask.gbr", "Soldermask,Bot", empty()));
  }
  if (!omit.has("paste")) {
    files.push(gerber("gerbers/board-F_Paste.gbr", "Paste,Top", empty()));
    files.push(gerber("gerbers/board-B_Paste.gbr", "Paste,Bot", empty()));
  }
  if (!omit.has("silk"))
    files.push(gerber("gerbers/board-F_Silkscreen.gbr", "Legend,Top", opts.silk ?? empty()));
  if (!omit.has("outline")) files.push(outline());
  if (!omit.has("drill")) files.push(drill());
  files.push(
    csv(
      "bom.csv",
      "Reference,Value,Footprint\nR1,10k,R_0805\nC1,100nF,C_0805\n",
    ),
    csv(
      "positions.csv",
      "Ref,Val,Package,PosX,PosY,Rot,Side\nR1,10k,R_0805,5.000,4.000,0.000,top\nC1,100nF,C_0805,8.000,4.000,0.000,top\n",
    ),
  );
  return files;
}

export const sampleParts: DesignPart[] = [
  { ref: "R1", value: "10k", footprint: "R_0805", x: 5, y: 4, rotationDeg: 0, side: "top", dnp: false },
  { ref: "C1", value: "100nF", footprint: "C_0805", x: 8, y: 4, rotationDeg: 0, side: "top", dnp: false },
];
