import { useEffect, useRef, useState } from "react";
import {
  boardContours,
  clone,
  expanded,
  inside,
  moveParts,
  polygons,
  shove,
  worldBounds,
  type PlacementSession,
  type NetEdge,
  type Point,
} from "@fabdesk/client-core/placement";

interface View {
  x: number;
  y: number;
  scale: number;
}
interface Drag {
  mode: "pan" | "move" | "box";
  start: Point;
  last: Point;
  view: View;
  ids: string[];
  session: PlacementSession;
  moved: boolean;
  additive: boolean;
}
export function PlacementCanvas({
  session,
  baseline,
  selection,
  edges,
  net,
  side,
  push,
  grid,
  mode,
  disabled,
  focus,
  onSelection,
  onCommit,
  onRotate,
  onUndo,
  onRedo,
  onError,
}: {
  session: PlacementSession;
  selection: string[];
  edges: NetEdge[];
  net: string;
  side: string;
  baseline: PlacementSession | undefined;
  push: boolean;
  grid: number;
  mode: "select" | "pan";
  disabled: boolean;
  focus: { ids: string[]; nonce: number };
  onSelection: (ids: string[]) => void;
  onCommit: (session: PlacementSession) => void;
  onRotate: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onError: (message: string) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const view = useRef<View>({ x: 0, y: 0, scale: 1 });
  const drag = useRef<Drag | null>(null);
  const space = useRef(false);
  const frame = useRef(0);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const previousSize = useRef({ w: 0, h: 0 });
  const latest = useRef({ session, baseline, selection, edges, net, side, disabled, mode, grid, push });
  latest.current = { session, baseline, selection, edges, net, side, disabled, mode, grid, push };
  const visible = (s: PlacementSession) =>
    s.parts.filter((p) => latest.current.side === "both" || latest.current.side === p.side);
  const fit = (ids: string[] = []) => {
    const chosen = session.parts.filter((p) => ids.includes(p.id));
    const boxes = chosen.map(worldBounds);
    const b = session.board;
    const minX = boxes.length ? Math.min(...boxes.map((b) => b.minX)) : b.x;
    const minY = boxes.length ? Math.min(...boxes.map((b) => b.minY)) : b.y;
    const w = boxes.length ? Math.max(...boxes.map((b) => b.maxX)) - minX : b.w;
    const h = boxes.length ? Math.max(...boxes.map((b) => b.maxY)) - minY : b.h;
    const scale = Math.max(0.05, Math.min((size.w - 64) / Math.max(w, 10), (size.h - 64) / Math.max(h, 10)));
    view.current = { x: size.w / 2 - (minX + w / 2) * scale, y: size.h / 2 - (minY + h / 2) * scale, scale };
    draw();
  };
  function draw() {
    const el = canvas.current,
      ctx = el?.getContext("2d");
    if (!el || !ctx) return;
    const { session, baseline, selection, edges, net } = latest.current;
    const state = drag.current?.mode === "move" ? drag.current.session : session;
    const v = view.current,
      dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = el.clientWidth,
      h = el.clientHeight;
    if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) {
      el.width = Math.round(w * dpr);
      el.height = Math.round(h * dpr);
    }
    const theme = getComputedStyle(el),
      color = (name: string) => theme.getPropertyValue(name).trim();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = color("--fd-bg");
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = color("--fd-border");
    const step = Math.max(16, 5 * v.scale);
    for (let x = ((v.x % step) + step) % step; x < w; x += step)
      for (let y = ((v.y % step) + step) % step; y < h; y += step) ctx.fillRect(x, y, 1, 1);
    ctx.translate(v.x, v.y);
    ctx.scale(v.scale, v.scale);
    const trace = (loops: Point[][]) => {
      ctx.beginPath();
      for (const points of loops) {
        if (!points.length) continue;
        ctx.moveTo(...points[0]!);
        for (const p of points.slice(1)) ctx.lineTo(...p);
        ctx.closePath();
      }
    };
    trace(boardContours(state));
    ctx.fillStyle = color("--fd-panel-2");
    ctx.fill("evenodd");
    ctx.strokeStyle = color("--fd-accent");
    ctx.lineWidth = 1.4 / v.scale;
    ctx.stroke();
    if (baseline) {
      ctx.strokeStyle = color("--fd-muted");
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1 / v.scale;
      ctx.setLineDash([4 / v.scale, 3 / v.scale]);
      for (const old of baseline.parts) {
        const p = state.parts.find((p) => p.id === old.id);
        if (p && p.x === old.x && p.y === old.y && p.angle === old.angle && p.footprint === old.footprint)
          continue;
        trace(polygons(old));
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
    for (const a of state.reservedAreas ?? []) {
      ctx.fillStyle = color("--fd-warning");
      ctx.globalAlpha = 0.13;
      ctx.fillRect(a.x, a.y, a.w, a.h);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = color("--fd-warning");
      ctx.setLineDash([4 / v.scale, 3 / v.scale]);
      ctx.strokeRect(a.x, a.y, a.w, a.h);
      ctx.setLineDash([]);
      ctx.font = `${10 / v.scale}px sans-serif`;
      ctx.fillText(a.name, a.x + 3 / v.scale, a.y + 12 / v.scale);
    }
    if (!drag.current && net !== "off") {
      ctx.strokeStyle = color("--fd-accent");
      ctx.lineWidth = 0.8 / v.scale;
      ctx.globalAlpha = net ? 0.7 : 0.22;
      ctx.beginPath();
      for (const e of edges) {
        if (net && e.name !== net) continue;
        ctx.moveTo(...e.a.xy);
        ctx.lineTo(...e.b.xy);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    for (const p of visible(state)) {
      const b = worldBounds(p);
      if (
        b.maxX * v.scale + v.x < -30 ||
        b.minX * v.scale + v.x > w + 30 ||
        b.maxY * v.scale + v.y < -30 ||
        b.minY * v.scale + v.y > h + 30
      )
        continue;
      const active = selection.includes(p.id);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate((-p.angle * Math.PI) / 180);
      trace(p.contours);
      ctx.fillStyle = color(active ? "--fd-accent" : "--fd-panel");
      ctx.globalAlpha = active ? 0.23 : 0.95;
      ctx.fill("evenodd");
      ctx.globalAlpha = 1;
      ctx.strokeStyle = color(active ? "--fd-accent" : "--fd-muted");
      ctx.lineWidth = (active ? 2 : 0.8) / v.scale;
      ctx.stroke();
      for (const pad of p.pads) {
        ctx.save();
        ctx.translate(pad.x, pad.y);
        ctx.rotate((-pad.angle * Math.PI) / 180);
        ctx.fillStyle = p.side === "B" ? "#94a9d9" : "#d5b271";
        ctx.beginPath();
        if (pad.shape === "circle")
          ctx.ellipse(0, 0, Math.abs(pad.w / 2), Math.abs(pad.h / 2), 0, 0, Math.PI * 2);
        else ctx.rect(-pad.w / 2, -pad.h / 2, pad.w, pad.h);
        ctx.fill();
        if (pad.drill > 0) {
          ctx.fillStyle = color("--fd-bg");
          ctx.beginPath();
          ctx.arc(0, 0, pad.drill / 2, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
      ctx.restore();
      if (v.scale > 2 || active) {
        ctx.font = `${active ? "600 " : ""}${Math.min(12 / v.scale, 1.1)}px sans-serif`;
        ctx.textAlign = "center";
        ctx.fillStyle = color(active ? "--fd-accent" : "--fd-fg");
        ctx.fillText(p.ref + (p.locked ? " · locked" : ""), p.x, b.minY - 4 / v.scale);
      }
    }
    if (drag.current?.mode === "box") {
      const d = drag.current;
      ctx.fillStyle = color("--fd-accent");
      ctx.globalAlpha = 0.12;
      ctx.fillRect(d.start[0], d.start[1], d.last[0] - d.start[0], d.last[1] - d.start[1]);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = color("--fd-accent");
      ctx.lineWidth = 1 / v.scale;
      ctx.strokeRect(d.start[0], d.start[1], d.last[0] - d.start[0], d.last[1] - d.start[1]);
    }
  }
  const schedule = () => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(draw);
  };
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    if (!size.w || !size.h) return;
    if (!previousSize.current.w) fit(focus.ids);
    else {
      view.current.x += (size.w - previousSize.current.w) / 2;
      view.current.y += (size.h - previousSize.current.h) / 2;
      draw();
    }
    previousSize.current = size;
  }, [size.w, size.h]);
  useEffect(() => {
    if (size.w && size.h) fit(focus.ids);
  }, [focus.nonce]);
  useEffect(() => {
    draw();
  }, [session, baseline, selection, edges, net, side]);
  useEffect(() => {
    const el = canvas.current!;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (drag.current) return;
      const r = el.getBoundingClientRect(),
        v = view.current,
        x = event.clientX - r.left,
        y = event.clientY - r.top;
      const s = Math.max(
        0.05,
        Math.min(
          160,
          v.scale *
            Math.exp(-Math.max(-200, Math.min(200, event.deltaY * (event.deltaMode === 1 ? 16 : 1))) * 0.002),
        ),
      );
      view.current = { scale: s, x: x - ((x - v.x) * s) / v.scale, y: y - ((y - v.y) * s) / v.scale };
      schedule();
    };
    const observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-skin"] });
    el.addEventListener("wheel", wheel, { passive: false });
    return () => {
      observer.disconnect();
      el.removeEventListener("wheel", wheel);
      cancelAnimationFrame(frame.current);
    };
  }, []);
  const point = (event: { clientX: number; clientY: number }): Point => {
    const r = canvas.current!.getBoundingClientRect(),
      v = view.current;
    return [(event.clientX - r.left - v.x) / v.scale, (event.clientY - r.top - v.y) / v.scale];
  };
  const cancel = () => {
    drag.current = null;
    space.current = false;
    schedule();
  };
  return (
    <canvas
      ref={canvas}
      data-testid="placement-canvas"
      className={`fd-placement-canvas ${mode === "pan" ? "is-pan" : ""}`}
      tabIndex={0}
      aria-label="PCB placement canvas. Select parts in the Parts list or click a footprint. Arrow keys move, R rotates, Home fits, F focuses. Scroll to zoom; Space and drag to pan."
      onBlur={cancel}
      onPointerCancel={cancel}
      onPointerDown={(event) => {
        if (event.button > 1) return;
        event.currentTarget.focus();
        event.preventDefault();
        const xy = point(event),
          pan = event.button === 1 || space.current || mode === "pan";
        if (disabled && !pan) return;
        const hit =
          !pan &&
          [...visible(session)].reverse().find((p) => polygons(p).some((poly) => inside(xy, poly, true)));
        let ids = selection;
        if (hit) {
          ids = event.shiftKey
            ? selection.includes(hit.id)
              ? selection.filter((id) => !expanded(session, [hit.id]).includes(id))
              : expanded(session, [...selection, hit.id])
            : selection.includes(hit.id)
              ? selection
              : expanded(session, [hit.id]);
          onSelection(ids);
        } else if (!pan && !event.shiftKey) {
          ids = [];
          onSelection([]);
        }
        drag.current = {
          mode: pan ? "pan" : hit ? "move" : "box",
          start: xy,
          last: xy,
          view: { ...view.current },
          ids,
          session: hit && !pan ? clone(session) : session,
          moved: false,
          additive: event.shiftKey,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const d = drag.current;
        if (!d) return;
        const xy = point(event);
        if (d.mode === "pan") {
          view.current.x += (xy[0] - d.start[0]) * view.current.scale;
          view.current.y += (xy[1] - d.start[1]) * view.current.scale;
        } else if (d.mode === "move") {
          const snap = (v: number) => (grid ? Math.round(v / grid) * grid : v);
          const dx = snap(xy[0] - d.start[0]) - snap(d.last[0] - d.start[0]),
            dy = snap(xy[1] - d.start[1]) - snap(d.last[1] - d.start[1]);
          moveParts(d.session, d.ids, dx, dy);
          d.last = xy;
          d.moved = d.session.parts.some(
            (p, i) => p.x !== session.parts[i]!.x || p.y !== session.parts[i]!.y,
          );
        } else d.last = xy;
        schedule();
      }}
      onPointerUp={(event) => {
        const d = drag.current;
        if (!d) return;
        drag.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
        try {
          if (d.mode === "move" && d.moved) {
            if (push && session.parts.length <= 200) shove(d.session, d.ids);
            onCommit(d.session);
          }
          if (d.mode === "box") {
            const ids = visible(session)
              .filter((p) => {
                const b = worldBounds(p);
                return (
                  b.minX >= Math.min(d.start[0], d.last[0]) &&
                  b.maxX <= Math.max(d.start[0], d.last[0]) &&
                  b.minY >= Math.min(d.start[1], d.last[1]) &&
                  b.maxY <= Math.max(d.start[1], d.last[1])
                );
              })
              .map((p) => p.id);
            onSelection(expanded(session, [...(d.additive ? d.ids : []), ...ids]));
          }
        } catch (e) {
          onError(e instanceof Error ? e.message : String(e));
        }
        schedule();
      }}
      onKeyUp={(e) => {
        if (e.code === "Space") space.current = false;
      }}
      onKeyDown={(event) => {
        const key = event.key.toLowerCase();
        if (
          ![" ", "escape", "home", "f", "r", "z", "arrowleft", "arrowright", "arrowup", "arrowdown"].includes(
            key,
          )
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        if (key === " ") {
          space.current = true;
          return;
        }
        if (key === "escape") {
          cancel();
          return;
        }
        if (key === "home") {
          fit();
          return;
        }
        if (key === "f") {
          fit(selection);
          return;
        }
        if (disabled) return;
        if (key === "z" && (event.ctrlKey || event.metaKey)) {
          event.shiftKey ? onRedo() : onUndo();
          return;
        }
        if (key === "r") {
          onRotate();
          return;
        }
        if (!selection.length || !key.startsWith("arrow")) return;
        try {
          const next = clone(session),
            step = (grid || 0.1) * (event.shiftKey ? 5 : 1);
          moveParts(
            next,
            selection,
            key === "arrowleft" ? -step : key === "arrowright" ? step : 0,
            key === "arrowup" ? -step : key === "arrowdown" ? step : 0,
          );
          if (!next.parts.some((p, i) => p.x !== session.parts[i]!.x || p.y !== session.parts[i]!.y)) return;
          if (push && next.parts.length <= 200) shove(next, selection);
          onCommit(next);
        } catch (e) {
          onError(String(e));
        }
      }}
    />
  );
}
