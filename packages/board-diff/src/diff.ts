import {
  nodeKey,
  type BoardDiff,
  type BoardSnapshot,
  type ComponentChange,
  type ComponentChangeReason,
  type DiffOptions,
  type NetChange,
  type NetNode,
  type PadSnapshot,
  type ViaChange,
  type ViaChangeReason,
  type ViaSnapshot,
  type ZoneChange,
  type ZoneChangeReason,
  type ZoneSnapshot,
} from "./types";

const VIA_MOVE_RADIUS_MM = 5;
const VIA_EPS_MM = 0.001;
const PAD_TOL_MM = 0.001;

function nearlyEqual(a: number | undefined, b: number | undefined, tol: number): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return Math.abs(a - b) <= tol;
}

function nodeSet(nodes: NetNode[]): Set<string> {
  return new Set(nodes.map(nodeKey));
}

function hasPcbPlacement(component: { x?: number; y?: number }): boolean {
  return component.x !== undefined && component.y !== undefined;
}

function padsGeometryChanged(before?: PadSnapshot[], after?: PadSnapshot[]): boolean {
  const left = before ?? [];
  const right = after ?? [];
  if (left.length !== right.length) return true;
  // Connectors often repeat an electrical pad number (e.g. two MP anchors).
  // Preserve multiplicity instead of collapsing them into one Map entry.
  const remaining = [...left];
  for (const pad of right) {
    const index = remaining.findIndex(prev => prev.pin === pad.pin && (prev.shape ?? "") === (pad.shape ?? "") && nearlyEqual(prev.width, pad.width, PAD_TOL_MM) && nearlyEqual(prev.height, pad.height, PAD_TOL_MM) && nearlyEqual(prev.drill, pad.drill, PAD_TOL_MM));
    if (index === -1) return true;
    remaining.splice(index, 1);
  }
  return false;
}

function zoneSlot(zone: ZoneSnapshot): string {
  return `${zone.net ?? ""}|${[...zone.layers].sort().join(",")}`;
}

function matchVias(older: ViaSnapshot[], newer: ViaSnapshot[]): {
  added: ViaSnapshot[];
  removed: ViaSnapshot[];
  changed: ViaChange[];
  unchanged: number;
} {
  const unmatched = [...newer];
  const leftovers: ViaSnapshot[] = [];
  let unchanged = 0;
  for (const old of older) {
    const idx = unmatched.findIndex((v) => v.id === old.id);
    if (idx >= 0) {
      unmatched.splice(idx, 1);
      unchanged += 1;
    } else leftovers.push(old);
  }

  const take = (pick: (v: ViaSnapshot) => boolean, score: (v: ViaSnapshot) => number): ViaSnapshot | undefined => {
    let best: ViaSnapshot | undefined;
    let bestIdx = -1;
    for (let i = 0; i < unmatched.length; i++) {
      const v = unmatched[i]!;
      if (!pick(v)) continue;
      if (!best || score(v) < score(best)) {
        best = v;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) unmatched.splice(bestIdx, 1);
    return best;
  };

  const changed: ViaChange[] = [];
  const removed: ViaSnapshot[] = [];
  for (const old of leftovers) {
    const dist = (v: ViaSnapshot) => Math.hypot(v.x - old.x, v.y - old.y);
    const match =
      take((v) => dist(v) < VIA_EPS_MM, dist) ??
      take((v) => (v.net ?? "") === (old.net ?? "") && dist(v) <= VIA_MOVE_RADIUS_MM, dist);
    if (!match) {
      removed.push(old);
      continue;
    }
    const reasons: ViaChangeReason[] = [];
    const dx = match.x - old.x;
    const dy = match.y - old.y;
    if (dist(match) > VIA_EPS_MM) reasons.push("moved");
    if (Math.abs(match.diameter - old.diameter) > VIA_EPS_MM || Math.abs(match.drill - old.drill) > VIA_EPS_MM) {
      reasons.push("resized");
    }
    if ((match.net ?? "") !== (old.net ?? "")) reasons.push("net");
    if (reasons.length === 0) unchanged += 1;
    else {
      changed.push({
        before: old,
        after: match,
        reasons,
        ...(reasons.includes("moved") ? { dx, dy } : {}),
      });
    }
  }
  return { added: unmatched, removed, changed, unchanged };
}

function matchZones(older: ZoneSnapshot[], newer: ZoneSnapshot[]): {
  added: ZoneSnapshot[];
  removed: ZoneSnapshot[];
  changed: ZoneChange[];
  unchanged: number;
} {
  const unmatched = [...newer];
  const leftovers: ZoneSnapshot[] = [];
  let unchanged = 0;
  for (const old of older) {
    const idx = unmatched.findIndex((z) => z.id === old.id);
    if (idx >= 0) {
      unmatched.splice(idx, 1);
      unchanged += 1;
    } else leftovers.push(old);
  }

  const changed: ZoneChange[] = [];
  const removed: ZoneSnapshot[] = [];
  for (const old of leftovers) {
    const idx = unmatched.findIndex((z) => zoneSlot(z) === zoneSlot(old));
    if (idx < 0) {
      removed.push(old);
      continue;
    }
    const match = unmatched.splice(idx, 1)[0]!;
    const reasons: ZoneChangeReason[] = ["reshaped"];
    if ((match.net ?? "") !== (old.net ?? "")) reasons.push("net");
    if ([...old.layers].sort().join(",") !== [...match.layers].sort().join(",")) reasons.push("layers");
    changed.push({ before: old, after: match, reasons });
  }
  return { added: unmatched, removed, changed, unchanged };
}

/**
 * Structured revision diff: added/removed/moved/changed parts, net membership,
 * copper segments/arcs, vias, and zones.
 */
/** 270 and -90 are one orientation, so angles compare the shorter way round. */
function sameAngle(a: number | undefined, b: number | undefined, tolerance: number): boolean {
  if (a === undefined || b === undefined) return nearlyEqual(a, b, tolerance);
  const turn = Math.abs(a - b) % 360;
  return Math.min(turn, 360 - turn) <= tolerance;
}

export function diffBoards(from: BoardSnapshot, to: BoardSnapshot, opts: DiffOptions = {}): BoardDiff {
  const moveTol = opts.moveToleranceMm ?? 0.05;
  const schMoveTol = opts.schematicMoveToleranceMm ?? 0.05;
  const rotTol = opts.rotationToleranceDeg ?? 0.5;

  const fromParts = new Map(from.components.map((c) => [c.ref, c]));
  const toParts = new Map(to.components.map((c) => [c.ref, c]));
  const added = [...toParts.values()].filter((c) => !fromParts.has(c.ref)).sort((a, b) => a.ref.localeCompare(b.ref));
  const lostPlacement = (ref: string) => {
    const before = fromParts.get(ref);
    const after = toParts.get(ref);
    return !!before && !!after && hasPcbPlacement(before) && !hasPcbPlacement(after);
  };
  const removed = [...fromParts.values()]
    .filter((c) => !toParts.has(c.ref) || lostPlacement(c.ref))
    .sort((a, b) => a.ref.localeCompare(b.ref));
  const changed: ComponentChange[] = [];
  const unchanged: string[] = [];

  for (const [ref, after] of toParts) {
    const before = fromParts.get(ref);
    if (!before) continue;
    if (lostPlacement(ref)) continue;
    const reasons: ComponentChangeReason[] = [];
    const dx = (after.x ?? 0) - (before.x ?? 0);
    const dy = (after.y ?? 0) - (before.y ?? 0);
    const hadPcb = hasPcbPlacement(before);
    const hasPcb = hasPcbPlacement(after);
    if (hadPcb && hasPcb && (Math.abs(dx) > moveTol || Math.abs(dy) > moveTol)) reasons.push("moved");
    if (!sameAngle(before.rotation, after.rotation, rotTol) && (before.rotation !== undefined || after.rotation !== undefined)) {
      reasons.push("rotated");
    }
    const schDx = (after.schX ?? 0) - (before.schX ?? 0);
    const schDy = (after.schY ?? 0) - (before.schY ?? 0);
    const hadSch = before.schX !== undefined && before.schY !== undefined;
    const hasSch = after.schX !== undefined && after.schY !== undefined;
    if (hadSch && hasSch && (Math.abs(schDx) > schMoveTol || Math.abs(schDy) > schMoveTol)) reasons.push("schematic-moved");
    if (
      before.schRotation !== undefined &&
      after.schRotation !== undefined &&
      !nearlyEqual(before.schRotation, after.schRotation, rotTol)
    ) {
      reasons.push("schematic-rotated");
    }
    if ((before.layer ?? "") !== (after.layer ?? "") && (before.layer !== undefined || after.layer !== undefined)) {
      reasons.push("layer");
    }
    if ((before.value ?? "") !== (after.value ?? "") && (before.value !== undefined || after.value !== undefined)) {
      reasons.push("value");
    }
    if ((before.footprint ?? "") !== (after.footprint ?? "") && (before.footprint !== undefined || after.footprint !== undefined)) {
      reasons.push("footprint");
    }
    if (padsGeometryChanged(before.pads, after.pads)) reasons.push("pads");
    if (reasons.length === 0) unchanged.push(ref);
    else {
      changed.push({
        ref,
        before,
        after,
        reasons,
        ...(reasons.includes("moved") ? { dx, dy } : {}),
        ...(reasons.includes("schematic-moved") ? { schDx, schDy } : {}),
      });
    }
  }

  const fromNets = new Map(from.nets.map((n) => [n.name, n]));
  const toNets = new Map(to.nets.map((n) => [n.name, n]));
  const netsAdded = [...toNets.values()].filter((n) => !fromNets.has(n.name)).sort((a, b) => a.name.localeCompare(b.name));
  const netsRemoved = [...fromNets.values()].filter((n) => !toNets.has(n.name)).sort((a, b) => a.name.localeCompare(b.name));
  const netsChanged: NetChange[] = [];
  const netsUnchanged: string[] = [];

  for (const [name, after] of toNets) {
    const before = fromNets.get(name);
    if (!before) continue;
    const beforeKeys = nodeSet(before.nodes);
    const afterKeys = nodeSet(after.nodes);
    const addedNodes = after.nodes.filter((n) => !beforeKeys.has(nodeKey(n)));
    const removedNodes = before.nodes.filter((n) => !afterKeys.has(nodeKey(n)));
    if (addedNodes.length === 0 && removedNodes.length === 0) netsUnchanged.push(name);
    else netsChanged.push({ name, before, after, addedNodes, removedNodes });
  }

  const fromTracks = new Map(from.tracks.map((t) => [t.id, t]));
  const toTracks = new Map(to.tracks.map((t) => [t.id, t]));
  const tracksAdded = [...toTracks.values()].filter((t) => !fromTracks.has(t.id));
  const tracksRemoved = [...fromTracks.values()].filter((t) => !toTracks.has(t.id));
  const vias = matchVias(from.vias ?? [], to.vias ?? []);
  const zones = matchZones(from.zones ?? [], to.zones ?? []);

  return {
    components: {
      added,
      removed,
      changed: changed.sort((a, b) => a.ref.localeCompare(b.ref)),
      unchanged: unchanged.sort(),
    },
    nets: {
      added: netsAdded,
      removed: netsRemoved,
      changed: netsChanged.sort((a, b) => a.name.localeCompare(b.name)),
      unchanged: netsUnchanged.sort(),
    },
    tracks: {
      added: tracksAdded,
      removed: tracksRemoved,
      unchanged: [...toTracks.keys()].filter((id) => fromTracks.has(id)).length,
    },
    vias: {
      added: vias.added,
      removed: vias.removed,
      changed: vias.changed,
      unchanged: vias.unchanged,
    },
    zones: {
      added: zones.added,
      removed: zones.removed,
      changed: zones.changed,
      unchanged: zones.unchanged,
    },
  };
}

export function diffSummary(diff: BoardDiff): {
  added: number;
  removed: number;
  moved: number;
  schematicMoved: number;
  changed: number;
  netsAdded: number;
  netsRemoved: number;
  netsChanged: number;
  tracksAdded: number;
  tracksRemoved: number;
  viasAdded: number;
  viasRemoved: number;
  viasChanged: number;
  zonesAdded: number;
  zonesRemoved: number;
  zonesChanged: number;
} {
  return {
    added: diff.components.added.length,
    removed: diff.components.removed.length,
    moved: diff.components.changed.filter((c) => c.reasons.includes("moved")).length,
    schematicMoved: diff.components.changed.filter((c) => c.reasons.includes("schematic-moved")).length,
    changed: diff.components.changed.length,
    netsAdded: diff.nets.added.length,
    netsRemoved: diff.nets.removed.length,
    netsChanged: diff.nets.changed.length,
    tracksAdded: diff.tracks.added.length,
    tracksRemoved: diff.tracks.removed.length,
    viasAdded: diff.vias.added.length,
    viasRemoved: diff.vias.removed.length,
    viasChanged: diff.vias.changed.length,
    zonesAdded: diff.zones.added.length,
    zonesRemoved: diff.zones.removed.length,
    zonesChanged: diff.zones.changed.length,
  };
}

export function formatDiffText(diff: BoardDiff): string {
  const s = diffSummary(diff);
  const lines = [
    `Components +${s.added} / -${s.removed} / ~${s.changed} (${s.moved} moved on PCB, ${s.schematicMoved} on schematic)`,
    `Nets +${s.netsAdded} / -${s.netsRemoved} / ~${s.netsChanged}`,
    `Tracks +${s.tracksAdded} / -${s.tracksRemoved} / ${diff.tracks.unchanged} unchanged`,
    `Vias +${s.viasAdded} / -${s.viasRemoved} / ~${s.viasChanged}`,
    `Zones +${s.zonesAdded} / -${s.zonesRemoved} / ~${s.zonesChanged}`,
  ];
  const part = (label: string, refs: string[]) => {
    if (refs.length === 0) return;
    lines.push(`${label}: ${refs.slice(0, 24).join(", ")}${refs.length > 24 ? ` … +${refs.length - 24}` : ""}`);
  };
  part("Added", diff.components.added.map((c) => c.ref));
  part("Removed", diff.components.removed.map((c) => c.ref));
  part(
    "Changed",
    diff.components.changed.map((c) => `${c.ref} (${c.reasons.join(", ")})`),
  );
  part("Nets added", diff.nets.added.map((n) => n.name));
  part("Nets removed", diff.nets.removed.map((n) => n.name));
  part(
    "Nets changed",
    diff.nets.changed.map((n) => n.name),
  );
  part(
    "Vias",
    [
      ...diff.vias.added.map((v) => `+${v.net ?? "via"}@${v.x},${v.y}`),
      ...diff.vias.removed.map((v) => `-${v.net ?? "via"}@${v.x},${v.y}`),
      ...diff.vias.changed.map((v) => `~${v.after.net ?? "via"} (${v.reasons.join(", ")})`),
    ],
  );
  part(
    "Zones",
    [
      ...diff.zones.added.map((z) => `+${z.net ?? "zone"}`),
      ...diff.zones.removed.map((z) => `-${z.net ?? "zone"}`),
      ...diff.zones.changed.map((z) => `~${z.after.net ?? "zone"} (${z.reasons.join(", ")})`),
    ],
  );
  return lines.join("\n");
}
