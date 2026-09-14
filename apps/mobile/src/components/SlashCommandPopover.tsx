/**
 * The list that appears above the composer once the draft starts with `/`: a row per matching
 * command (or per argument once the name is complete), tap to run. In a chat without a project
 * it says why there is nothing to offer. The toast is the line under the composer that follows a
 * command: progress, then the result, with a tap through to Jobs.
 */
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { SlashCommand, SlashSuggestion } from "@/lib/slash-commands";
import { useTheme } from "@/theme";

export function SlashCommandPopover({
  suggestions,
  blocked,
  onPick,
}: {
  suggestions: readonly SlashSuggestion[];
  blocked: string | null;
  onPick: (command: SlashCommand) => void;
}) {
  const t = useTheme();
  if (!blocked && suggestions.length === 0) return null;
  return (
    <View
      accessibilityRole="menu"
      style={{
        marginBottom: 8,
        backgroundColor: t.bg,
        borderColor: t.border,
        borderWidth: StyleSheet.hairlineWidth,
        borderRadius: 12,
        overflow: "hidden",
      }}
    >
      {blocked ? (
        <Text style={{ color: t.muted, fontSize: 13, padding: 12 }}>{blocked}</Text>
      ) : (
        suggestions.map((s, i) => (
          <Pressable
            key={s.usage}
            onPress={() => onPick(s.command)}
            accessibilityRole="menuitem"
            accessibilityLabel={`${s.usage}: ${s.description}`}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
              paddingHorizontal: 12,
              paddingVertical: 10,
              backgroundColor: pressed ? t.panel2 : "transparent",
              borderTopColor: t.border,
              borderTopWidth: i === 0 ? 0 : StyleSheet.hairlineWidth,
            })}
          >
            <Text style={{ color: t.fg, fontSize: 13, fontFamily: "Menlo", flexShrink: 0 }}>
              {s.usage}
            </Text>
            <Text numberOfLines={1} style={{ color: t.muted, fontSize: 12, flex: 1 }}>
              {s.description}
            </Text>
          </Pressable>
        ))
      )}
    </View>
  );
}

export function SlashToast({
  toast,
  onOpenJobs,
  onDismiss,
}: {
  toast: { text: string; tone: "muted" | "success" | "danger"; jobsHint: boolean } | null;
  onOpenJobs: () => void;
  onDismiss: () => void;
}) {
  const t = useTheme();
  if (!toast) return null;
  const color = toast.tone === "success" ? t.success : toast.tone === "danger" ? t.danger : t.muted;
  return (
    <Pressable
      onPress={toast.jobsHint ? onOpenJobs : onDismiss}
      accessibilityRole="button"
      accessibilityLabel={toast.jobsHint ? `${toast.text}. Open Jobs` : toast.text}
      style={{ paddingTop: 8, paddingHorizontal: 4 }}
    >
      <Text numberOfLines={2} style={{ color, fontSize: 12 }}>
        {toast.text}
        {toast.jobsHint ? " ›" : ""}
      </Text>
    </Pressable>
  );
}
