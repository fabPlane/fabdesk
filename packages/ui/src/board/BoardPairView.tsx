import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import type { BoardPartSummary } from "@fabdesk/protocol";
import { highlightBoardDrawing, hitTestBoardPad, hitTestBoardPart, type PairLine } from "@fabdesk/client-core";
import { Button, Spinner } from "../components/ui";
import { clientPointToSvg, parseSvgViewBox } from "./svg-coords";
import { SvgViewer } from "./SvgViewer";
import { PairLines, PairOverlay, usePairGeometry, type PairHover, type PartMarker, type PinMarker } from "./PairOverlay";
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
  markers?: readonly PartMarker[] | undefined;
  pins?: readonly PinMarker[] | undefined;
  /** What clicking here would do, so the next click is never a guess. */
  hint?: ((part: BoardPartSummary, pin: string | null) => string) | undefined;
};
export type BoardPoint = { x: number; y: number };
const NONE: readonly never[] = [];
/** Screen distance a click may miss a small target by, at any zoom. */
const REACH_PX = 10;

function PairPanel({ side, sideName, roles, label, zoomed, onZoom, hostWidth, onPick, onClear }: {
  side: BoardPairSide;
  sideName: "left" | "right";
  roles?: readonly string[] | undefined;
  label: string;
  zoomed: boolean;
  onZoom: (next: boolean) => void;
  hostWidth: number;
  onPick: (ref: string | null, point: BoardPoint, reach: number) => void;
  onClear: () => boolean;
}) {
  const { svg, parts, selectedRef } = side;
  const selected = selectedRef ? parts.find(part => part.ref === selectedRef) ?? null : null;
  const drawing = useMemo(() => svg ? highlightBoardDrawing(svg, {
    ...(selected && zoomed ? { focus: selected.bounds } : {}),
    ...(roles?.length ? { roles } : {}),
  }) : "", [svg, selected, zoomed, roles]);
  const box = useMemo(() => drawing ? parseSvgViewBox(drawing) : null, [drawing]);
  const [hover, setHover] = useState<PairHover | null>(null);
  const frame = useRef(0), holder = useRef<HTMLDivElement>(null);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  useEffect(() => setHover(null), [drawing]);
  // Screen pixels as board millimetres, so a small pad is as easy to hit as a large one.
  const reach = box && hostWidth ? (REACH_PX / hostWidth) * box.width : 1;
  const onMove = (event: MouseEvent<HTMLDivElement>) => {
    if (event.buttons) return;
    const { clientX, clientY } = event;
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const host = holder.current?.querySelector(".fd-svg-host");
      const point = box && host ? clientPointToSvg(box, host.getBoundingClientRect(), clientX, clientY) : null;
      const part = point ? hitTestBoardPart(parts, point, reach) : null;
      if (!part || !point) { setHover(current => current && null); return; }
      const pin = hitTestBoardPad(part, point, reach);
      const hint = side.hint?.(part, pin) ?? part.ref;
      setHover(current => current?.ref === part.ref && current.pin === pin && current.hint === hint ? current : { ref: part.ref, pin, hint });
    });
  };
  return <section className="fd-pair-panel" aria-label={label} data-pair-side={sideName}>
    <header className="fd-pair-header">{side.header}</header>
    <div ref={holder} className="fd-pair-drawing" data-testid={`pair-${label.toLowerCase().replace(/\W+/g, "-")}`} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      {side.loading ? <div className="fd-pair-state"><Spinner /></div> : svg
        ? <SvgViewer
            svg={drawing}
            viewKey={`${side.viewKey}:${zoomed ? selected?.ref ?? "" : ""}`}
            overlay={overlayBox => <PairOverlay box={overlayBox} parts={parts} markers={side.markers ?? NONE} pins={side.pins ?? NONE} selectedRef={selected?.ref} hover={hover} hostWidth={hostWidth} />}
            onDrawingClick={point => onPick(hitTestBoardPart(parts, point, reach)?.ref ?? null, point, reach)}
            onDrawingEscape={onClear}
          />
        : <div className="fd-pair-state">Nothing to show yet.</div>}
      {side.notice && <p className="fd-pair-notice" role="status">{side.notice}</p>}
      {selected && <Button size="sm" className="fd-pair-zoom" aria-pressed={zoomed} onClick={() => onZoom(!zoomed)}>{zoomed ? "Whole board" : `Zoom to ${selected.ref}`}</Button>}
    </div>
  </section>;
}

/** Two boards at one scale. Revision comparison and cross-board inspection both use this. */
export function BoardPairView({ left, right, leftLabel, rightLabel, roles, updating = false, lines = NONE, onPick, onClear }: {
  left: BoardPairSide;
  right: BoardPairSide;
  leftLabel: string;
  rightLabel: string;
  roles?: readonly string[] | undefined;
  /** The drawings shown are the previous ones while the next pair loads. */
  updating?: boolean;
  lines?: readonly PairLine[];
  onPick: (side: "left" | "right", ref: string | null, point: BoardPoint, reach: number) => void;
  onClear: () => boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const geometry = usePairGeometry(container);
  const [zoomLeft, setZoomLeft] = useState(false), [zoomRight, setZoomRight] = useState(false);
  useEffect(() => setZoomLeft(false), [left.selectedRef]);
  useEffect(() => setZoomRight(false), [right.selectedRef]);
  const frame = (side: BoardPairSide, zoomed: boolean) => {
    const selected = zoomed && side.selectedRef ? side.parts.find(part => part.ref === side.selectedRef) : null;
    const box = side.svg ? parseSvgViewBox(highlightBoardDrawing(side.svg, selected ? { focus: selected.bounds } : {})) : null;
    return box;
  };
  const leftBox = useMemo(() => frame(left, zoomLeft), [left.svg, left.selectedRef, left.parts, zoomLeft]);
  const rightBox = useMemo(() => frame(right, zoomRight), [right.svg, right.selectedRef, right.parts, zoomRight]);
  return <div ref={container} className="fd-pair-view" data-updating={updating} aria-busy={updating}>
    <PairPanel side={left} sideName="left" roles={roles} label={leftLabel} zoomed={zoomLeft} onZoom={setZoomLeft} hostWidth={geometry.left?.host.width ?? 0} onPick={(ref, point, reach) => onPick("left", ref, point, reach)} onClear={onClear} />
    <PairPanel side={right} sideName="right" roles={roles} label={rightLabel} zoomed={zoomRight} onZoom={setZoomRight} hostWidth={geometry.right?.host.width ?? 0} onPick={(ref, point, reach) => onPick("right", ref, point, reach)} onClear={onClear} />
    <PairLines lines={lines} geometry={geometry} leftBox={leftBox} rightBox={rightBox} />
  </div>;
}

/** What the colours mean, next to the boards they colour. */
export function BoardLegend({ items }: { items: ReadonlyArray<{ tone: string; label: string; title?: string }> }) {
  return <ul className="fd-board-legend" aria-label="What the colours mean">
    {items.map(item => <li key={item.tone} title={item.title}><i data-tone={item.tone} aria-hidden="true" />{item.label}</li>)}
  </ul>;
}
