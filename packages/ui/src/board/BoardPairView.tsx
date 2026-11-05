import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { BoardPartSummary } from "@fabdesk/protocol";
import { highlightBoardDrawing, hitTestBoardPart } from "@fabdesk/client-core";
import { Button, Spinner } from "../components/ui";
import { SvgViewer } from "./SvgViewer";
import "./board-workspace.css";

export type BoardPairSide = {
  /** Heading content, such as a revision label or a board and part picker. */
  header: ReactNode;
  svg?: string | undefined;
  viewKey: string;
  parts: readonly BoardPartSummary[];
  selectedRef?: string | null | undefined;
  loading?: boolean;
  /** Shown over the drawing when the selected part does not exist on this side. */
  notice?: string | null | undefined;
  mappedPins?: readonly string[] | undefined;
  activePin?: string | null | undefined;
};
export type BoardPoint = { x: number; y: number };

function PairPanel({ side, roles, label, onPick, onClear }: {
  side: BoardPairSide;
  roles?: readonly string[] | undefined;
  label: string;
  onPick: (ref: string | null, point: BoardPoint) => void;
  onClear: () => boolean;
}) {
  const { svg, parts, selectedRef } = side;
  const selected = selectedRef ? parts.find(part => part.ref === selectedRef) ?? null : null;
  // Selecting never moves the camera. Zoom is a separate request, so the board stays where you left it.
  const [zoomed, setZoomed] = useState(false);
  useEffect(() => setZoomed(false), [selected?.ref]);
  const drawing = useMemo(() => svg ? highlightBoardDrawing(svg, {
    ...(selected ? { refs: [selected.ref] } : {}),
    ...(selected && zoomed ? { focus: selected.bounds } : {}),
    ...(roles?.length ? { roles } : {}),
    ...(side.mappedPins?.length ? { mappedPins: side.mappedPins } : {}),
    ...(side.activePin ? { activePin: side.activePin } : {}),
  }) : "", [svg, selected, zoomed, roles, side.mappedPins, side.activePin]);
  return <section className="fd-pair-panel" aria-label={label}>
    <header className="fd-pair-header">{side.header}</header>
    <div className="fd-pair-drawing" data-testid={`pair-${label.toLowerCase().replace(/\W+/g, "-")}`}>
      {side.loading ? <div className="fd-pair-state"><Spinner /></div> : svg
        ? <SvgViewer svg={drawing} viewKey={`${side.viewKey}:${zoomed ? selected?.ref ?? "" : ""}`} onDrawingClick={point => onPick(hitTestBoardPart(parts, point)?.ref ?? null, point)} onDrawingEscape={onClear} />
        : <div className="fd-pair-state">Nothing to show yet.</div>}
      {side.notice && <p className="fd-pair-notice" role="status">{side.notice}</p>}
      {selected && <Button size="sm" className="fd-pair-zoom" aria-pressed={zoomed} onClick={() => setZoomed(!zoomed)}>{zoomed ? "Whole board" : `Zoom to ${selected.ref}`}</Button>}
    </div>
  </section>;
}

/** Two boards at one scale. Revision comparison and cross-board inspection both use this. */
export function BoardPairView({ left, right, leftLabel, rightLabel, roles, updating = false, onPick, onClear }: {
  left: BoardPairSide;
  right: BoardPairSide;
  leftLabel: string;
  rightLabel: string;
  roles?: readonly string[] | undefined;
  /** The drawings shown are the previous ones while the next pair loads. */
  updating?: boolean;
  onPick: (side: "left" | "right", ref: string | null, point: BoardPoint) => void;
  onClear: () => boolean;
}) {
  return <div className="fd-pair-view" data-updating={updating} aria-busy={updating}>
    <PairPanel side={left} roles={roles} label={leftLabel} onPick={(ref, point) => onPick("left", ref, point)} onClear={onClear} />
    <PairPanel side={right} roles={roles} label={rightLabel} onPick={(ref, point) => onPick("right", ref, point)} onClear={onClear} />
  </div>;
}
