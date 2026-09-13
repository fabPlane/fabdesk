/**
 * The top render with markers where a DRC violation's items sit. The mapping from board mm to
 * the picture is `renderPoint` (src/lib/drc.ts); the image is `contain`-fitted, so its painted
 * rectangle inside the box is worked out with `containedRect` before the markers are placed.
 */
import type { FileEntry } from "@fabdesk/protocol";
import { useState } from "react";
import { Text, View, useWindowDimensions } from "react-native";
import { RenderImage, type ImageSize } from "@/components/RenderImage";
import { containedRect, renderPoint, type Bbox, type ViolationItem } from "@/lib/drc";
import { useTheme } from "@/theme";

const MARKER = 22;

export function DrcRender({
  projectId,
  entry,
  outline,
  items,
  view = "top",
}: {
  projectId: string;
  entry: FileEntry;
  outline: Bbox | null;
  items: ViolationItem[];
  view?: "top" | "bottom";
}) {
  const t = useTheme();
  const window = useWindowDimensions();
  const [image, setImage] = useState<ImageSize | null>(null);
  const [box, setBox] = useState<ImageSize | null>(null);
  const rect = image && box ? containedRect(image, box) : null;
  const positioned = items.filter((it) => it.pos);
  const markers =
    rect && outline
      ? positioned
          .map((it, i) => ({ i, at: renderPoint(it.pos!, outline, image!, view) }))
          .filter((m) => m.at)
      : [];

  return (
    <View>
      <View
        onLayout={(e) =>
          setBox({ width: e.nativeEvent.layout.width, height: e.nativeEvent.layout.height })
        }
        style={{
          width: "100%",
          aspectRatio: 4 / 3,
          // A short landscape window (a handheld) would otherwise give the whole screen to the
          // picture and push the first violation below the fold; markers stay correct because they
          // are placed from the measured box, not the aspect ratio.
          maxHeight: Math.round(window.height * 0.45),
          alignSelf: "center",
          borderRadius: 8,
          overflow: "hidden",
          backgroundColor: t.panel2,
        }}
      >
        <RenderImage
          projectId={projectId}
          entry={entry}
          style={{ width: "100%", height: "100%" }}
          onSize={setImage}
        />
        {rect
          ? markers.map(({ i, at }) => (
              <View
                key={i}
                pointerEvents="none"
                style={{
                  position: "absolute",
                  left: rect.x + at!.fx * rect.width - MARKER / 2,
                  top: rect.y + at!.fy * rect.height - MARKER / 2,
                  width: MARKER,
                  height: MARKER,
                  borderRadius: MARKER / 2,
                  borderWidth: 2.5,
                  borderColor: t.danger,
                  backgroundColor: "rgba(239, 68, 68, 0.25)",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Text style={{ color: t.danger, fontSize: 10, fontWeight: "700" }}>{i + 1}</Text>
              </View>
            ))
          : null}
      </View>
      {items.length > 0 && !outline ? (
        <Text style={{ color: t.muted, fontSize: 11, marginTop: 4 }}>
          No board outline found, so positions cannot be placed on the render.
        </Text>
      ) : items.length > 0 && positioned.length === 0 ? (
        <Text style={{ color: t.muted, fontSize: 11, marginTop: 4 }}>
          This finding has no position.
        </Text>
      ) : null}
    </View>
  );
}
