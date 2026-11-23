/** Surgical KiCad .kicad_pcb / .kicad_pro edits for a material stackup. */
import {
  childBlocks,
  childNamed,
  parseAt,
  quoted,
  rootChildren,
  unquote,
} from "@fabdesk/board-diff";
import type { PedestalPad, RectMm } from "@fabdesk/protocol";
import { copperLayerNames } from "./presets";
import type { MaterialApplyPlan, StackupLayer } from "./types";

const STANDARD_USER_LAYERS: Array<[number, string, string]> = [
  [36, "B.SilkS", "B.Silkscreen"],
  [37, "F.SilkS", "F.Silkscreen"],
  [38, "B.Mask", ""],
  [39, "F.Mask", ""],
  [44, "Edge.Cuts", ""],
  [46, "B.CrtYd", "B.Courtyard"],
  [47, "F.CrtYd", "F.Courtyard"],
  [48, "B.Fab", ""],
  [49, "F.Fab", ""],
];

export function copperLayerCountFromPcb(text: string): number {
  const layers = rootChildren(text).find((b) => b.name === "layers");
  if (!layers) return 0;
  return [...layers.body.matchAll(/\(\d+\s+"(?:F|B|In\d+)\.Cu"/g)].length;
}

export function readBoardThicknessMm(text: string): number | undefined {
  const general = rootChildren(text).find((b) => b.name === "general");
  const t = general ? Number(/\(thickness\s+(-?[\d.]+)\)/.exec(general.body)?.[1]) : Number.NaN;
  return Number.isFinite(t) ? t : undefined;
}

export function readStackupSummary(text: string): Array<{ name: string; type: string; material?: string; thickness?: number; er?: number }> {
  const setup = rootChildren(text).find((b) => b.name === "setup");
  if (!setup) return [];
  const stackup = childNamed(setup.body, "stackup");
  if (!stackup) return [];
  return childBlocks(stackup.body)
    .filter((b) => b.name === "layer")
    .map((b) => {
      const name = quoted(b.body) ?? "";
      const type = quoted(childNamed(b.body, "type")?.body ?? "") ?? unquote((/\(type\s+([^\s)]+)/.exec(b.body)?.[1] ?? "").replace(/^"|"$/g, ""));
      const material = quoted(childNamed(b.body, "material")?.body ?? "");
      const thickness = Number(childNamed(b.body, "thickness")?.body.match(/-?[\d.]+/)?.[0]);
      const er = Number(childNamed(b.body, "epsilon_r")?.body.match(/-?[\d.]+/)?.[0]);
      return {
        name,
        type,
        ...(material ? { material } : {}),
        ...(Number.isFinite(thickness) ? { thickness } : {}),
        ...(Number.isFinite(er) ? { er } : {}),
      };
    });
}

function quote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function layerLine(l: StackupLayer): string {
  const parts = [`(layer ${quote(l.name)}`];
  const type =
    l.kind === "copper"
      ? "copper"
      : l.kind === "soldermask"
        ? l.name.startsWith("F.")
          ? "Top Solder Mask"
          : "Bottom Solder Mask"
        : l.kind === "silkscreen"
          ? l.name.startsWith("F.")
            ? "Top Silk Screen"
            : "Bottom Silk Screen"
          : l.kind === "paste"
            ? l.name.startsWith("F.")
              ? "Top Solder Paste"
              : "Bottom Solder Paste"
            : l.kind === "coverlay"
              ? "core"
              : l.dielectric === "prepreg"
                ? "prepreg"
                : l.kind === "metal_base"
                  ? "core"
                  : "core";
  parts.push(`(type ${/[A-Z ]/.test(type) ? quote(type) : type})`);
  if (l.thicknessMm) parts.push(`(thickness ${l.thicknessMm})`);
  if (l.material) parts.push(`(material ${quote(l.material)})`);
  if (l.er !== undefined) parts.push(`(epsilon_r ${l.er})`);
  if (l.tand !== undefined) parts.push(`(loss_tangent ${l.tand})`);
  if (l.color) parts.push(`(color ${quote(l.color)})`);
  return `\t\t${parts.join(" ")})`;
}

function stackupBlock(plan: MaterialApplyPlan): string {
  const lines = ["\t(stackup"];
  for (const l of plan.stackup) lines.push(layerLine(l));
  lines.push(`\t\t(copper_finish ${quote(plan.appearance.finish)})`);
  lines.push("\t\t(dielectric_constraints no)");
  lines.push("\t)");
  return lines.join("\n");
}

function layersBlock(plan: MaterialApplyPlan): string {
  const copper = copperLayerNames(plan.copperLayers);
  const lines = ["\t(layers"];
  copper.forEach((name, i) => {
    const id = name === "F.Cu" ? 0 : name === "B.Cu" ? 31 : i;
    lines.push(`\t\t(${id} ${quote(name)} signal)`);
  });
  for (const [id, name, alias] of STANDARD_USER_LAYERS) {
    lines.push(`\t\t(${id} ${quote(name)} user${alias ? ` ${quote(alias)}` : ""})`);
  }
  plan.userLayers.forEach((u, i) => {
    lines.push(`\t\t(${50 + i} ${quote(u.name)} user ${quote(u.purpose)})`);
  });
  lines.push("\t)");
  return lines.join("\n");
}

function replaceRootChild(text: string, name: string, next: string): string {
  const rootStart = text.indexOf("(");
  const children = rootChildren(text);
  const found = children.find((b) => b.name === name);
  if (!found) {
    const layers = children.find((b) => b.name === "layers");
    const insertAt =
      layers !== undefined
        ? rootStart + layers.end
        : children[0]
          ? rootStart + children[0].end
          : text.length;
    return `${text.slice(0, insertAt)}\n${next}${text.slice(insertAt)}`;
  }
  return `${text.slice(0, rootStart + found.start)}${next}${text.slice(rootStart + found.end)}`;
}

function replaceSetupStackup(setupBody: string, stackup: string): string {
  const existing = childNamed(setupBody, "stackup");
  if (!existing) {
    const inner = setupBody.startsWith("(setup") ? setupBody.slice(0, -1) : setupBody;
    return `${inner}\n${stackup}\n)`;
  }
  return `${setupBody.slice(0, existing.start)}${stackup.trim()}${setupBody.slice(existing.end)}`;
}

export function applyStackupToPcb(text: string, plan: MaterialApplyPlan): string {
  let next = text.includes("(kicad_pcb") ? text : `(kicad_pcb\n\t(version 20241229)\n\t(generator "fabdesk")\n)`;
  const general = rootChildren(next).find((b) => b.name === "general");
  if (general) {
    const replaced = general.body.replace(/\(thickness\s+-?[\d.]+\)/, `(thickness ${plan.thicknessMm})`);
    const withThickness = /\(thickness\s+/.test(replaced)
      ? replaced
      : replaced.replace(/^\(general/, `(general\n\t\t(thickness ${plan.thicknessMm})`);
    next = replaceRootChild(next, "general", withThickness);
  } else {
    next = replaceRootChild(next, "version", `\t(version 20241229)\n\t(general\n\t\t(thickness ${plan.thicknessMm})\n\t)`);
  }
  next = replaceRootChild(next, "layers", layersBlock(plan));
  const setup = rootChildren(next).find((b) => b.name === "setup");
  if (setup) {
    next = replaceRootChild(next, "setup", replaceSetupStackup(setup.body, stackupBlock(plan)));
  } else {
    next = replaceRootChild(next, "layers", `${layersBlock(plan)}\n\t(setup\n${stackupBlock(plan)}\n\t)`);
  }
  return next;
}

export function applyRulesToPro(proText: string | undefined, plan: MaterialApplyPlan): string {
  const base = proText?.trim() ? JSON.parse(proText) as Record<string, unknown> : { board: { design_settings: {} } };
  const board = (typeof base["board"] === "object" && base["board"] ? base["board"] : {}) as Record<string, unknown>;
  const settings = (typeof board["design_settings"] === "object" && board["design_settings"] ? board["design_settings"] : {}) as Record<string, unknown>;
  const rules = (typeof settings["rules"] === "object" && settings["rules"] ? settings["rules"] : {}) as Record<string, unknown>;
  const r = plan.rules;
  if (r.clearanceMm !== undefined) rules["min_clearance"] = r.clearanceMm;
  if (r.traceWidthMm !== undefined) rules["min_track_width"] = r.traceWidthMm;
  if (r.viaDiameterMm !== undefined) rules["min_via_diameter"] = r.viaDiameterMm;
  if (r.viaDrillMm !== undefined) rules["min_via_drill"] = r.viaDrillMm;
  if (r.annularRingMm !== undefined) rules["min_annular_rings"] = r.annularRingMm;
  settings["rules"] = rules;
  board["design_settings"] = settings;
  base["board"] = board;
  return `${JSON.stringify(base, null, 2)}\n`;
}

export type ExtractedPad = {
  ref: string;
  pad: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  drill?: number;
  layers: string[];
  net?: string;
  pedestal: boolean;
};

export type ExtractedVia = { id: string; x: number; y: number; net?: string; drill: number; diameter: number };
export type ExtractedTrack = { net?: string; width: number; layer: string; x1: number; y1: number; x2: number; y2: number };
export type ExtractedFootprint = { ref: string; layer: string; x: number; y: number };

export function extractBoardGeometry(text: string): {
  pads: ExtractedPad[];
  vias: ExtractedVia[];
  tracks: ExtractedTrack[];
  footprints: ExtractedFootprint[];
  keepouts: Array<{ name: string; points: Array<{ x: number; y: number }> }>;
} {
  const pads: ExtractedPad[] = [];
  const vias: ExtractedVia[] = [];
  const tracks: ExtractedTrack[] = [];
  const footprints: ExtractedFootprint[] = [];
  const keepouts: Array<{ name: string; points: Array<{ x: number; y: number }> }> = [];
  for (const fp of rootChildren(text).filter((b) => b.name === "footprint")) {
    const ref =
      /\(property\s+"Reference"\s+"((?:[^"\\]|\\.)*)"/.exec(fp.body)?.[1]?.replace(/\\(.)/g, "$1") ?? "?";
    const layer = quoted(childNamed(fp.body, "layer")?.body ?? "") ?? "F.Cu";
    const at = parseAt(fp.body) ?? { x: 0, y: 0, rotation: 0 };
    footprints.push({ ref, layer, x: at.x, y: at.y });
    for (const pad of childBlocks(fp.body).filter((b) => b.name === "pad")) {
      const head = /^\(pad\s+"((?:[^"\\]|\\.)*)"\s+(\S+)\s+(\S+)/.exec(pad.body);
      const padAt = parseAt(pad.body) ?? { x: 0, y: 0, rotation: 0 };
      const size = childNamed(pad.body, "size")?.body.match(/-?[\d.]+/g);
      const drill = Number(childNamed(pad.body, "drill")?.body.match(/-?[\d.]+/)?.[0]);
      const layers = [...(childNamed(pad.body, "layers")?.body.matchAll(/"((?:[^"\\]|\\.)*)"/g) ?? [])].map((m) => unquote(m[1]!));
      const pedestal =
        /FABDESK_PEDESTAL|pedestal/i.test(pad.body) || /"PEDAL"|"PEDESTAL"/i.test(pad.body);
      const net = quoted(childNamed(pad.body, "net")?.body ?? "");
      pads.push({
        ref,
        pad: head?.[1] ?? "?",
        type: head?.[2] ?? "",
        x: at.x + padAt.x,
        y: at.y + padAt.y,
        width: size?.[0] !== undefined ? Number(size[0]) : 0,
        height: size?.[1] !== undefined ? Number(size[1]) : 0,
        ...(Number.isFinite(drill) ? { drill } : {}),
        layers,
        ...(net ? { net } : {}),
        pedestal,
      });
    }
  }
  for (const via of rootChildren(text).filter((b) => b.name === "via")) {
    const at = parseAt(via.body) ?? { x: 0, y: 0, rotation: 0 };
    const net = quoted(childNamed(via.body, "net")?.body ?? "");
    vias.push({
      id: quoted(childNamed(via.body, "uuid")?.body ?? "") ?? `${at.x},${at.y}`,
      x: at.x,
      y: at.y,
      drill: Number(childNamed(via.body, "drill")?.body.match(/-?[\d.]+/)?.[0] ?? 0.3),
      diameter: Number(childNamed(via.body, "size")?.body.match(/-?[\d.]+/)?.[0] ?? 0.6),
      ...(net ? { net } : {}),
    });
  }
  for (const seg of rootChildren(text).filter((b) => b.name === "segment")) {
    const start = childNamed(seg.body, "start")?.body.match(/-?[\d.]+/g);
    const end = childNamed(seg.body, "end")?.body.match(/-?[\d.]+/g);
    const net = quoted(childNamed(seg.body, "net")?.body ?? "");
    tracks.push({
      width: Number(childNamed(seg.body, "width")?.body.match(/-?[\d.]+/)?.[0] ?? 0),
      layer: quoted(childNamed(seg.body, "layer")?.body ?? "") ?? "F.Cu",
      x1: Number(start?.[0] ?? 0),
      y1: Number(start?.[1] ?? 0),
      x2: Number(end?.[0] ?? 0),
      y2: Number(end?.[1] ?? 0),
      ...(net ? { net } : {}),
    });
  }
  for (const zone of rootChildren(text).filter((b) => b.name === "zone")) {
    const keepout = childNamed(zone.body, "keepout");
    const name = quoted(childNamed(zone.body, "name")?.body ?? "") ?? quoted(childNamed(zone.body, "net_name")?.body ?? "") ?? "";
    if (!keepout && !/bend/i.test(name)) continue;
    const pts = [...zone.body.matchAll(/\(xy\s+(-?[\d.]+)\s+(-?[\d.]+)\)/g)].map((m) => ({
      x: Number(m[1]),
      y: Number(m[2]),
    }));
    keepouts.push({ name: name || "keepout", points: pts });
  }
  return { pads, vias, tracks, footprints, keepouts };
}

export function pointInRect(x: number, y: number, r: RectMm): boolean {
  const x1 = Math.min(r.x1, r.x2);
  const x2 = Math.max(r.x1, r.x2);
  const y1 = Math.min(r.y1, r.y2);
  const y2 = Math.max(r.y1, r.y2);
  return x >= x1 && x <= x2 && y >= y1 && y <= y2;
}

export function pointInPolygon(x: number, y: number, pts: Array<{ x: number; y: number }>): boolean {
  if (pts.length < 3) return false;
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i]!;
    const b = pts[j]!;
    const hit = a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y || 1) + a.x;
    if (hit) inside = !inside;
  }
  return inside;
}

export function isPedestal(pad: ExtractedPad, listed: readonly PedestalPad[]): boolean {
  if (pad.pedestal) return true;
  return listed.some((p) => p.ref === pad.ref && p.pad === pad.pad);
}
