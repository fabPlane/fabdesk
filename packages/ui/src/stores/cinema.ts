import type { RouteFrame, RouteFrameLine, RouteMeta, RouteResult, RouteStatic } from "@fabdesk/protocol";
import { create } from "zustand";
import { applyLine, emptyRun, type CinemaRun } from "../board/cinema/renderer";

/**
 * Frames kept per run. A large board streams hundreds of frames of thousands of shapes each; the
 * store keeps the newest `MAX_FRAMES` (plus every `pass-start`/`done` frame) and folds the rest
 * into `run.evicted` so the scrub bar still spans the whole run.
 */
export const MAX_FRAMES = 400;

export interface CinemaPerf {
  /** Frames ingested in the last second (EMA). */
  fps: number;
  /** Last canvas draw, ms. */
  drawMs: number;
  /** Frames received for the active run (before eviction). */
  received: number;
  /** Frames the run produced that never reached the store (throttled/coalesced upstream), from seq gaps. */
  dropped: number;
}

export interface CinemaState {
  runs: Record<string, CinemaRun>;
  activeRunId: string | null;
  /** Frame index shown; -1 = none yet. */
  cursor: number;
  playing: boolean;
  followLive: boolean;
  hiddenLayers: number[];
  playbackMs: number;
  perf: CinemaPerf;
  ingest: (line: RouteFrameLine) => void;
  ingestMany: (runId: string, lines: RouteFrameLine[]) => void;
  setDone: (result: RouteResult) => void;
  setActiveRun: (runId: string | null) => void;
  seek: (index: number, opts?: { keepLive?: boolean }) => void;
  step: (delta: number) => void;
  goLive: () => void;
  setPlaying: (playing: boolean) => void;
  togglePlaying: () => void;
  toggleLayer: (layer: number) => void;
  setPlaybackMs: (ms: number) => void;
  reportDraw: (drawMs: number) => void;
}

function clampCursor(run: CinemaRun | undefined, index: number): number {
  if (!run || run.frames.length === 0) return -1;
  return Math.max(0, Math.min(run.frames.length - 1, index));
}

/** Drops the oldest non-structural frames beyond MAX_FRAMES. Returns the run unchanged when under the cap. */
export function capFrames(run: CinemaRun, max = MAX_FRAMES): CinemaRun {
  if (run.frames.length <= max) return run;
  const excess = run.frames.length - max;
  const frames: RouteFrame[] = [];
  let evicted = 0;
  for (const f of run.frames) {
    const structural = f.event.kind === "pass-start" || f.event.kind === "done";
    if (evicted < excess && !structural) {
      evicted += 1;
      continue;
    }
    frames.push(f);
  }
  return { ...run, frames, evicted: (run.evicted ?? 0) + evicted };
}

/** Frames the router numbered but this client never saw: `seq` gaps (throttled by the bus, missed while disconnected). */
export function droppedFrames(run: CinemaRun): number {
  const last = run.frames[run.frames.length - 1];
  if (!last) return 0;
  return Math.max(0, last.seq - (run.frames.length + (run.evicted ?? 0)));
}

/** Frame rate estimate: exponential moving average over inter-arrival times. */
export function updateFps(prev: number, lastAt: number | null, now: number): number {
  if (lastAt === null) return prev;
  const dt = Math.max(1, now - lastAt);
  const instant = 1000 / dt;
  return prev === 0 ? instant : prev * 0.8 + instant * 0.2;
}

let lastFrameAt: number | null = null;

export const useCinemaStore = create<CinemaState>()((set, get) => ({
  runs: {},
  activeRunId: null,
  cursor: -1,
  playing: false,
  followLive: true,
  hiddenLayers: [],
  playbackMs: 120,
  perf: { fps: 0, drawMs: 0, received: 0, dropped: 0 },
  ingest: (line) => {
    const now = performance.now();
    set((s) => {
      const prev = s.runs[line.runId] ?? emptyRun(line.runId);
      const next = capFrames(applyLine(prev, line));
      const runs = { ...s.runs, [line.runId]: next };
      const becomesActive = s.activeRunId === null || line.kind === "meta";
      const activeRunId = becomesActive ? line.runId : s.activeRunId;
      const isActive = activeRunId === line.runId;
      const cursor = isActive && s.followLive ? next.frames.length - 1 : isActive ? clampCursor(next, s.cursor) : s.cursor;
      let perf = s.perf;
      if (line.kind === "frame" && isActive) {
        perf = { ...s.perf, fps: updateFps(s.perf.fps, lastFrameAt, now), received: (line.runId === s.activeRunId ? s.perf.received : 0) + 1, dropped: droppedFrames(next) };
        lastFrameAt = now;
      } else if (line.kind === "meta") {
        perf = { fps: 0, drawMs: 0, received: 0, dropped: 0 };
        lastFrameAt = null;
      }
      return { runs, activeRunId, cursor, perf };
    });
  },
  ingestMany: (runId, lines) => {
    set((s) => {
      let run = s.runs[runId] ?? emptyRun(runId);
      let frames = 0;
      for (const line of lines) {
        if (line.runId !== runId) continue;
        run = applyLine(run, line);
        if (line.kind === "frame") frames += 1;
      }
      run = capFrames(run);
      const runs = { ...s.runs, [runId]: run };
      const activeRunId = s.activeRunId ?? runId;
      const cursor = activeRunId === runId && s.followLive ? run.frames.length - 1 : s.cursor;
      const perf = activeRunId === runId ? { ...s.perf, received: s.perf.received + frames, dropped: droppedFrames(run) } : s.perf;
      return { runs, activeRunId, cursor, perf };
    });
  },
  setDone: (result) =>
    set((s) => {
      const run = s.runs[result.runId] ?? emptyRun(result.runId);
      return { runs: { ...s.runs, [result.runId]: { ...run, result } } };
    }),
  setActiveRun: (runId) =>
    set((s) => ({
      activeRunId: runId,
      cursor: runId ? (s.runs[runId]?.frames.length ?? 0) - 1 : -1,
      followLive: true,
      playing: false,
      perf: { fps: 0, drawMs: 0, received: runId ? (s.runs[runId]?.frames.length ?? 0) + (s.runs[runId]?.evicted ?? 0) : 0, dropped: runId && s.runs[runId] ? droppedFrames(s.runs[runId]!) : 0 },
    })),
  seek: (index, opts) =>
    set((s) => {
      const run = s.activeRunId ? s.runs[s.activeRunId] : undefined;
      const cursor = clampCursor(run, index);
      return { cursor, followLive: opts?.keepLive ? s.followLive : false };
    }),
  step: (delta) => {
    const s = get();
    s.seek(s.cursor + delta);
    set({ playing: false });
  },
  goLive: () =>
    set((s) => {
      const run = s.activeRunId ? s.runs[s.activeRunId] : undefined;
      return { followLive: true, playing: false, cursor: run ? run.frames.length - 1 : -1 };
    }),
  setPlaying: (playing) => set({ playing, ...(playing ? { followLive: false } : {}) }),
  togglePlaying: () => {
    const s = get();
    const run = s.activeRunId ? s.runs[s.activeRunId] : undefined;
    if (!run || run.frames.length === 0) return;
    if (s.playing) {
      set({ playing: false });
    } else {
      const atEnd = s.cursor >= run.frames.length - 1;
      set({ playing: true, followLive: false, cursor: atEnd ? 0 : Math.max(0, s.cursor) });
    }
  },
  toggleLayer: (layer) =>
    set((s) => ({
      hiddenLayers: s.hiddenLayers.includes(layer) ? s.hiddenLayers.filter((l) => l !== layer) : [...s.hiddenLayers, layer],
    })),
  setPlaybackMs: (playbackMs) => set({ playbackMs }),
  reportDraw: (drawMs) =>
    set((s) => (Math.abs(s.perf.drawMs - drawMs) < 0.5 ? s : { perf: { ...s.perf, drawMs: Math.round(drawMs * 10) / 10 } })),
}));

export type { CinemaRun, RouteFrame, RouteMeta, RouteStatic };
