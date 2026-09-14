/**
 * Catalog preview, or an initials tile when there is none / it fails to load — the phone
 * counterpart of packages/ui/src/opensource/CatalogThumb.tsx. The daemon's preview route takes
 * `?token=` like SSE, so the URL alone authenticates and no header is needed.
 */
import { catalogInitials } from "@fabdesk/protocol";
import { Image } from "expo-image";
import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useTheme } from "@/theme";

export function CatalogThumb({
  uri,
  name,
  size = 44,
  radius = 8,
}: {
  uri: string;
  name: string;
  size?: number;
  radius?: number;
}) {
  const t = useTheme();
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [uri]);
  const frame = {
    width: size,
    height: size,
    borderRadius: radius,
    backgroundColor: t.panel2,
    borderColor: t.border,
    borderWidth: StyleSheet.hairlineWidth,
  } as const;
  if (!uri || failed) {
    return (
      <View style={[frame, { alignItems: "center", justifyContent: "center" }]} accessible={false}>
        <Text
          style={{ color: t.muted, fontSize: size / 3.2, fontWeight: "600", letterSpacing: 0.5 }}
        >
          {catalogInitials(name)}
        </Text>
      </View>
    );
  }
  return (
    <Image
      source={{ uri }}
      style={frame}
      contentFit="cover"
      transition={120}
      onError={() => setFailed(true)}
    />
  );
}
