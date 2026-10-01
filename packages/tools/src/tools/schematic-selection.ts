import { ToolError } from "../registry";
import type { NativeSchematicSnapshot } from "../services";

export type SchematicSelection = {
  references: string[];
  netNames: string[];
  objectIds: string[];
  kinds: string[];
  expand: "none" | "nets";
  limit: number | null;
};

/** Select solely by KiCad net item membership; geometry and label text do not establish nets. */
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

  const symbolIds = new Set(groups.symbols.map((s) => s.id));
  const netMembers = new Map(
    snapshot.nets.map((net) => [
      net.name,
      new Set(net.itemIds.filter((id) => allIds.has(id) && !symbolIds.has(id))),
    ]),
  );
  for (const pin of groups.pins) if (pin.net) netMembers.get(pin.net)?.add(pin.id);
  const selected = new Set(selection.objectIds);
  for (const symbol of snapshot.symbols)
    if (selection.references.includes(symbol.reference)) {
      selected.add(symbol.id);
      for (const pin of symbol.pins) selected.add(pin.id);
    }
  // Expand once from the original seeds, never by transitive geometric contact between nets.
  const seeds = new Set(selected);
  if (selection.expand === "nets")
    for (const symbol of snapshot.symbols)
      if (seeds.has(symbol.id)) symbol.pins.forEach((pin) => seeds.add(pin.id));
  for (const [name, members] of netMembers)
    if (
      selection.netNames.includes(name) ||
      (selection.expand === "nets" && [...members].some((id) => seeds.has(id)))
    )
      members.forEach((id) => selected.add(id));
  const filtered =
    selection.references.length + selection.netNames.length + selection.objectIds.length > 0;
  if (!filtered) allIds.forEach((id) => selected.add(id));
  const budget =
    selection.limit ?? Object.values(groups).reduce((total, items) => total + items.length, 0);
  let remaining = budget;
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
  const nets = matchedNets.slice(0, selection.limit ?? matchedNets.length);
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
      returned: budget - remaining,
      truncated: matched > budget || matchedNets.length > nets.length,
      counts,
    },
  };
}
