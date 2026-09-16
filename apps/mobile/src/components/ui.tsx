/** The handful of primitives every screen needs. Deliberately small; no component library. */
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from "react-native";
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

export function Input({ style, ...props }: TextInputProps) {
  const t = useTheme();
  return (
    <TextInput
      placeholderTextColor={t.muted}
      autoCapitalize="none"
      autoCorrect={false}
      disableFullscreenUI
      {...props}
      style={[
        {
          backgroundColor: t.bg,
          borderColor: t.border,
          borderWidth: StyleSheet.hairlineWidth,
          borderRadius: 8,
          color: t.fg,
          paddingHorizontal: 12,
          paddingVertical: 10,
          fontSize: 15,
        },
        style,
      ]}
    />
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  return (
    <View
      style={[
        {
          backgroundColor: t.panel,
          borderColor: t.border,
          borderWidth: StyleSheet.hairlineWidth,
          borderRadius: 12,
          padding: 14,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export function Badge({
  label,
  tone = "default",
}: {
  label: string;
  tone?: "default" | "success" | "danger" | "warning";
}) {
  const t = useTheme();
  const color =
    tone === "success"
      ? t.success
      : tone === "danger"
        ? t.danger
        : tone === "warning"
          ? t.warning
          : t.muted;
  return (
    <View
      style={{
        borderColor: color,
        borderWidth: StyleSheet.hairlineWidth,
        borderRadius: 6,
        paddingHorizontal: 6,
        paddingVertical: 2,
      }}
    >
      <Text style={{ color, fontSize: 11, fontWeight: "600" }}>{label}</Text>
    </View>
  );
}

export function Loading({ label }: { label?: string | undefined }) {
  const t = useTheme();
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 10, padding: 24 }}>
      <ActivityIndicator color={t.muted} />
      {label ? (
        <Text style={{ color: t.muted, fontSize: 13, textAlign: "center" }}>{label}</Text>
      ) : null}
    </View>
  );
}

export function Empty({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string | undefined;
  action?: ReactNode;
}) {
  const t = useTheme();
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 8, padding: 32 }}>
      <Text style={{ color: t.fg, fontSize: 15, fontWeight: "600", textAlign: "center" }}>
        {title}
      </Text>
      {hint ? (
        <Text style={{ color: t.muted, fontSize: 13, textAlign: "center" }}>{hint}</Text>
      ) : null}
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

/** A row of exclusive choices; the selected one is filled. Fits three or four short labels. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  const t = useTheme();
  return (
    <View
      accessibilityRole="radiogroup"
      style={{
        flexDirection: "row",
        backgroundColor: t.panel2,
        borderRadius: 10,
        padding: 3,
        gap: 3,
      }}
    >
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            onPress={() => onChange(o.value)}
            style={({ pressed }) => ({
              flex: 1,
              paddingVertical: 7,
              borderRadius: 8,
              alignItems: "center",
              backgroundColor: selected ? t.panel : "transparent",
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <Text style={{ color: selected ? t.fg : t.muted, fontSize: 13, fontWeight: "600" }}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A labelled switch with an optional line of explanation under the label. */
export function SwitchRow({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string | undefined;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 6 }}>
      <View style={{ flex: 1 }}>
        <Text style={{ color: t.fg, fontSize: 14 }}>{label}</Text>
        {hint ? <Text style={{ color: t.muted, fontSize: 12, marginTop: 2 }}>{hint}</Text> : null}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ true: t.accent, false: t.border }}
        thumbColor={t.panel}
      />
    </View>
  );
}
