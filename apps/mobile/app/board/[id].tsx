/**
 * Full-screen board render with pinch-zoom and pan.
 *
 * v1 shows what the daemon rendered rather than drawing copper on-device: the desktop already has
 * kicad-cli and the file route already serves the PNG, so this is the whole feature. Drawing the
 * board from its data is the follow-up (docs/mobile.md).
 */
import { useLocalSearchParams } from "expo-router";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { StyleSheet, Text, View } from "react-native";
import { RenderImage } from "@/components/RenderImage";
import { Screen } from "@/components/ui";
import { useTheme } from "@/theme";

const MIN_SCALE = 1;
const MAX_SCALE = 8;

export default function BoardScreen() {
  // `v` is the file's mtime: it keys the image cache, so a re-render is not shown from the old copy.
  const { id, path, v } = useLocalSearchParams<{ id: string; path: string; v?: string }>();
  const t = useTheme();
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const savedX = useSharedValue(0);
  const savedY = useSharedValue(0);

  const clamp = (v: number, lo: number, hi: number) => {
    "worklet";
    return Math.min(hi, Math.max(lo, v));
  };

  const pinch = Gesture.Pinch()
    .onUpdate((e) => {
      scale.value = clamp(savedScale.value * e.scale, MIN_SCALE, MAX_SCALE);
    })
    .onEnd(() => {
      savedScale.value = scale.value;
      if (scale.value <= MIN_SCALE) {
        // Back at fit-to-screen there is nothing to pan to; recentre so it cannot be lost offscreen.
        x.value = withTiming(0);
        y.value = withTiming(0);
        savedX.value = 0;
        savedY.value = 0;
      }
    });

  const pan = Gesture.Pan()
    .onUpdate((e) => {
      x.value = savedX.value + e.translationX;
      y.value = savedY.value + e.translationY;
    })
    .onEnd(() => {
      savedX.value = x.value;
      savedY.value = y.value;
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      const next = scale.value > MIN_SCALE * 1.5 ? MIN_SCALE : 3;
      scale.value = withTiming(next);
      savedScale.value = next;
      if (next === MIN_SCALE) {
        x.value = withTiming(0);
        y.value = withTiming(0);
        savedX.value = 0;
        savedY.value = 0;
      }
    });

  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }, { translateY: y.value }, { scale: scale.value }],
  }));

  if (!id || !path) {
    return (
      <Screen>
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <Text style={{ color: t.muted }}>No render to show.</Text>
        </View>
      </Screen>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: t.dark ? "#000" : "#fff" }}>
      <GestureDetector gesture={Gesture.Simultaneous(pinch, pan, doubleTap)}>
        <Animated.View style={[StyleSheet.absoluteFill, style]}>
          <RenderImage
            projectId={id}
            entry={{ path, size: 0, mtime: v ?? "" }}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>
      </GestureDetector>
      <Text
        style={{
          position: "absolute",
          bottom: 28,
          left: 0,
          right: 0,
          textAlign: "center",
          color: t.muted,
          fontSize: 11,
        }}
      >
        {path} · pinch or double-tap to zoom
      </Text>
    </View>
  );
}
