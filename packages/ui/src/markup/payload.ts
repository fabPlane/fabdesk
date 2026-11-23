import type { Box } from "./strokes";

export type MarkupViewKind = "schematic" | "pcb" | "3d";

export type MarkupViewport = {
  x: number;
  y: number;
  w: number;
  h: number;
  units: "mm" | "sheet";
};

export type MarkupObjects = {
  refdes: string[];
  nets: string[];
};

export type MarkupContext = {
  view: MarkupViewKind;
  viewLabel: string;
  viewport?: MarkupViewport;
  marked?: Box;
  objects?: MarkupObjects;
  imageAttached: boolean;
};

const MAX_IDS = 24;

/** Views whose compositor can capture a canvas or image, not DOM-only lists. */
const MARKUP_CAPTURE_TABS = new Set([
  "schematic",
  "pcb",
  "placement",
  "cinema",
  "3d",
  "cad",
  "art",
]);

export function markupViewCapturable(tab: string, area?: string): boolean {
  if (area === "review" || area === "files" || area === "parts") return false;
  if (area === "outputs" && tab !== "3d") return false;
  return MARKUP_CAPTURE_TABS.has(tab);
}

export function markupViewKind(tab: string, area: string): MarkupViewKind {
  if (tab === "schematic") return "schematic";
  if (tab === "3d" || tab === "cad" || area === "mechanical") return "3d";
  return "pcb";
}

export function markupViewLabel(tab: string, area: string): string {
  if (area === "mechanical" || tab === "cad") return "CAD";
  if (tab === "3d") return "3D";
  if (tab === "cinema") return "Routing";
  if (tab === "placement") return "Placement";
  if (tab === "schematic") return "Schematic";
  if (tab === "pcb") return "PCB";
  return tab || "Board";
}

export function formatMarkupContext(ctx: MarkupContext): string {
  const lines = ["[markup]", `view: ${ctx.view}`, `surface: ${ctx.viewLabel}`];
  if (ctx.viewport) {
    lines.push(
      `viewport: ${fmt(ctx.viewport.x)}, ${fmt(ctx.viewport.y)}, ${fmt(ctx.viewport.w)} × ${fmt(ctx.viewport.h)} ${ctx.viewport.units}`,
    );
  }
  if (ctx.marked) {
    lines.push(`marked: ${fmt(ctx.marked.x)}, ${fmt(ctx.marked.y)}, ${fmt(ctx.marked.w)} × ${fmt(ctx.marked.h)}`);
  }
  const refdes = cap(ctx.objects?.refdes ?? []);
  const nets = cap(ctx.objects?.nets ?? []);
  if (refdes.length) lines.push(`refdes: ${refdes.join(", ")}`);
  if (nets.length) lines.push(`nets: ${nets.join(", ")}`);
  if (!ctx.imageAttached) {
    lines.push("note: marked view image was not attached; use this text context");
  }
  return lines.join("\n");
}

export function markupAttachment(path: string): { path: string; mime: "image/png"; role: "markup" } {
  return { path, mime: "image/png", role: "markup" };
}

function cap(ids: string[]): string[] {
  const unique = [...new Set(ids.filter(Boolean))];
  return unique.slice(0, MAX_IDS);
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const rounded = Math.round(n * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
}
