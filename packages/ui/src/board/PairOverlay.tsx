import { useEffect, useState, type RefObject } from "react";
import type { PairLine } from "@fabdesk/client-core";
import type { BoardPartSummary } from "@fabdesk/protocol";
import { svgPointToPercent, type SvgBox } from "./svg-coords";

export type PartMarkerTone = "connector" | "linked" | "review" | "missing" | "candidate";
export type PartMarker = { ref: string; tone: PartMarkerTone; chip?: string | undefined };
export type PinMarker = { ref: string; pin: string; tone: "mapped" | "match" | "differs" | "conflict" | "unnamed" | "active" };
export type PairHover = { ref: string; pin?: string | null | undefined; hint: string };
const PIN_LABEL_MIN_PX = 11;

/**
 * Everything that changes with selection sits over the board, not in its picture, so the board does
 * not redraw on a click. Outlines keep one screen width at any zoom.
 */
export function PairOverlay({ box, parts, markers, pins, selectedRef, hover, hostWidth }: {
  box: SvgBox | null;
  parts: readonly BoardPartSummary[];
  markers: readonly PartMarker[];
  pins: readonly PinMarker[];
  selectedRef?: string | null | undefined;
  hover: PairHover | null;
  hostWidth: number;
}) {
  if (!box) return null;
  const byRef = new Map(parts.map(part => [part.ref, part]));
  const selected = selectedRef ? byRef.get(selectedRef) ?? null : null;
  const hovered = hover ? byRef.get(hover.ref) ?? null : null;
  const pad = 0.3;
  const rectFor = (bounds: BoardPartSummary["bounds"]) => ({ x: bounds.minX - pad, y: bounds.minY - pad, width: bounds.maxX - bounds.minX + pad * 2, height: bounds.maxY - bounds.minY + pad * 2 });
  const place = (x: number, y: number) => {
    const percent = svgPointToPercent(box, { x, y });
    return percent ? { left: `${percent.left}%`, top: `${percent.top}%` } : undefined;
  };
  const pxPerMm = hostWidth / box.width;
  const padOf = (ref: string, pin: string) => byRef.get(ref)?.pads.find(row => row.pin === pin) ?? null;
  const hoverPad = hover?.pin ? padOf(hover.ref, hover.pin) : null;
  const pinLabels = selected ? selected.pads.filter(row => (row.bounds.maxX - row.bounds.minX) * pxPerMm >= PIN_LABEL_MIN_PX && (row.bounds.maxY - row.bounds.minY) * pxPerMm >= PIN_LABEL_MIN_PX) : [];
  const veil = selected ? rectFor(selected.bounds) : null;
  return <div className="fd-pair-overlay" aria-hidden="true">
    <svg viewBox={`${box.x} ${box.y} ${box.width} ${box.height}`} preserveAspectRatio="none">
      {/* Fades the rest of the board around the selected part, with no change to the board picture. */}
      {veil && <path className="fd-pair-veil" fillRule="evenodd" d={`M${box.x} ${box.y}h${box.width}v${box.height}h${-box.width}Z M${veil.x} ${veil.y}h${veil.width}v${veil.height}h${-veil.width}Z`} />}
      {markers.map(marker => {
        const part = byRef.get(marker.ref);
        return part ? <rect key={`${marker.ref}:${marker.tone}`} {...rectFor(part.bounds)} rx={0.25} className="fd-part-marker" data-tone={marker.tone} /> : null;
      })}
      {pins.map(pin => {
        const row = padOf(pin.ref, pin.pin);
        if (!row) return null;
        const { minX, minY, maxX, maxY } = row.bounds;
        return <rect key={`${pin.ref}:${pin.pin}:${pin.tone}`} x={minX} y={minY} width={maxX - minX} height={maxY - minY} className="fd-pin-marker" data-tone={pin.tone} />;
      })}
      {selected && <rect {...rectFor(selected.bounds)} rx={0.25} className="fd-part-selected" />}
      {hovered && <rect {...rectFor(hovered.bounds)} rx={0.25} className="fd-part-hover" />}
      {hoverPad && <rect x={hoverPad.bounds.minX} y={hoverPad.bounds.minY} width={hoverPad.bounds.maxX - hoverPad.bounds.minX} height={hoverPad.bounds.maxY - hoverPad.bounds.minY} className="fd-pin-hover" />}
    </svg>
    {markers.filter(marker => marker.chip).map(marker => {
      const part = byRef.get(marker.ref);
      return part ? <span key={`chip:${marker.ref}`} className="fd-part-chip" data-tone={marker.tone} style={place((part.bounds.minX + part.bounds.maxX) / 2, part.bounds.minY)}>{marker.chip}</span> : null;
    })}
    {pinLabels.map(row => <span key={`pin:${row.pin}`} className="fd-pin-label" style={place((row.bounds.minX + row.bounds.maxX) / 2, (row.bounds.minY + row.bounds.maxY) / 2)}>{row.pin}</span>)}
    {hovered && hover && <span className="fd-part-hint" style={place((hovered.bounds.minX + hovered.bounds.maxX) / 2, hovered.bounds.maxY)}>{hover.hint}</span>}
  </div>;
}

type Side = { host: DOMRect; view: DOMRect };
export type PairGeometry = { left: Side | null; right: Side | null; origin: DOMRect | null };
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

/** Track where both drawings sit on screen, through zoom, scroll, resize and redraw. */
export function usePairGeometry(container: RefObject<HTMLElement | null>): PairGeometry {
  const [geometry, setGeometry] = useState<PairGeometry>({ left: null, right: null, origin: null });
  useEffect(() => {
    const root = container.current;
    if (!root) return;
    let frame = 0;
    const side = (name: string): Side | null => {
      const host = root.querySelector(`[data-pair-side="${name}"] .fd-svg-host`), view = root.querySelector(`[data-pair-side="${name}"] .fd-svg-viewport`);
      return host && view ? { host: host.getBoundingClientRect(), view: view.getBoundingClientRect() } : null;
    };
    const measure = () => {
      frame = 0;
      setGeometry({ left: side("left"), right: side("right"), origin: root.getBoundingClientRect() });
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const resize = new ResizeObserver(schedule);
    const watch = () => {
      resize.disconnect();
      resize.observe(root);
      root.querySelectorAll(".fd-svg-host, .fd-svg-viewport").forEach(element => resize.observe(element));
      schedule();
    };
    const mutations = new MutationObserver(watch);
    mutations.observe(root, { childList: true, subtree: true });
    root.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    watch();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
      root.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
    };
  }, [container]);
  return geometry;
}

function endPoint(point: { x: number; y: number }, box: SvgBox | null, side: Side | null, origin: DOMRect) {
  if (!box || !side) return null;
  const x = side.host.left + ((point.x - box.x) / box.width) * side.host.width;
  const y = side.host.top + ((point.y - box.y) / box.height) * side.host.height;
  const inside = x >= side.view.left && x <= side.view.right && y >= side.view.top && y <= side.view.bottom;
  // A part scrolled out of view keeps its line, pinned to the edge of its panel.
  return { x: clamp(x, side.view.left, side.view.right) - origin.left, y: clamp(y, side.view.top, side.view.bottom) - origin.top, inside };
}

/** Lines across the two drawings, from a part or pin on one board to the one it connects to. */
export function PairLines({ lines, geometry, leftBox, rightBox }: {
  lines: readonly PairLine[];
  geometry: PairGeometry;
  leftBox: SvgBox | null;
  rightBox: SvgBox | null;
}) {
  const { origin } = geometry;
  if (!origin || !lines.length) return null;
  return <svg className="fd-pair-lines" width={origin.width} height={origin.height} aria-hidden="true" data-line-count={lines.length}>
    {lines.map(line => {
      const a = endPoint(line.left, leftBox, geometry.left, origin), b = endPoint(line.right, rightBox, geometry.right, origin);
      if (!a || !b) return null;
      const bend = Math.max(36, Math.abs(b.x - a.x) * 0.4);
      return <g key={line.id} data-tone={line.tone} data-selected={line.selected || undefined} className="fd-pair-line">
        <path className="fd-pair-line-halo" d={`M${a.x} ${a.y}C${a.x + bend} ${a.y} ${b.x - bend} ${b.y} ${b.x} ${b.y}`} />
        <path className="fd-pair-line-stroke" d={`M${a.x} ${a.y}C${a.x + bend} ${a.y} ${b.x - bend} ${b.y} ${b.x} ${b.y}`} />
        <circle cx={a.x} cy={a.y} r={a.inside ? 3.5 : 2} />
        <circle cx={b.x} cy={b.y} r={b.inside ? 3.5 : 2} />
      </g>;
    })}
  </svg>;
}
