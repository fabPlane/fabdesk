/**
 * The Route Cinema picture: a Skia `<Canvas>` fed one `SkPicture` per frame by `SkiaCinema`.
 * The wrapping View owns the size; the painter is rebuilt when it (or the pixel ratio) changes.
 */
import { Canvas, Picture } from "@shopify/react-native-skia";
import { useEffect, useMemo, useRef, useState } from "react";
import { PixelRatio, StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { DARK_THEME, LIGHT_THEME, type CinemaRun, type CinemaView } from "@fabdesk/client-core";
import { SkiaCinema, type PaintedFrame } from "./CinemaSkia";
import { useTheme } from "@/theme";

export function CinemaCanvas({
  run,
  cursor,
  hiddenLayers,
  view,
  onPainted,
}: {
  run: CinemaRun;
  cursor: number;
  hiddenLayers: readonly number[];
  view: CinemaView;
  onPainted?: ((frame: PaintedFrame) => void) | undefined;
}) {
  const t = useTheme();
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const cinema = useRef<SkiaCinema | null>(null);
  const [picture, setPicture] = useState<PaintedFrame["picture"] | null>(null);
  // The callback is read through a ref so a new closure per render does not repaint.
  const painted = useRef(onPainted);
  painted.current = onPainted;
  const hiddenKey = hiddenLayers.join(",");
  const hidden = useMemo<ReadonlySet<number>>(
    () => new Set(hiddenKey ? hiddenKey.split(",").map(Number) : []),
    [hiddenKey],
  );

  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (width > 0 && height > 0 && (size?.width !== width || size?.height !== height))
      setSize({ width, height });
  };

  useEffect(() => {
    if (!size) return;
    const pr = PixelRatio.get();
    if (!cinema.current || !cinema.current.fits(size.width, size.height, pr))
      cinema.current = new SkiaCinema(size.width, size.height, pr);
    const frame = cinema.current.paint({
      run,
      cursor,
      hiddenLayers: hidden,
      theme: t.dark ? DARK_THEME : LIGHT_THEME,
      view,
    });
    setPicture(frame.picture);
    painted.current?.(frame);
  }, [size, run, cursor, hidden, view, t.dark]);

  return (
    <View style={{ flex: 1 }} onLayout={onLayout}>
      {size && picture ? (
        <Canvas style={StyleSheet.absoluteFill}>
          <Picture picture={picture} />
        </Canvas>
      ) : null}
    </View>
  );
}
