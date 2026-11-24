import { readFile } from "node:fs/promises";
import { join } from "node:path";
import polygonClipping, { type MultiPolygon, type Pair, type Ring } from "polygon-clipping";
import { runKicadCli, type KicadCli } from "./cli";
import { assertFrontZonesFilled } from "./board-features";

const precise = (n: number) => Math.round(n * 1e6) / 1e6;
const key = ([x, y]: Pair) => `${x},${y}`;

function arcPoints(x: number, y: number, radius: number, from: number, sweep: number): Ring {
  // Include quadrant extrema for the exact board frame. Bound chord error to 1 µm.
  const maxAngle = Math.min(45, 2 * Math.acos(Math.max(-1, 1 - 0.001 / radius)) * 180 / Math.PI);
  if (radius <= 0 || !maxAngle || !sweep) throw new Error("Degenerate arc in KiCad DXF plot.");
  const stops = [from];
  for (let a = (Math.floor(from / 90) + 1) * 90; a < from + sweep; a += 90) stops.push(a);
  stops.push(from + sweep);
  const point = (angle: number): Pair => {
    const radians = angle * Math.PI / 180;
    return [precise(x + radius * Math.cos(radians)), precise(y + radius * Math.sin(radians))];
  };
  const path: Ring = [point(from)];
  for (let i = 1; i < stops.length; i++) {
    const start = stops[i - 1]!, delta = stops[i]! - start;
    const steps = Math.ceil(delta / maxAngle);
    for (let j = 1; j <= steps; j++) path.push(point(start + delta * j / steps));
  }
  return path;
}

/** Only the model-space ENTITIES section of KiCad's native mm DXF. Fail closed on other geometry. */
function contours(dxf: string, layer: "F.Cu" | "Edge.Cuts"): Ring[] {
  const fields = dxf.trim().split(/\r?\n/).map(line => line.trim());
  let start = -1;
  for (let i = 0; i + 3 < fields.length; i += 2) {
    if (fields[i] === "0" && fields[i + 1] === "SECTION" && fields[i + 2] === "2" && fields[i + 3] === "ENTITIES") {
      start = i + 4;
      break;
    }
  }
  if (start < 0) throw new Error(`Missing ${layer} plot entities.`);
  const chains: Ring[] = [], rings: Ring[] = [];
  for (let i = start; ; ) {
    if (fields[i] !== "0") throw new Error(`Incomplete ${layer} DXF plot.`);
    const type = fields[i + 1];
    if (type === "ENDSEC") break;
    i += 2;
    const attrs = new Map<string, string>();
    while (i + 1 < fields.length && fields[i] !== "0") {
      attrs.set(fields[i]!, fields[i + 1]!);
      i += 2;
    }
    const number = (field: string) => {
      const raw = attrs.get(field);
      const n = raw ? Number(raw) : NaN;
      if (!Number.isFinite(n)) throw new Error(`Invalid ${layer} ${type} coordinate.`);
      return n;
    };
    if (attrs.get("8") !== layer || (attrs.has("230") && number("230") !== 1)) {
      throw new Error(`Unexpected layer or orientation in ${layer} plot.`);
    }
    if (type !== "LINE" && type !== "CIRCLE" && type !== "ARC") {
      throw new Error(`Unsupported ${layer} DXF entity ${type}. The copper artwork was not exported.`);
    }
    const x = number("10"), y = number("20");
    if (type === "LINE") {
      const a: Pair = [precise(x), precise(y)], b: Pair = [precise(number("11")), precise(number("21"))];
      if (key(a) !== key(b)) chains.push([a, b]);
    } else {
      const from = type === "CIRCLE" ? 0 : number("50") % 360;
      const sweep = type === "CIRCLE" ? 360 : ((number("51") - from) % 360 + 360) % 360;
      const path = arcPoints(x, y, number("40"), from, sweep);
      if (type === "CIRCLE") rings.push(path);
      else chains.push(path);
    }
  }

  for (const ring of joinSegments(chains, layer)) rings.push(ring);
  if (!rings.length || rings.some(ring => ring.length < 4)) throw new Error(`No usable closed ${layer} artwork.`);
  return rings;
}

function joinSegments(chains: Ring[], layer: string): Ring[] {
  const rings: Ring[] = [];
  const ends = new Map<string, number[]>();
  for (const [i, line] of chains.entries()) {
    for (const end of [line[0]!, line.at(-1)!]) {
      const k = key(end), matches = ends.get(k) ?? [];
      matches.push(i);
      ends.set(k, matches);
    }
  }
  if ([...ends.values()].some(ids => ids.length !== 2)) throw new Error(`${layer} contains an open or branching contour. Repair the board before exporting.`);
  const seen = new Set<number>();
  for (const [i, line] of chains.entries()) {
    if (seen.has(i)) continue;
    const ring = [...line], first = key(ring[0]!);
    seen.add(i);
    let end = key(ring.at(-1)!);
    while (end !== first) {
      const next = ends.get(end)?.find(id => !seen.has(id));
      if (next === undefined) throw new Error(`Unclosed ${layer} contour.`);
      seen.add(next);
      const chain = chains[next]!;
      const ordered = key(chain[0]!) === end ? chain : [...chain].reverse();
      for (let j = 1; j < ordered.length; j++) ring.push(ordered[j]!);
      end = key(ring.at(-1)!);
    }
    rings.push(ring);
  }
  return rings;
}

/** Reject intersecting or self-crossing Edge.Cuts before computing a removal region. */
function validateEdges(rings: Ring[]) {
  const edges = rings.flatMap((ring, r) => ring.slice(1).map((b, i) => {
    const a = ring[i]!;
    return { a, b, r, i, last: ring.length - 2, left: Math.min(a[0], b[0]), right: Math.max(a[0], b[0]) };
  })).sort((a, b) => a.left - b.left);
  const side = (a: Pair, b: Pair, c: Pair) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
  for (let i = 0; i < edges.length; i++) {
    const a = edges[i]!;
    for (let j = i + 1; j < edges.length && edges[j]!.left <= a.right; j++) {
      const b = edges[j]!, gap = Math.abs(a.i - b.i);
      if (a.r === b.r && (gap === 1 || gap === a.last)) {
        // Neighbours can share their common endpoint, but may not double back along the same edge.
        const dot = (a.b[0] - a.a[0]) * (b.b[0] - b.a[0]) + (a.b[1] - a.a[1]) * (b.b[1] - b.a[1]);
        if (dot < 0 && side(a.a, a.b, b.a) === 0 && side(a.a, a.b, b.b) === 0) throw new Error("Edge.Cuts has overlapping segments.");
        continue;
      }
      if (Math.max(a.a[1], a.b[1]) < Math.min(b.a[1], b.b[1]) || Math.max(b.a[1], b.b[1]) < Math.min(a.a[1], a.b[1])) continue;
      if (side(a.a, a.b, b.a) * side(a.a, a.b, b.b) <= 0 && side(b.a, b.b, a.a) * side(b.a, b.b, a.b) <= 0) {
        throw new Error("Edge.Cuts contours cross or touch. Repair the board outline before exporting.");
      }
    }
  }
}

function filledRegion(rings: Ring[]): MultiPolygon {
  // KiCad --use-contours already unions copper. Even/odd parity preserves holes and nested islands.
  let result: MultiPolygon = [];
  for (let i = 0; i < rings.length; i += 512) result = polygonClipping.xor(result, ...rings.slice(i, i + 512).map(r => [r]));
  return result;
}

export function copperRemovalFromDxf(edgePlot: string, copperPlot: string) {
  const outlines = contours(edgePlot, "Edge.Cuts");
  validateEdges(outlines);
  const board = filledRegion(outlines), copper = filledRegion(contours(copperPlot, "F.Cu"));
  if (!polygonClipping.intersection(board, copper).length) throw new Error("No retained front copper inside the board outline.");
  const removal = polygonClipping.difference(board, copper);
  if (!removal.length) throw new Error("The entire front of the board is copper. There is nothing to remove.");
  let left = Infinity, right = -Infinity, bottom = Infinity, top = -Infinity;
  for (const ring of outlines) for (const [x, y] of ring) {
    left = Math.min(left, x); right = Math.max(right, x); bottom = Math.min(bottom, y); top = Math.max(top, y);
  }
  const widthMm = precise(right - left), heightMm = precise(top - bottom);
  const path = removal.flatMap(poly => poly.map(ring => ring.slice(0, -1).map(([x, y], i) =>
    `${i ? "L" : "M"}${precise(x - left)} ${precise(top - y)}`).join(" ") + " Z")).join(" ");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${widthMm}mm" height="${heightMm}mm" viewBox="0 0 ${widthMm} ${heightMm}">\n<title>Front copper to remove</title>\n<path fill="#000000" fill-rule="evenodd" stroke="none" d="${path}"/>\n</svg>\n`;
  return { svg, widthMm, heightMm };
}

export async function copperRemovalArtwork(cli: KicadCli, opts: { board: string; scratchDir: string; signal?: AbortSignal }) {
  assertFrontZonesFilled(await readFile(opts.board, "utf8"));
  const edge = join(opts.scratchDir, "edge.dxf"), copper = join(opts.scratchDir, "front-copper.dxf");
  const base = ["pcb", "export", "dxf", "--mode-single", "--output-units", "mm", "--drill-shape-opt", "0"];
  const options = opts.signal ? { signal: opts.signal } : {};
  // The outline is its centerline. --use-contours here would turn the line width into two borders.
  await runKicadCli(cli, [...base, "--layers", "Edge.Cuts", "-o", edge, opts.board], options);
  // Plot the reviewed board's saved fills. Refilling in the temporary project would use its default design rules.
  await runKicadCli(cli, [...base, "--use-contours", "--layers", "F.Cu", "-o", copper, opts.board], options);
  return copperRemovalFromDxf(await readFile(edge, "utf8"), await readFile(copper, "utf8"));
}
