import { createHash } from "node:crypto";
import type { DesignSnapshot, FabCheckFinding, FabCheckSection } from "./types";

export function checkDesignConsistency(opts: {
  packageHash: string;
  previousHash?: string;
  design?: DesignSnapshot;
}): FabCheckSection {
  const findings: FabCheckFinding[] = [];
  const design = opts.design;
  if (!design) {
    return {
      id: "design",
      title: "Design vs export",
      verdict: "skip",
      summary: "No board snapshot was supplied, so export freshness was not compared.",
      findings: [],
    };
  }
  if (design.drc) {
    if (design.drc.stale)
      findings.push({
        id: "drc-stale",
        check: "design",
        severity: "warn",
        message: "The board DRC report is stale relative to the exported board.",
      });
    if (design.drc.errors > 0)
      findings.push({
        id: "drc-fail",
        check: "design",
        severity: "fail",
        message: `The board that produced this package still has ${design.drc.errors} DRC error(s).`,
      });
  } else {
    findings.push({
      id: "drc-missing",
      check: "design",
      severity: "warn",
      message: "No DRC report was available for the board that was exported.",
    });
  }
  if (opts.previousHash && opts.previousHash !== opts.packageHash)
    findings.push({
      id: "export-changed",
      check: "design",
      severity: "warn",
      message: "The fabrication files changed since the last saved check.",
    });
  const fails = findings.filter((f) => f.severity === "fail").length;
  return {
    id: "design",
    title: "Design vs export",
    verdict: fails ? "fail" : findings.length ? "warn" : "pass",
    summary: fails
      ? "The exported board still fails DRC."
      : findings.length
        ? "Export and design are related, with freshness notes."
        : "DRC on the exported board is clean and the package is current.",
    findings,
  };
}

export function hashPackage(files: ReadonlyArray<{ name: string; bytes: Uint8Array }>): string {
  const h = createHash("sha256");
  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name));
  for (const file of sorted) {
    h.update(file.name);
    h.update("\0");
    h.update(file.bytes);
  }
  return h.digest("hex");
}

/** Best-effort footprint list from a KiCad PCB, used when the caller did not pass parts. */
export function parseDesignParts(pcbText: string): DesignSnapshot["parts"] {
  const parts: NonNullable<DesignSnapshot["parts"]> = [];
  const blocks = pcbText.split(/\(footprint\s+"/);
  for (const block of blocks.slice(1)) {
    const libEnd = block.indexOf('"');
    const footprint = block.slice(0, libEnd);
    const rest = block.slice(libEnd);
    const at = /\(at\s+(-?[0-9.]+)\s+(-?[0-9.]+)(?:\s+(-?[0-9.]+))?/.exec(rest);
    const ref =
      /\(property\s+"Reference"\s+"([^"]+)"/.exec(rest)?.[1] ??
      /\(fp_text\s+reference\s+"([^"]+)"/.exec(rest)?.[1];
    const value =
      /\(property\s+"Value"\s+"([^"]+)"/.exec(rest)?.[1] ??
      /\(fp_text\s+value\s+"([^"]+)"/.exec(rest)?.[1] ??
      "";
    if (!ref || !at) continue;
    const layer = /\(layer\s+"([^"]+)"/.exec(rest)?.[1] ?? "F.Cu";
    const dnp = /\(attr\b[^)]*\bdnp\b/.test(rest) || /\(dnp\s+yes\)/.test(rest);
    parts.push({
      ref,
      value,
      footprint,
      x: Number(at[1]),
      y: Number(at[2]),
      rotationDeg: Number(at[3] ?? 0),
      side: /^B\./.test(layer) ? "bottom" : "top",
      dnp,
    });
  }
  return parts;
}

export function parseBoardOutline(pcbText: string): DesignSnapshot["outline"] {
  const xs: number[] = [];
  const ys: number[] = [];
  const add = (x: string | undefined, y: string | undefined) => {
    if (x === undefined || y === undefined) return;
    xs.push(Number(x));
    ys.push(Number(y));
  };
  const edge = (layer: string | undefined) => layer === "Edge.Cuts" || layer === "Edge_Cuts";
  const rect = /\(gr_rect\s+\(start\s+(-?[0-9.]+)\s+(-?[0-9.]+)\)\s+\(end\s+(-?[0-9.]+)\s+(-?[0-9.]+)\)[\s\S]*?\(layer\s+"([^"]+)"/g;
  for (const m of pcbText.matchAll(rect)) {
    if (!edge(m[5])) continue;
    add(m[1], m[2]);
    add(m[3], m[4]);
  }
  const line = /\(gr_line\s+\(start\s+(-?[0-9.]+)\s+(-?[0-9.]+)\)\s+\(end\s+(-?[0-9.]+)\s+(-?[0-9.]+)\)[\s\S]*?\(layer\s+"([^"]+)"/g;
  let lines = 0;
  for (const m of pcbText.matchAll(line)) {
    if (!edge(m[5])) continue;
    add(m[1], m[2]);
    add(m[3], m[4]);
    lines += 1;
  }
  if (!xs.length) return undefined;
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  return {
    minX,
    minY,
    maxX,
    maxY,
    widthMm: maxX - minX,
    heightMm: maxY - minY,
    closed: lines === 0 || lines >= 4,
  };
}

export function countCopperLayers(pcbText: string): number {
  const layers = /\(layers\s+([\s\S]*?)\)\s*\(setup/.exec(pcbText)?.[1] ?? "";
  const matches = layers.match(/\(Cu\s+"/g);
  if (matches?.length) return matches.length;
  return (pcbText.match(/\(type\s+signal\)/g) ?? []).length || 2;
}
