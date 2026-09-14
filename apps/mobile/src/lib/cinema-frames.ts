/**
 * Playback state for one routing run on the phone — the reducer behind `app/cinema/[runId].tsx`.
 *
 * The desktop keeps every run in a zustand store (`packages/ui/src/stores/cinema.ts`); the phone
 * shows one run per screen, so its state is a plain reducer with the same rules: frames arrive in
 * `seq` order and are capped, the cursor follows live until the user scrubs, playing steps until
 * the last frame. Pure so Bun can test it; the painter it feeds is `@fabdesk/client-core`'s.
 */
import { applyLines, emptyRun, type CinemaRun } from "@fabdesk/client-core";
import type { RouteFrame, RouteFrameLine, RouteResult } from "@fabdesk/protocol";

/**
 * Frames kept per run. Each frame carries every router shape so far, so memory is frames × shapes;
 * a phone gets fewer than the desktop's 400. `pass-start`/`done` frames survive the cap so the
 * scrub bar still spans the whole run.
 */
export const MAX_FRAMES = 300;

export const PLAYBACK_SPEEDS = { slow: 400, normal: 120, fast: 30 } as const;
export type PlaybackSpeed = keyof typeof PLAYBACK_SPEEDS;

export interface CinemaPlayback {
  run: CinemaRun;
  /** Frame index shown; -1 = none yet. */
  cursor: number;
  playing: boolean;
  /** Cursor jumps to each new frame as it arrives (until the user scrubs or plays). */
  followLive: boolean;
  hiddenLayers: number[];
  /** Frames ingested for this run, before eviction. */
  received: number;
}

export type CinemaAction =
  | { type: "ingest"; lines: readonly RouteFrameLine[] }
  | { type: "done"; result: RouteResult }
  | { type: "seek"; index: number }
  | { type: "step"; delta: number }
  | { type: "togglePlaying" }
  /** The playback timer fired: advance one frame, or stop at the end. */
  | { type: "tick" }
  | { type: "goLive" }
  | { type: "toggleLayer"; layer: number };

export function initialPlayback(runId: string): CinemaPlayback {
  return {
    run: emptyRun(runId),
    cursor: -1,
    playing: false,
    followLive: true,
    hiddenLayers: [],
    received: 0,
  };
}

function clampCursor(run: CinemaRun, index: number): number {
  if (run.frames.length === 0) return -1;
  return Math.max(0, Math.min(run.frames.length - 1, index));
}

/** Drops the oldest non-structural frames beyond `max`; the run is returned as-is when under the cap. */
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

/** Frames the router numbered but this client never saw (throttled upstream, or missed while away). */
export function droppedFrames(run: CinemaRun): number {
  const last = run.frames[run.frames.length - 1];
  if (!last) return 0;
  return Math.max(0, last.seq - (run.frames.length + (run.evicted ?? 0)));
}

export function cinemaReducer(s: CinemaPlayback, a: CinemaAction): CinemaPlayback {
  switch (a.type) {
    case "ingest": {
      const mine = a.lines.filter((l) => l.runId === s.run.runId);
      if (mine.length === 0) return s;
      const before = s.run.frames.length;
      const run = capFrames(applyLines(s.run, mine));
      // Count what applyLines actually kept, so duplicates from a catch-up fetch are not counted twice.
      const added = run.frames.length + (run.evicted ?? 0) - (before + (s.run.evicted ?? 0));
      const cursor = s.followLive ? run.frames.length - 1 : clampCursor(run, s.cursor);
      return { ...s, run, cursor, received: s.received + Math.max(0, added) };
    }
    case "done":
      return a.result.runId === s.run.runId ? { ...s, run: { ...s.run, result: a.result } } : s;
    case "seek":
      return { ...s, cursor: clampCursor(s.run, a.index), followLive: false };
    case "step":
      return {
        ...s,
        cursor: clampCursor(s.run, s.cursor + a.delta),
        followLive: false,
        playing: false,
      };
    case "togglePlaying": {
      if (s.run.frames.length === 0) return s;
      if (s.playing) return { ...s, playing: false };
      const atEnd = s.cursor >= s.run.frames.length - 1;
      return { ...s, playing: true, followLive: false, cursor: atEnd ? 0 : Math.max(0, s.cursor) };
    }
    case "tick": {
      if (!s.playing) return s;
      if (s.cursor >= s.run.frames.length - 1) return { ...s, playing: false };
      return { ...s, cursor: s.cursor + 1 };
    }
    case "goLive":
      return { ...s, followLive: true, playing: false, cursor: s.run.frames.length - 1 };
    case "toggleLayer":
      return {
        ...s,
        hiddenLayers: s.hiddenLayers.includes(a.layer)
          ? s.hiddenLayers.filter((l) => l !== a.layer)
          : [...s.hiddenLayers, a.layer],
      };
    default:
      return s;
  }
}

/** Where the scrub bar's thumb sits for `cursor` (0..1), and the inverse for a touch at `fraction`. */
export function cursorFraction(cursor: number, frames: number): number {
  if (frames <= 1 || cursor < 0) return 0;
  return cursor / (frames - 1);
}

export function fractionCursor(fraction: number, frames: number): number {
  if (frames === 0) return -1;
  const f = Math.min(1, Math.max(0, fraction));
  return Math.round(f * (frames - 1));
}
