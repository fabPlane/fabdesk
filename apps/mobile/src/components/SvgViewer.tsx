/**
 * A pinch/pan/double-tap host for an SVG string — the phone's `packages/ui/src/board/SvgViewer.tsx`.
 *
 * Small drawings render natively with `SvgXml`, which re-parses the string on every prop change:
 * that is what makes layer toggles free, and what makes a multi-megabyte board too slow to touch.
 * Past `SVG_NATIVE_MAX_CHARS` the drawing goes into a WebView instead, where the browser's own
 * pinch-zoom takes over (no layer toggles on that path — the page is static).
 */
import { useMemo, useState } from "react";
import { StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { SvgXml } from "react-native-svg";
import { WebView } from "react-native-webview";
import { ensureViewBox, fitSize, svgSize, svgWebViewHtml, type SvgSize } from "@/lib/svg-layers";
import { useTheme } from "@/theme";

const MIN_SCALE = 1;
const MAX_SCALE = 12;

/** Same gesture set as `app/board/[id].tsx`, on a measured box instead of an absolute-fill image. */
function useZoomPan() {
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const savedX = useSharedValue(0);
  const savedY = useSharedValue(0);

  const recentre = () => {
    "worklet";
    x.value = withTiming(0);
    y.value = withTiming(0);
    savedX.value = 0;
    savedY.value = 0;
  };

  const pinch = Gesture.Pinch()
    .onUpdate((e) => {
      scale.value = Math.min(MAX_SCALE, Math.max(MIN_SCALE, savedScale.value * e.scale));
    })
    .onEnd(() => {
      savedScale.value = scale.value;
      if (scale.value <= MIN_SCALE) recentre();
    });

  const pan = Gesture.Pan()
    .minPointers(1)
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
      if (next === MIN_SCALE) recentre();
    });

  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }, { translateY: y.value }, { scale: scale.value }],
  }));

  return { gesture: Gesture.Simultaneous(pinch, pan, doubleTap), style };
}

export function SvgViewer({
  xml: rawXml,
  background,
  caption,
}: {
  xml: string;
  background: string;
  caption?: string | undefined;
}) {
  const t = useTheme();
  const { gesture, style } = useZoomPan();
  const [box, setBox] = useState<SvgSize | null>(null);
  const xml = useMemo(() => ensureViewBox(rawXml), [rawXml]);
  const natural = svgSize(xml);
  const fitted = box && natural ? fitSize(natural, box) : box;

  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (width > 0 && height > 0) setBox({ width, height });
  };

  return (
    <View style={{ flex: 1, backgroundColor: background }}>
      <View style={{ flex: 1 }} onLayout={onLayout}>
        {fitted ? (
          <GestureDetector gesture={gesture}>
            <Animated.View
              style={[
                StyleSheet.absoluteFill,
                { alignItems: "center", justifyContent: "center" },
                style,
              ]}
            >
              <SvgXml xml={xml} width={fitted.width} height={fitted.height} />
            </Animated.View>
          </GestureDetector>
        ) : null}
      </View>
      {caption ? <Caption text={caption} color={t.muted} /> : null}
    </View>
  );
}

/** The large-drawing path: the browser owns zoom, so there is nothing to animate here. */
export function SvgWebViewer({
  xml,
  background,
  caption,
}: {
  xml: string;
  background: string;
  caption?: string | undefined;
}) {
  const t = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: background }}>
      <WebView
        originWhitelist={["*"]}
        source={{ html: svgWebViewHtml(xml, background) }}
        style={{ flex: 1, backgroundColor: background }}
        scalesPageToFit
        setBuiltInZoomControls
        setDisplayZoomControls={false}
        javaScriptEnabled={false}
        scrollEnabled
      />
      {caption ? <Caption text={caption} color={t.muted} /> : null}
    </View>
  );
}

function Caption({ text, color }: { text: string; color: string }) {
  return (
    <Text
      pointerEvents="none"
      style={{
        position: "absolute",
        bottom: 28,
        left: 0,
        right: 0,
        textAlign: "center",
        color,
        fontSize: 11,
      }}
    >
      {text}
    </Text>
  );
}
