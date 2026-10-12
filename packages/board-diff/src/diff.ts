import { nodeKey, type BoardDiff, type BoardSnapshot, type ComponentChange, type ComponentChangeReason, type DiffOptions, type NetChange, type NetNode } from "./types";

function nearlyEqual(a: number | undefined, b: number | undefined, tol: number): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return Math.abs(a - b) <= tol;
}

function nodeSet(nodes: NetNode[]): Set<string> {
  return new Set(nodes.map(nodeKey));
}

/**
 * Structured revision diff: added/removed/moved/changed parts, net membership, and copper segments.
 */
export function diffBoards(from: BoardSnapshot, to: BoardSnapshot, opts: DiffOptions = {}): BoardDiff {
  const moveTol = opts.moveToleranceMm ?? 0.05;
  const schMoveTol = opts.schematicMoveToleranceMm ?? 0.05;
  const rotTol = opts.rotationToleranceDeg ?? 0.5;

  const fromParts = new Map(from.components.map((c) => [c.ref, c]));
  const toParts = new Map(to.components.map((c) => [c.ref, c]));
  const added = [...toParts.values()].filter((c) => !fromParts.has(c.ref)).sort((a, b) => a.ref.localeCompare(b.ref));
  const removed = [...fromParts.values()].filter((c) => !toParts.has(c.ref)).sort((a, b) => a.ref.localeCompare(b.ref));
  const changed: ComponentChange[] = [];
  const unchanged: string[] = [];

  for (const [ref, after] of toParts) {
    const before = fromParts.get(ref);
    if (!before) continue;
    const reasons: ComponentChangeReason[] = [];
    const dx = (after.x ?? 0) - (before.x ?? 0);
    const dy = (after.y ?? 0) - (before.y ?? 0);
    const hadPcb = before.x !== undefined && before.y !== undefined;
    const hasPcb = after.x !== undefined && after.y !== undefined;
    if (hadPcb && hasPcb && (Math.abs(dx) > moveTol || Math.abs(dy) > moveTol)) reasons.push("moved");
    if (!nearlyEqual(before.rotation, after.rotation, rotTol) && (before.rotation !== undefined || after.rotation !== undefined)) {
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
  };
}

export function formatDiffText(diff: BoardDiff): string {
  const s = diffSummary(diff);
  const lines = [
    `Components +${s.added} / -${s.removed} / ~${s.changed} (${s.moved} moved on PCB, ${s.schematicMoved} on schematic)`,
    `Nets +${s.netsAdded} / -${s.netsRemoved} / ~${s.netsChanged}`,
    `Tracks +${s.tracksAdded} / -${s.tracksRemoved} / ${diff.tracks.unchanged} unchanged`,
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
  return lines.join("\n");
}
