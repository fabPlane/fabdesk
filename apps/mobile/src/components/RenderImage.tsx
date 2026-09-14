/**
 * A render from the project, keyed by its mtime.
 *
 * `renders/top.png` keeps its URL across re-renders, and expo-image caches by URL, so a plain
 * `ProjectImage` keeps showing the old picture after the daemon has replaced the file. Appending
 * the mtime as a query string (the file route ignores it) makes every version its own cache entry.
 */
import type { FileEntry } from "@fabdesk/protocol";
import { Image, type ImageLoadEventData } from "expo-image";
import type { ImageStyle, StyleProp } from "react-native";
import { useProjectFileSource } from "@/components/ProjectImage";

export interface ImageSize {
  width: number;
  height: number;
}

export function RenderImage({
  projectId,
  entry,
  style,
  contentFit = "contain",
  onSize,
}: {
  projectId: string;
  entry: FileEntry;
  style?: StyleProp<ImageStyle>;
  contentFit?: "contain" | "cover";
  /** Intrinsic pixel size, once known — for overlays that must line up with the picture. */
  onSize?: (size: ImageSize) => void;
}) {
  const source = useProjectFileSource(projectId, entry.path);
  if (!source) return null;
  const versioned = { ...source, uri: `${source.uri}?v=${encodeURIComponent(entry.mtime)}` };
  return (
    <Image
      source={versioned}
      style={style}
      contentFit={contentFit}
      transition={120}
      {...(onSize
        ? {
            onLoad: (e: ImageLoadEventData) =>
              onSize({ width: e.source.width, height: e.source.height }),
          }
        : {})}
    />
  );
}
