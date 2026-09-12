/** The handful of primitives every screen needs. Deliberately small; no component library. */
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import type { ReactNode } from "react";
import { useTheme } from "../theme";

export function Button({
  title,
  onPress,
  variant = "default",
  disabled,
  style,
}: {
  title: string;
  onPress: () => void;
  variant?: "default" | "primary" | "danger";
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  const bg = variant === "primary" ? t.accent : variant === "danger" ? t.danger : t.panel2;
  const fg = variant === "default" ? t.fg : t.accentFg;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        {
          backgroundColor: bg,
          opacity: disabled ? 0.4 : pressed ? 0.8 : 1,
          borderRadius: 10,
          paddingVertical: 11,
          paddingHorizontal: 16,
          alignItems: "center",
        },
        style,
      ]}
    >
      <Text style={{ color: fg, fontWeight: "600", fontSize: 15 }}>{title}</Text>
    </Pressable>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  return (
    <View style={[{ backgroundColor: t.panel, borderColor: t.border, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 14 }, style]}>
      {children}
    </View>
  );
}

export function Badge({ label, tone = "default" }: { label: string; tone?: "default" | "success" | "danger" | "warning" }) {
  const t = useTheme();
  const color = tone === "success" ? t.success : tone === "danger" ? t.danger : tone === "warning" ? t.warning : t.muted;
  return (
    <View style={{ borderColor: color, borderWidth: StyleSheet.hairlineWidth, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 }}>
      <Text style={{ color, fontSize: 11, fontWeight: "600" }}>{label}</Text>
    </View>
  );
}

export function Loading({ label }: { label?: string | undefined }) {
  const t = useTheme();
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 10, padding: 24 }}>
      <ActivityIndicator color={t.muted} />
      {label ? <Text style={{ color: t.muted, fontSize: 13, textAlign: "center" }}>{label}</Text> : null}
    </View>
  );
}

export function Empty({ title, hint, action }: { title: string; hint?: string | undefined; action?: ReactNode }) {
  const t = useTheme();
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 8, padding: 32 }}>
      <Text style={{ color: t.fg, fontSize: 15, fontWeight: "600", textAlign: "center" }}>{title}</Text>
      {hint ? <Text style={{ color: t.muted, fontSize: 13, textAlign: "center" }}>{hint}</Text> : null}
      {action}
    </View>
  );
}

export function Screen({ children }: { children: ReactNode }) {
  const t = useTheme();
  return <View style={{ flex: 1, backgroundColor: t.bg }}>{children}</View>;
}

/**
 * Caps content width on wide windows (a landscape handheld, a tablet) so prose lines stay
 * readable; on a phone it is a no-op. Spread into a list's `contentContainerStyle` or a row.
 */
export const readable = { width: "100%", maxWidth: 760, alignSelf: "center" } as const;
