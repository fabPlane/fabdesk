/**
 * Before/after wipe between the cached previous render and the current one.
 *
 * Both pictures fill the same box; the current one sits on top inside a clipping view whose width
 * follows a draggable divider, so dragging left reveals what the board looked like before the
 * last run. Both images are given the full box width explicitly — otherwise the clipped one
 * would shrink to fit its clip and the two would no longer line up.
 */
import type { FileEntry } from "@fabdesk/protocol";
import { Image } from "expo-image";
import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { RenderImage } from "@/components/RenderImage";
import type { PreviousRender } from "@/lib/renders";
import { useTheme } from "@/theme";

const HANDLE = 28;

export function RenderCompare({
  projectId,
  entry,
  previous,
  aspectRatio = 4 / 3,
}: {
  projectId: string;
  entry: FileEntry;
  previous: PreviousRender;
  aspectRatio?: number;
}) {
  const t = useTheme();
  const [width, setWidth] = useState(0);
  const x = useSharedValue(0);
  const startX = useSharedValue(0);

  const pan = Gesture.Pan()
    .onStart(() => {
      startX.value = x.value;
    })
    .onUpdate((e) => {
      x.value = Math.min(width, Math.max(0, startX.value + e.translationX));
    });

  const clip = useAnimatedStyle(() => ({ width: x.value }));
  const divider = useAnimatedStyle(() => ({ transform: [{ translateX: x.value - HANDLE / 2 }] }));

  return (
    <View
      onLayout={(e) => {
        const w = e.nativeEvent.layout.width;
        setWidth(w);
        if (x.value === 0) x.value = w / 2;
      }}
      style={{
        width: "100%",
        aspectRatio,
        backgroundColor: t.panel2,
        borderRadius: 8,
        overflow: "hidden",
      }}
    >
      {width > 0 ? (
        <>
          <Image
            source={{ uri: previous.uri }}
            contentFit="contain"
            style={[StyleSheet.absoluteFill, { width }]}
          />
          <Animated.View style={[StyleSheet.absoluteFill, { overflow: "hidden" }, clip]}>
            <RenderImage
              projectId={projectId}
              entry={entry}
              style={[StyleSheet.absoluteFill, { width }]}
            />
          </Animated.View>
          <Label text="before" side="right" />
          <Label text="after" side="left" />
          <GestureDetector gesture={pan}>
            <Animated.View
              style={[
                {
                  position: "absolute",
                  top: 0,
                  bottom: 0,
                  width: HANDLE,
                  alignItems: "center",
                  justifyContent: "center",
                },
                divider,
              ]}
              accessibilityRole="adjustable"
              accessibilityLabel="Before/after divider"
            >
              <View
                style={{
                  position: "absolute",
                  top: 0,
                  bottom: 0,
                  width: 2,
                  backgroundColor: t.accent,
                }}
              />
              <View
                style={{
                  width: HANDLE,
                  height: HANDLE,
                  borderRadius: HANDLE / 2,
                  backgroundColor: t.accent,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Text style={{ color: t.accentFg, fontSize: 12, fontWeight: "700" }}>⇔</Text>
              </View>
            </Animated.View>
          </GestureDetector>
        </>
      ) : null}
    </View>
  );
}

function Label({ text, side }: { text: string; side: "left" | "right" }) {
  const t = useTheme();
  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        top: 8,
        [side]: 8,
        backgroundColor: t.panel,
        borderRadius: 6,
        paddingHorizontal: 6,
        paddingVertical: 2,
        opacity: 0.9,
      }}
    >
      <Text style={{ color: t.muted, fontSize: 11, fontWeight: "600" }}>{text}</Text>
    </View>
  );
}
