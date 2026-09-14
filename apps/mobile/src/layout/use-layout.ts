import { useWindowDimensions } from "react-native";
import { layoutMode, type LayoutMode } from "@/lib/layout-mode";

/** Re-renders on rotation and split-view resizes, so the shell switches live. */
export function useLayoutMode(): LayoutMode {
  const { width, height } = useWindowDimensions();
  return layoutMode({ width, height });
}
