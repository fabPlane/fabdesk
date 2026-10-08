import { childNamed, parseAt, propertyValue, quoted, topLevelBlocks } from "./sexpr";
import { emptySnapshot, type BoardSnapshot, type ComponentSnapshot, type Point } from "./types";

function symbolRef(body: string): string | undefined {
  return propertyValue(body, "Reference");
}

/**
 * Parse a `.kicad_sch` into schematic-space component positions and wire endpoints.
 * Net names come from labels when present; full connectivity still prefers a netlist.
 */
export function snapshotFromKicadSch(text: string): BoardSnapshot {
  const snapshot = emptySnapshot();
  const wires: Point[] = [];

  for (const block of topLevelBlocks(text, "symbol")) {
    const ref = symbolRef(block.body);
    if (!ref || ref.startsWith("#")) continue;
    const at = childNamed(block.body, "at");
    const place = at ? parseAt(at.body) : parseAt(block.body);
    const value = propertyValue(block.body, "Value");
    const lib = childNamed(block.body, "lib_id");
    const libId = lib ? quoted(lib.body) : undefined;
    const component: ComponentSnapshot = {
      ref,
      ...(value ? { value } : {}),
      ...(libId ? { libId } : {}),
      ...(place ? { schX: place.x, schY: place.y, schRotation: place.rotation } : {}),
    };
    snapshot.components.push(component);
  }

  for (const block of topLevelBlocks(text, "wire")) {
    for (const pt of block.body.matchAll(/\(xy\s+(-?[\d.]+)\s+(-?[\d.]+)\)/g)) {
      if (pt[1] && pt[2]) wires.push({ x: Number(pt[1]), y: Number(pt[2]) });
    }
  }
  for (let i = 0; i + 1 < wires.length; i += 2) {
    const start = wires[i];
    const end = wires[i + 1];
    if (!start || !end) continue;
    snapshot.tracks.push({
      id: `sch:${start.x},${start.y}-${end.x},${end.y}`,
      start,
      end,
      width: 0,
      layer: "schematic",
    });
  }

  const nets = new Map<string, Set<string>>();
  for (const kind of ["label", "global_label", "hierarchical_label"] as const) {
    for (const block of topLevelBlocks(text, kind)) {
      const name = quoted(block.body);
      if (!name) continue;
      if (!nets.has(name)) nets.set(name, new Set());
    }
  }
  snapshot.nets = [...nets.keys()].sort().map((name) => ({ name, nodes: [] }));
  return snapshot;
}
