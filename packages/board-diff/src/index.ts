export type {
  BoardDiff,
  BoardSnapshot,
  ComponentChange,
  ComponentChangeReason,
  ComponentSnapshot,
  DiffOptions,
  NetChange,
  NetNode,
  NetSnapshot,
  PadSnapshot,
  Point,
  TrackSnapshot,
  ViaChange,
  ViaChangeReason,
  ViaSnapshot,
  ZoneChange,
  ZoneChangeReason,
  ZoneSnapshot,
} from "./types";
export { emptySnapshot, nodeKey } from "./types";
export { flattenArc, snapshotFromKicadPcb } from "./kicad-pcb";
export { snapshotFromKicadSch } from "./kicad-sch";
export { snapshotFromNetlist } from "./netlist";
export { mergeSnapshots, snapshotFromSources } from "./snapshot";
export { diffBoards, diffSummary, formatDiffText } from "./diff";
export {
  colorizeSvgMarkup,
  componentRole,
  extractSvgInner,
  overlaySvgs,
  parseViewBox,
  prefixSvgIds,
  sideBySideSvgs,
  snapshotSvg,
  visualDiffSvg,
  type ComponentRole,
  type VisualKind,
} from "./svg";

import { snapshotFromKicadPcb } from "./kicad-pcb";
import { snapshotFromKicadSch } from "./kicad-sch";
import { snapshotFromNetlist } from "./netlist";
import { snapshotFromSources } from "./snapshot";
import { diffBoards, formatDiffText } from "./diff";
import { overlaySvgs, sideBySideSvgs, snapshotSvg, visualDiffSvg } from "./svg";
import type { BoardDiff, BoardSnapshot, DiffOptions } from "./types";

export type RevisionSources = {
  netlistJson?: unknown;
  kicadPcb?: string;
  kicadSch?: string;
  pcbSvg?: string;
  schematicSvg?: string;
};

export type CompareRevisionsResult = {
  from: BoardSnapshot;
  to: BoardSnapshot;
  diff: BoardDiff;
  text: string;
  pcb: { structured: string; overlay: string; sideBySide: string };
  schematic: { structured: string; overlay: string; sideBySide: string };
};

/** Parse two revision payloads, diff them, and produce structured + visual SVGs. */
export function compareRevisions(
  from: RevisionSources,
  to: RevisionSources,
  opts: DiffOptions = {},
): CompareRevisionsResult {
  const fromSnap = snapshotFromSources({
    ...from,
    fromNetlist: snapshotFromNetlist,
    fromPcb: snapshotFromKicadPcb,
    fromSch: snapshotFromKicadSch,
  });
  const toSnap = snapshotFromSources({
    ...to,
    fromNetlist: snapshotFromNetlist,
    fromPcb: snapshotFromKicadPcb,
    fromSch: snapshotFromKicadSch,
  });
  const diff = diffBoards(fromSnap, toSnap, opts);
  const pcbStructured = visualDiffSvg(fromSnap, toSnap, diff, "pcb");
  const schStructured = visualDiffSvg(fromSnap, toSnap, diff, "schematic");
  // Saved renders may be absent or stale at either revision. When design data
  // exists, draw both revisions from the parsed sources using the same renderer.
  // Keep SVG-only callers supported, but never mix one saved render with a
  // generated snapshot on the other side.
  const hasDesignSources = [from, to].some((source) =>
    source.kicadPcb !== undefined || source.kicadSch !== undefined || source.netlistJson !== undefined,
  );
  const pcbSvgPair = !hasDesignSources && from.pcbSvg && to.pcbSvg;
  const schSvgPair = !hasDesignSources && from.schematicSvg && to.schematicSvg;
  const pcbFrom = pcbSvgPair ? from.pcbSvg! : snapshotSvg(fromSnap, "pcb");
  const pcbTo = pcbSvgPair ? to.pcbSvg! : snapshotSvg(toSnap, "pcb");
  const schFrom = schSvgPair ? from.schematicSvg! : snapshotSvg(fromSnap, "schematic");
  const schTo = schSvgPair ? to.schematicSvg! : snapshotSvg(toSnap, "schematic");
  const pcbOverlay = overlaySvgs(pcbFrom, pcbTo);
  const schOverlay = overlaySvgs(schFrom, schTo);
  const pcbSide = sideBySideSvgs(pcbFrom, pcbTo);
  const schSide = sideBySideSvgs(schFrom, schTo);
  return {
    from: fromSnap,
    to: toSnap,
    diff,
    text: formatDiffText(diff),
    pcb: {
      structured: pcbStructured,
      overlay: pcbOverlay,
      sideBySide: pcbSide,
    },
    schematic: {
      structured: schStructured,
      overlay: schOverlay,
      sideBySide: schSide,
    },
  };
}
