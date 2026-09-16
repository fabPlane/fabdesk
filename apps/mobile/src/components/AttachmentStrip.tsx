/**
 * Thumbnails of the photos going out with the next message, above the input. Each shows its
 * upload state: dimmed with a spinner while in flight, a red border when the daemon refused it.
 */
import { Image } from "expo-image";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { PendingAttachment } from "@/lib/attachments";
import { useTheme } from "@/theme";

const SIZE = 64;

export function AttachmentStrip({
  items,
  onRemove,
}: {
  items: readonly PendingAttachment[];
  onRemove: (key: string) => void;
}) {
  const t = useTheme();
  if (items.length === 0) return null;
  return (
    <ScrollView
      horizontal
      keyboardShouldPersistTaps="always"
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: 8, paddingVertical: 4 }}
      style={{ marginBottom: 8 }}
    >
      {items.map((a) => {
        const uploading = !a.path && !a.error;
        return (
          <View key={a.key} style={{ width: SIZE, height: SIZE }}>
            <Image
              source={{ uri: a.localUri }}
              contentFit="cover"
              style={{
                width: SIZE,
                height: SIZE,
                borderRadius: 8,
                opacity: uploading ? 0.5 : 1,
                borderWidth: a.error ? 2 : StyleSheet.hairlineWidth,
                borderColor: a.error ? t.danger : t.border,
              }}
              accessibilityLabel={a.error ? `${a.name}: ${a.error}` : a.name}
            />
            {uploading ? (
              <ActivityIndicator
                color={t.fg}
                style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0 }}
              />
            ) : null}
            <Pressable
              onPress={() => onRemove(a.key)}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={`Remove ${a.name}`}
              style={{
                position: "absolute",
                top: -6,
                right: -6,
                width: 22,
                height: 22,
                borderRadius: 11,
                backgroundColor: t.fg,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Text style={{ color: t.bg, fontSize: 13, fontWeight: "700", lineHeight: 16 }}>
                ×
              </Text>
            </Pressable>
          </View>
        );
      })}
    </ScrollView>
  );
}
