/**
 * Route Cinema for one routing run — the phone's `packages/ui/src/board/cinema/CinemaTab.tsx`.
 *
 * A finished run is loaded whole from `/route/runs/:id/frames` and scrubbed or played. A running
 * one is followed live: `route.*` events reach the screen through client-core's `routeFrameHub`
 * (when the provider passes it as the route sink), and a slow catch-up poll on
 * `/frames?from=<next seq>` fills any gap — a reconnect, frames the bus throttled, or a provider
 * that has no hub wired at all. Frames dedupe by `seq`, so the two sources never double up.
 */
import {
  frameStatusText,
  nextFrameSeq,
  perfStatusText,
  routeFrameHub,
  useCoreClient,
  useRouteRun,
  useRouteRunFrames,
  type CinemaView,
} from "@fabdesk/client-core";
import { Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Text, View } from "react-native";
import { CinemaCanvas } from "@/components/CinemaCanvas";
import { CinemaControls } from "@/components/CinemaControls";
import type { PaintedFrame } from "@/components/CinemaSkia";
import { Empty, Loading, Screen } from "@/components/ui";
import {
  PLAYBACK_SPEEDS,
  cinemaReducer,
  droppedFrames,
  initialPlayback,
  type PlaybackSpeed,
} from "@/lib/cinema-frames";
import { useTheme } from "@/theme";

const CATCH_UP_MS = 1500;

export default function CinemaScreen() {
  const { runId } = useLocalSearchParams<{ runId: string }>();
  const t = useTheme();
  const client = useCoreClient();
  const record = useRouteRun(runId ?? null);
  const initial = useRouteRunFrames(runId ?? null, {
    final: record.data !== undefined && record.data.status !== "running",
  });
  const [s, dispatch] = useReducer(cinemaReducer, runId ?? "", initialPlayback);
  const [speed, setSpeed] = useState<PlaybackSpeed>("normal");
  const [view, setView] = useState<CinemaView>("activity");
  const [draw, setDraw] = useState({ drawMs: 0, shapes: 0 });
  const fps = useRef({ value: 0, lastAt: 0 });
  const [fpsShown, setFpsShown] = useState(0);
  const run = useRef(s.run);
  run.current = s.run;

  const running = record.data?.status === "running";

  // `primed` flips in the same commit as the first ingest, so effects keyed on it see the frames.
  const [primed, setPrimed] = useState(false);
  useEffect(() => {
    if (!initial.data) return;
    dispatch({ type: "ingest", lines: initial.data });
    setPrimed(true);
  }, [initial.data]);

  const result = record.data?.result ?? null;
  useEffect(() => {
    if (result) dispatch({ type: "done", result });
  }, [result]);

  /** Frames since the newest one held, straight from the daemon. */
  const catchUp = useCallback(async () => {
    if (!runId) return;
    try {
      const lines = await client.routeFrames(runId, nextFrameSeq(run.current));
      if (lines.length > 0) dispatch({ type: "ingest", lines });
    } catch {
      // The next poll, or the record's own refetch, will try again.
    }
  }, [client, runId]);

  // Live frames from the event stream. The rate readout is an EMA over inter-arrival times.
  useEffect(() => {
    if (!running || !runId) return;
    return routeFrameHub.subscribe(
      (line) => {
        if (line.runId !== runId) return;
        if (line.kind === "frame") {
          const now = Date.now();
          const f = fps.current;
          if (f.lastAt > 0) {
            const instant = 1000 / Math.max(1, now - f.lastAt);
            f.value = f.value === 0 ? instant : f.value * 0.8 + instant * 0.2;
            setFpsShown(Math.round(f.value * 10) / 10);
          }
          f.lastAt = now;
        }
        dispatch({ type: "ingest", lines: [line] });
      },
      (done) => {
        if (done.runId !== runId) return;
        dispatch({ type: "done", result: done });
        void record.refetch();
      },
    );
  }, [running, runId, record.refetch]);

  // Catch-up poll while routing; one sweep whenever the run is (or becomes) finished, which also
  // completes a set of frames react-query cached while the run was still going.
  const known = record.data !== undefined;
  useEffect(() => {
    if (!primed || !known) return;
    if (!running) {
      void catchUp();
      return;
    }
    const id = setInterval(() => void catchUp(), CATCH_UP_MS);
    return () => clearInterval(id);
  }, [primed, known, running, catchUp]);

  useEffect(() => {
    if (!s.playing) return;
    const id = setInterval(() => dispatch({ type: "tick" }), PLAYBACK_SPEEDS[speed]);
    return () => clearInterval(id);
  }, [s.playing, speed]);

  const onPainted = useCallback(
    (f: PaintedFrame) => setDraw({ drawMs: f.drawMs, shapes: f.shapes }),
    [],
  );

  if (!runId) return <Screen>{null}</Screen>;
  if (record.isError) {
    return (
      <Screen>
        <Stack.Screen options={{ title: "Route run" }} />
        <Empty title="Run not found" hint="The daemon no longer has this routing run." />
      </Screen>
    );
  }
  if (initial.isLoading || (record.isLoading && !record.data))
    return <Loading label="Loading frames…" />;

  const frames = s.run.frames.length;
  const status = frameStatusText(s.run, s.cursor);
  const perf = perfStatusText(
    { fps: running ? fpsShown : 0, drawMs: draw.drawMs, dropped: droppedFrames(s.run) },
    draw.shapes,
  );
  const title = `Route run ${runId.slice(0, 8)}${running ? " · routing" : ""}`;

  return (
    <Screen>
      <Stack.Screen options={{ title }} />
      <View style={{ flex: 1 }}>
        <CinemaCanvas
          run={s.run}
          cursor={s.cursor}
          hiddenLayers={s.hiddenLayers}
          view={view}
          onPainted={onPainted}
        />
        {frames === 0 ? (
          <View
            pointerEvents="none"
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              top: 0,
              bottom: 0,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text style={{ color: t.muted, fontSize: 13 }}>
              {running ? "Waiting for the first frame…" : "This run produced no frames."}
            </Text>
          </View>
        ) : null}
      </View>
      <CinemaControls
        frames={frames}
        cursor={s.cursor}
        playing={s.playing}
        followLive={s.followLive}
        live={!!running}
        speed={speed}
        view={view}
        layers={s.run.meta?.layers ?? []}
        hiddenLayers={s.hiddenLayers}
        status={status}
        perf={perf}
        onTogglePlaying={() => dispatch({ type: "togglePlaying" })}
        onStep={(delta) => dispatch({ type: "step", delta })}
        onSeek={(index) => dispatch({ type: "seek", index })}
        onGoLive={() => dispatch({ type: "goLive" })}
        onSpeed={setSpeed}
        onView={setView}
        onToggleLayer={(layer) => dispatch({ type: "toggleLayer", layer })}
      />
    </Screen>
  );
}
