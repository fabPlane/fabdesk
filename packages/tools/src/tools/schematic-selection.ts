import { ToolError } from "../registry";
import type { NativeSchematicSnapshot, SchematicPoint } from "../services";

export type SchematicSelection = {
  references: string[];
  netNames: string[];
  objectIds: string[];
  kinds: string[];
  expand: "none" | "nets";
  limit: number;
};

const pointOnWire = (p: SchematicPoint, w: NativeSchematicSnapshot["wires"][number]) => {
  const dx = w.end.x - w.start.x,
    dy = w.end.y - w.start.y;
  return (
    Math.abs((p.x - w.start.x) * dy - (p.y - w.start.y) * dx) < 1e-7 &&
    p.x >= Math.min(w.start.x, w.end.x) - 1e-7 &&
    p.x <= Math.max(w.start.x, w.end.x) + 1e-7 &&
    p.y >= Math.min(w.start.y, w.end.y) - 1e-7 &&
    p.y <= Math.max(w.start.y, w.end.y) + 1e-7
  );
};

/** Selector union, followed by optional one-step electrical net expansion and kind filtering.
 * Geometry fills gaps in IPC net item membership. Wire interiors only meet at an explicit
 * junction or an endpoint: crossing lines alone never imply connectivity.
 */
export function selectSchematic(snapshot: NativeSchematicSnapshot, selection: SchematicSelection) {
  const groups = {
    symbols: snapshot.symbols,
    pins: snapshot.symbols.flatMap((s) => s.pins),
    wires: snapshot.wires,
    labels: [...snapshot.localLabels, ...snapshot.globalLabels],
    junctions: snapshot.junctions,
    noConnects: snapshot.noConnects,
    texts: snapshot.texts,
  };
  const allIds = new Set(Object.values(groups).flatMap((g) => g.map((o) => o.id)));
  for (const ref of selection.references)
    if (!snapshot.symbols.some((s) => s.reference === ref))
      throw new ToolError(
        `references: unknown component ${ref} on selected sheet; expected an inspected reference`,
        "invalid_args",
      );
  for (const id of selection.objectIds)
    if (!allIds.has(id))
      throw new ToolError(
        `objectIds: unknown object ${id} on selected sheet; expected an inspected ID`,
        "invalid_args",
      );
  for (const name of selection.netNames)
    if (!snapshot.nets.some((n) => n.name === name))
      throw new ToolError(
        `netNames: unknown net ${name}; expected an exact inspected net name`,
        "invalid_args",
      );

  // Undirected physical graph: wire endpoints/pins/labels/junctions are anchors.
  const adjacent = new Map<string, Set<string>>();
  const connect = (a: string, b: string) => {
    if (a === b) return;
    if (!adjacent.has(a)) adjacent.set(a, new Set());
    if (!adjacent.has(b)) adjacent.set(b, new Set());
    adjacent.get(a)!.add(b);
    adjacent.get(b)!.add(a);
  };
  if (selection.expand === "nets" || selection.netNames.length) {
    const anchors = [...groups.pins, ...groups.labels, ...groups.junctions, ...groups.noConnects];
    for (const anchor of anchors)
      for (const wire of snapshot.wires)
        if (pointOnWire(anchor.position, wire)) connect(anchor.id, wire.id);
    for (const [i, wire] of snapshot.wires.entries())
      for (const other of snapshot.wires.slice(i + 1))
        if (
          pointOnWire(wire.start, other) ||
          pointOnWire(wire.end, other) ||
          pointOnWire(other.start, wire) ||
          pointOnWire(other.end, wire)
        )
          connect(wire.id, other.id);
    const at = new Map<string, string[]>();
    for (const a of anchors) {
      const key = `${a.position.x},${a.position.y}`;
      for (const id of at.get(key) ?? []) connect(id, a.id);
      at.set(key, [...(at.get(key) ?? []), a.id]);
    }
    for (const net of snapshot.nets) {
      const ids = [
        ...net.itemIds,
        ...groups.pins.filter((p) => p.net === net.name).map((p) => p.id),
        ...groups.labels
          .filter((l) => l.text === net.name || `/${l.text}` === net.name)
          .map((l) => l.id),
      ].filter((id) => allIds.has(id));
      for (const id of ids.slice(1)) connect(ids[0]!, id);
    }
  }
  const closure = (seed: Iterable<string>) => {
    const ids = new Set(seed),
      queue = [...ids];
    for (let i = 0; i < queue.length; i++)
      for (const id of adjacent.get(queue[i]!) ?? [])
        if (!ids.has(id)) {
          ids.add(id);
          queue.push(id);
        }
    return ids;
  };
  const selected = new Set(selection.objectIds);
  for (const s of snapshot.symbols)
    if (selection.references.includes(s.reference)) {
      selected.add(s.id);
      for (const p of s.pins) selected.add(p.id);
    }
  for (const net of snapshot.nets)
    if (selection.netNames.includes(net.name)) {
      for (const id of net.itemIds) if (allIds.has(id)) selected.add(id);
      for (const p of groups.pins) if (p.net === net.name) selected.add(p.id);
      for (const l of groups.labels)
        if (l.text === net.name || `/${l.text}` === net.name) selected.add(l.id);
    }
  // Net selectors always include their physical objects. Expansion adds nets of reference/ID seeds.
  const netSeeds = new Set<string>();
  for (const net of snapshot.nets.filter((n) => selection.netNames.includes(n.name))) {
    net.itemIds.forEach((id) => netSeeds.add(id));
    groups.pins.filter((p) => p.net === net.name).forEach((p) => netSeeds.add(p.id));
    groups.labels
      .filter((l) => l.text === net.name || `/${l.text}` === net.name)
      .forEach((l) => netSeeds.add(l.id));
  }
  for (const id of closure(netSeeds)) if (allIds.has(id)) selected.add(id);
  if (selection.expand === "nets") {
    for (const s of snapshot.symbols)
      if (selected.has(s.id)) s.pins.forEach((p) => selected.add(p.id));
    for (const id of closure(selected)) selected.add(id);
  }
  const filtered =
    selection.references.length + selection.netNames.length + selection.objectIds.length > 0;
  if (!filtered) allIds.forEach((id) => selected.add(id));
  let remaining = selection.limit;
  const counts: Record<string, { matched: number; returned: number }> = {};
  const keep = (kind: string, id: string) => selection.kinds.includes(kind) && selected.has(id);
  const bound = <T>(kind: string, objects: T[]) => {
    const returned = objects.slice(0, remaining);
    remaining -= returned.length;
    counts[kind] = { matched: objects.length, returned: returned.length };
    return returned;
  };
  // Symbols serve as pin containers even if the caller requested only pins.
  const matchedSymbols = snapshot.symbols.filter(
    (s) => keep("symbols", s.id) || s.pins.some((p) => keep("pins", p.id)),
  );
  const symbols = bound("symbols", matchedSymbols).map((s) => ({
    ...s,
    pins: bound(
      `pins:${s.id}`,
      s.pins.filter((p) => keep("pins", p.id)),
    ),
  }));
  const wires = bound(
    "wires",
    snapshot.wires.filter((w) => keep("wires", w.id)),
  );
  const localLabels = bound(
    "localLabels",
    snapshot.localLabels.filter((l) => keep("labels", l.id)),
  );
  const globalLabels = bound(
    "globalLabels",
    snapshot.globalLabels.filter((l) => keep("labels", l.id)),
  );
  const junctions = bound(
    "junctions",
    snapshot.junctions.filter((j) => keep("junctions", j.id)),
  );
  const noConnects = bound(
    "noConnects",
    snapshot.noConnects.filter((n) => keep("noConnects", n.id)),
  );
  const texts = bound(
    "texts",
    snapshot.texts.filter((t) => keep("texts", t.id)),
  );
  const matched =
    matchedSymbols.length +
    matchedSymbols.reduce((n, s) => n + s.pins.filter((p) => keep("pins", p.id)).length, 0) +
    Object.entries(counts)
      .filter(([k]) => k !== "symbols" && !k.startsWith("pins:"))
      .reduce((n, [, c]) => n + c.matched, 0);
  const returnedIds = new Set([
    ...symbols.flatMap((s) => [s.id, ...s.pins.map((p) => p.id)]),
    ...wires.map((o) => o.id),
    ...localLabels.map((o) => o.id),
    ...globalLabels.map((o) => o.id),
    ...junctions.map((o) => o.id),
    ...noConnects.map((o) => o.id),
    ...texts.map((o) => o.id),
  ]);
  const matchedNets = snapshot.nets
    .filter(
      (n) =>
        !filtered ||
        selection.netNames.includes(n.name) ||
        n.itemIds.some((id) => returnedIds.has(id)) ||
        symbols.some((s) => s.pins.some((p) => p.net === n.name)),
    )
    .map((n) => ({ ...n, itemIds: n.itemIds.filter((id) => returnedIds.has(id)) }));
  const nets = matchedNets.slice(0, selection.limit);
  counts.nets = { matched: matchedNets.length, returned: nets.length };
  return {
    symbols,
    wires,
    localLabels,
    globalLabels,
    junctions,
    noConnects,
    texts,
    nets,
    selection: {
      ...selection,
      composition: "union",
      netScope: "selected-sheet objects; project net names",
      matched,
      returned: selection.limit - remaining,
      truncated: matched > selection.limit || matchedNets.length > nets.length,
      counts,
    },
  };
}
