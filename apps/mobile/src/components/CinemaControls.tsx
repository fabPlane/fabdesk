/**
 * Transport for Route Cinema: play/pause, step, a scrub bar, live-follow, speed, view mode, and
 * the layer chips. Dumb: everything is a prop or a callback into the playback reducer.
 */
import { useState } from "react";
import { Pressable, ScrollView, Text, View, type LayoutChangeEvent } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { layerColor, type CinemaView } from "@fabdesk/client-core";
import {
  PLAYBACK_SPEEDS,
  cursorFraction,
  fractionCursor,
  type PlaybackSpeed,
} from "@/lib/cinema-frames";
import { useTheme } from "@/theme";
import { useSafeAreaInsets } from "react-native-safe-area-context";

function Tap({
  label,
  onPress,
  active,
  disabled,
  wide,
}: {
  label: string;
  onPress: () => void;
  active?: boolean;
  disabled?: boolean;
  wide?: boolean;
}) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled, selected: !!active }}
      onPress={onPress}
      disabled={disabled}
      hitSlop={6}
      style={({ pressed }) => ({
        minWidth: wide ? 56 : 40,
        paddingHorizontal: 10,
        paddingVertical: 7,
        borderRadius: 8,
        alignItems: "center",
        backgroundColor: active ? t.accent : t.panel2,
        opacity: disabled ? 0.35 : pressed ? 0.7 : 1,
      })}
    >
      <Text style={{ color: active ? t.accentFg : t.fg, fontSize: 14, fontWeight: "600" }}>
        {label}
      </Text>
    </Pressable>
  );
}

/** A pan-to-seek bar; a tap seeks too (minDistance 0). Runs on the JS thread — seeks are cheap and rare. */
function ScrubBar({
  cursor,
  frames,
  onSeek,
}: {
  cursor: number;
  frames: number;
  onSeek: (index: number) => void;
}) {
  const t = useTheme();
  const [width, setWidth] = useState(0);
  const fraction = cursorFraction(cursor, frames);
  const seekAt = (x: number) => {
    if (width > 0 && frames > 0) onSeek(fractionCursor(x / width, frames));
  };
  const pan = Gesture.Pan()
    .minDistance(0)
    .runOnJS(true)
    .onBegin((e) => seekAt(e.x))
    .onUpdate((e) => seekAt(e.x));
  return (
    <GestureDetector gesture={pan}>
      <View
        style={{ flex: 1, height: 36, justifyContent: "center", paddingHorizontal: 8 }}
        onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width - 16)}
        accessibilityRole="adjustable"
        accessibilityValue={{ min: 0, max: Math.max(0, frames - 1), now: Math.max(0, cursor) }}
      >
        <View style={{ height: 4, borderRadius: 2, backgroundColor: t.border }}>
          <View
            style={{
              height: 4,
              borderRadius: 2,
              backgroundColor: t.accent,
              width: `${fraction * 100}%`,
            }}
          />
        </View>
        <View
          style={{
            position: "absolute",
            left: 8 + fraction * width - 8,
            width: 16,
            height: 16,
            borderRadius: 8,
            backgroundColor: frames > 0 ? t.accent : t.border,
          }}
        />
      </View>
    </GestureDetector>
  );
}

export function CinemaControls({
  frames,
  cursor,
  playing,
  followLive,
  live,
  speed,
  view,
  layers,
  hiddenLayers,
  status,
  perf,
  onTogglePlaying,
  onStep,
  onSeek,
  onGoLive,
  onSpeed,
  onView,
  onToggleLayer,
}: {
  frames: number;
  cursor: number;
  playing: boolean;
  followLive: boolean;
  /** The run is still being routed, so "live" means something. */
  live: boolean;
  speed: PlaybackSpeed;
  view: CinemaView;
  layers: readonly string[];
  hiddenLayers: readonly number[];
  status: string;
  perf: string;
  onTogglePlaying: () => void;
  onStep: (delta: number) => void;
  onSeek: (index: number) => void;
  onGoLive: () => void;
  onSpeed: (speed: PlaybackSpeed) => void;
  onView: (view: CinemaView) => void;
  onToggleLayer: (layer: number) => void;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const speeds = Object.keys(PLAYBACK_SPEEDS) as PlaybackSpeed[];
  const nextSpeed = speeds[(speeds.indexOf(speed) + 1) % speeds.length] ?? "normal";
  return (
    <View
      style={{
        backgroundColor: t.panel,
        borderTopColor: t.border,
        borderTopWidth: 1,
        paddingBottom: 6 + insets.bottom,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          paddingHorizontal: 10,
          paddingTop: 8,
        }}
      >
        <Tap label={playing ? "⏸" : "▶"} onPress={onTogglePlaying} disabled={frames === 0} />
        <Tap label="‹" onPress={() => onStep(-1)} disabled={cursor <= 0} />
        <Tap label="›" onPress={() => onStep(1)} disabled={cursor >= frames - 1} />
        <ScrubBar cursor={cursor} frames={frames} onSeek={onSeek} />
        {live ? <Tap label="live" onPress={onGoLive} active={followLive} wide /> : null}
      </View>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          paddingHorizontal: 10,
          paddingTop: 6,
        }}
      >
        <Tap
          label={view === "activity" ? "follow" : "board"}
          onPress={() => onView(view === "activity" ? "board" : "activity")}
          wide
        />
        <Tap label={speed} onPress={() => onSpeed(nextSpeed)} wide />
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 6, alignItems: "center" }}
          style={{ flex: 1 }}
        >
          {layers.map((name, index) => {
            const off = hiddenLayers.includes(index);
            return (
              <Pressable
                key={name}
                accessibilityRole="button"
                accessibilityState={{ selected: !off }}
                onPress={() => onToggleLayer(index)}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 5,
                  paddingHorizontal: 7,
                  paddingVertical: 4,
                  borderRadius: 6,
                  borderWidth: 1,
                  borderColor: t.border,
                  opacity: off ? 0.35 : 1,
                }}
              >
                <View
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 2,
                    backgroundColor: layerColor(index),
                  }}
                />
                <Text style={{ color: t.fg, fontSize: 11 }}>{name}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>
      <Text
        numberOfLines={1}
        style={{
          color: t.muted,
          fontSize: 11,
          fontFamily: "Menlo",
          paddingHorizontal: 12,
          paddingTop: 6,
        }}
      >
        {status}
      </Text>
      {perf ? (
        <Text
          numberOfLines={1}
          style={{
            color: t.muted,
            fontSize: 11,
            fontFamily: "Menlo",
            paddingHorizontal: 12,
            paddingTop: 2,
          }}
        >
          {perf}
        </Text>
      ) : null}
    </View>
  );
}
