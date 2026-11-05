import { useMemo, type ReactNode } from "react";
import type { BoardPartSummary } from "@fabdesk/protocol";
import { highlightBoardDrawing, hitTestBoardPart } from "@fabdesk/client-core";
import { Spinner } from "../components/ui";
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
};

function PairPanel({ side, roles, label, onPick, onClear }: {
  side: BoardPairSide;
  roles?: readonly string[] | undefined;
  label: string;
  onPick: (ref: string | null) => void;
  onClear: () => boolean;
}) {
  const { svg, parts, selectedRef } = side;
  const selected = selectedRef ? parts.find(part => part.ref === selectedRef) ?? null : null;
  const drawing = useMemo(() => svg ? highlightBoardDrawing(svg, { ...(selected ? { refs: [selected.ref], focus: selected.bounds } : {}), ...(roles?.length ? { roles } : {}) }) : "", [svg, selected, roles]);
  return <section className="fd-pair-panel" aria-label={label}>
    <header className="fd-pair-header">{side.header}</header>
    <div className="fd-pair-drawing" data-testid={`pair-${label.toLowerCase().replace(/\W+/g, "-")}`}>
      {side.loading ? <div className="fd-pair-state"><Spinner /></div> : svg
        ? <SvgViewer svg={drawing} viewKey={`${side.viewKey}:${selected?.ref ?? ""}`} onDrawingClick={point => onPick(hitTestBoardPart(parts, point)?.ref ?? null)} onDrawingEscape={onClear} />
        : <div className="fd-pair-state">Nothing to show yet.</div>}
      {side.notice && <p className="fd-pair-notice" role="status">{side.notice}</p>}
    </div>
  </section>;
}

/** Two boards at one scale. Revision comparison and cross-board inspection both use this. */
export function BoardPairView({ left, right, leftLabel, rightLabel, roles, onPick, onClear }: {
  left: BoardPairSide;
  right: BoardPairSide;
  leftLabel: string;
  rightLabel: string;
  roles?: readonly string[] | undefined;
  onPick: (side: "left" | "right", ref: string | null) => void;
  onClear: () => boolean;
}) {
  return <div className="fd-pair-view">
    <PairPanel side={left} roles={roles} label={leftLabel} onPick={ref => onPick("left", ref)} onClear={onClear} />
    <PairPanel side={right} roles={roles} label={rightLabel} onPick={ref => onPick("right", ref)} onClear={onClear} />
  </div>;
}
