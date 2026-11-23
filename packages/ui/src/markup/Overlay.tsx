import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../components/ui";
import { Icon } from "../components/Icon";
import { useCinemaStore } from "../stores/cinema";
import { useUiStore } from "../stores/ui";
import { snapshotMarkup } from "./capture";
import { drawStrokesOnCanvas } from "./composite";
import { markupViewCapturable } from "./payload";
import { registerMarkupCapture } from "./session";
import {
  addStroke,
  emptyStrokes,
  extendPen,
  replaceStroke,
  undoStroke,
  type ArrowStroke,
  type MarkupPoint,
  type MarkupStroke,
  type PenStroke,
  type StrokeModel,
} from "./strokes";

let strokeSeq = 0;
function nextStrokeId(): string {
  strokeSeq += 1;
  return `mk${strokeSeq}`;
}

export function MarkupOverlay() {
  const open = useUiStore((s) => s.markupOpen);
  const tool = useUiStore((s) => s.markupTool);
  const setTool = useUiStore((s) => s.setMarkupTool);
  const setOpen = useUiStore((s) => s.setMarkupOpen);
  const tab = useUiStore((s) => s.boardTab);
  const area = useUiStore((s) => s.workspaceArea);
  const capturable = markupViewCapturable(tab, area);
  const overlay = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [model, setModel] = useState<StrokeModel>(emptyStrokes);
  const modelRef = useRef(model);
  modelRef.current = model;
  const draft = useRef<MarkupStroke | null>(null);
  const pointer = useRef<number | null>(null);

  useEffect(() => {
    setModel(emptyStrokes());
    draft.current = null;
  }, [tab, area, open]);

  useEffect(() => {
    if (open && !capturable) setOpen(false);
  }, [open, capturable, setOpen]);

  useEffect(() => {
    if (!open) return;
    useCinemaStore.getState().setPlaying(false);
  }, [open]);

  const paint = useCallback(() => {
    const el = canvas.current;
    const host = overlay.current;
    if (!el || !host) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(host.clientWidth * dpr));
    const h = Math.max(1, Math.round(host.clientHeight * dpr));
    if (el.width !== w) el.width = w;
    if (el.height !== h) el.height = h;
    const ctx = el.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    const live = draft.current ? replaceStroke(modelRef.current, draft.current) : modelRef.current;
    drawStrokesOnCanvas(ctx, live.strokes, dpr);
  }, []);

  useEffect(() => {
    paint();
  }, [model, paint, open]);

  useEffect(() => {
    const host = overlay.current;
    if (!host || !open) return;
    const ro = new ResizeObserver(() => paint());
    ro.observe(host);
    return () => ro.disconnect();
  }, [open, paint]);

  useEffect(() => {
    if (!open || !capturable) {
      registerMarkupCapture(null);
      return;
    }
    registerMarkupCapture(async () => {
      const host = overlay.current;
      const root = host?.parentElement;
      if (!host || !root) return null;
      return snapshotMarkup({
        overlay: host,
        viewRoot: root,
        strokes: modelRef.current.strokes,
        tab: useUiStore.getState().boardTab,
        area: useUiStore.getState().workspaceArea,
      });
    });
    return () => registerMarkupCapture(null);
  }, [open, capturable]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z" && !event.shiftKey) {
        event.preventDefault();
        setModel((current) => undoStroke(current));
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, setOpen]);

  if (!open || !capturable) return null;

  const pointFor = (event: { clientX: number; clientY: number }): MarkupPoint | null => {
    const host = overlay.current;
    if (!host) return null;
    const rect = host.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  return (
    <div
      ref={overlay}
      className="fd-markup-overlay"
      data-testid="markup-overlay"
      onWheel={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        if ((event.target as HTMLElement | null)?.closest(".fd-markup-tools")) return;
        const point = pointFor(event);
        if (!point) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        pointer.current = event.pointerId;
        draft.current = tool === "pen"
          ? { id: nextStrokeId(), tool: "pen", points: [point] } satisfies PenStroke
          : { id: nextStrokeId(), tool: "arrow", from: point, to: point } satisfies ArrowStroke;
        paint();
      }}
      onPointerMove={(event) => {
        if (pointer.current !== event.pointerId || !draft.current) return;
        const point = pointFor(event);
        if (!point) return;
        const current = draft.current;
        draft.current = current.tool === "pen" ? extendPen(current, point) : { ...current, to: point };
        paint();
      }}
      onPointerUp={(event) => {
        if (pointer.current !== event.pointerId) return;
        pointer.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        const finished = draft.current;
        draft.current = null;
        if (!finished) return;
        if (finished.tool === "pen" && finished.points.length === 0) return;
        setModel((current) => addStroke(current, finished));
      }}
      onPointerCancel={(event) => {
        if (pointer.current !== event.pointerId) return;
        pointer.current = null;
        draft.current = null;
        paint();
      }}
    >
      <div className="fd-markup-tools" data-testid="markup-tools" onPointerDown={(event) => event.stopPropagation()}>
        <Button
          size="sm"
          variant={tool === "pen" ? "primary" : "secondary"}
          aria-pressed={tool === "pen"}
          aria-label="Pen"
          title="Pen"
          onClick={() => setTool("pen")}
        >
          <Icon name="markup" width={15} height={15} />
          Pen
        </Button>
        <Button
          size="sm"
          variant={tool === "arrow" ? "primary" : "secondary"}
          aria-pressed={tool === "arrow"}
          aria-label="Arrow"
          title="Arrow"
          onClick={() => setTool("arrow")}
        >
          <Icon name="arrowRight" width={15} height={15} />
          Arrow
        </Button>
        <Button
          size="sm"
          variant="secondary"
          aria-label="Undo last stroke"
          title="Undo last stroke"
          disabled={model.strokes.length === 0}
          onClick={() => setModel((current) => undoStroke(current))}
        >
          <Icon name="undo" width={15} height={15} />
          Undo
        </Button>
        <span className="fd-markup-hint">Esc to exit</span>
      </div>
      <canvas ref={canvas} aria-hidden="true" />
    </div>
  );
}
