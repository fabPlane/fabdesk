import type { RouteFrame, RouteFrameLine, RouteMeta, RouteResult, RouteStatic } from "@fabdesk/protocol";
import { create } from "zustand";
import { applyLine, emptyRun, type CinemaRun } from "../board/cinema/renderer";

export interface CinemaState {
  runs: Record<string, CinemaRun>;
  activeRunId: string | null;
  /** Frame index shown; -1 = none yet. */
  cursor: number;
  playing: boolean;
  followLive: boolean;
  hiddenLayers: number[];
  playbackMs: number;
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
}

function clampCursor(run: CinemaRun | undefined, index: number): number {
  if (!run || run.frames.length === 0) return -1;
  return Math.max(0, Math.min(run.frames.length - 1, index));
}

export const useCinemaStore = create<CinemaState>()((set, get) => ({
  runs: {},
  activeRunId: null,
  cursor: -1,
  playing: false,
  followLive: true,
  hiddenLayers: [],
  playbackMs: 120,
  ingest: (line) => {
    set((s) => {
      const prev = s.runs[line.runId] ?? emptyRun(line.runId);
      const next = applyLine(prev, line);
      const runs = { ...s.runs, [line.runId]: next };
      const becomesActive = s.activeRunId === null || line.kind === "meta";
      const activeRunId = becomesActive ? line.runId : s.activeRunId;
      const isActive = activeRunId === line.runId;
      const cursor = isActive && s.followLive ? next.frames.length - 1 : isActive ? clampCursor(next, s.cursor) : s.cursor;
      return { runs, activeRunId, cursor };
    });
  },
  ingestMany: (runId, lines) => {
    set((s) => {
      let run = s.runs[runId] ?? emptyRun(runId);
      for (const line of lines) if (line.runId === runId) run = applyLine(run, line);
      const runs = { ...s.runs, [runId]: run };
      const activeRunId = s.activeRunId ?? runId;
      const cursor = activeRunId === runId && s.followLive ? run.frames.length - 1 : s.cursor;
      return { runs, activeRunId, cursor };
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
}));

export type { CinemaRun, RouteFrame, RouteMeta, RouteStatic };
