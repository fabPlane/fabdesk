/**
 * A list of choices that slides up from the bottom: the system action sheet on iOS, a plain modal
 * on Android (which has no equivalent in core React Native). One hook for both so the thread menu
 * and the agent picker do not each carry a platform fork.
 *
 * `show()` is imperative, like `Alert.alert`; the returned `sheet` must be rendered somewhere in
 * the tree so the Android modal has a host (it is `null` on iOS).
 */
import { useCallback, useState, type ReactNode } from "react";
import {
  ActionSheetIOS,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../theme";

export interface SheetOption {
  label: string;
  /** Secondary line on Android; folded into the label on iOS, which has one line per row. */
  hint?: string | undefined;
  selected?: boolean | undefined;
  destructive?: boolean | undefined;
  disabled?: boolean | undefined;
  onPress: () => void;
}

export interface SheetSpec {
  title?: string | undefined;
  message?: string | undefined;
  options: SheetOption[];
}

export function useOptionSheet(): { show: (spec: SheetSpec) => void; sheet: ReactNode } {
  const [spec, setSpec] = useState<SheetSpec | null>(null);
  const t = useTheme();
  const insets = useSafeAreaInsets();

  const show = useCallback((next: SheetSpec) => {
    if (Platform.OS === "ios") {
      const labels = next.options.map(
        (o) => `${o.selected ? "✓ " : ""}${o.label}${o.hint ? ` (${o.hint})` : ""}`,
      );
      const destructive = next.options
        .map((o, i) => (o.destructive ? i : -1))
        .filter((i) => i >= 0);
      const disabled = next.options.map((o, i) => (o.disabled ? i : -1)).filter((i) => i >= 0);
      ActionSheetIOS.showActionSheetWithOptions(
        {
          ...(next.title ? { title: next.title } : {}),
          ...(next.message ? { message: next.message } : {}),
          options: [...labels, "Cancel"],
          cancelButtonIndex: labels.length,
          ...(destructive.length ? { destructiveButtonIndex: destructive } : {}),
          ...(disabled.length ? { disabledButtonIndices: disabled } : {}),
        },
        (i) => next.options[i]?.onPress(),
      );
      return;
    }
    setSpec(next);
  }, []);

  const close = () => setSpec(null);
  const sheet =
    Platform.OS === "ios" ? null : (
      <Modal visible={!!spec} transparent animationType="slide" onRequestClose={close}>
        <Pressable style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.45)" }} onPress={close} />
        <View
          style={{
            backgroundColor: t.panel,
            borderTopLeftRadius: 16,
            borderTopRightRadius: 16,
            paddingBottom: Math.max(12, insets.bottom),
            maxHeight: "70%",
          }}
        >
          {spec?.title || spec?.message ? (
            <View style={{ padding: 16, paddingBottom: 8, gap: 2 }}>
              {spec.title ? (
                <Text style={{ color: t.fg, fontSize: 15, fontWeight: "600" }}>{spec.title}</Text>
              ) : null}
              {spec.message ? (
                <Text style={{ color: t.muted, fontSize: 13 }}>{spec.message}</Text>
              ) : null}
            </View>
          ) : null}
          <ScrollView>
            {spec?.options.map((o, i) => (
              <Pressable
                key={i}
                disabled={o.disabled}
                onPress={() => {
                  close();
                  // Let this modal finish sliding out before a handler opens the next one (the
                  // rename prompt, the model step); Android shows only one modal at a time.
                  setTimeout(o.onPress, 250);
                }}
                style={({ pressed }) => ({
                  backgroundColor: pressed ? t.panel2 : "transparent",
                  paddingHorizontal: 16,
                  paddingVertical: 13,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 10,
                  opacity: o.disabled ? 0.4 : 1,
                  borderTopColor: t.border,
                  borderTopWidth: i === 0 ? 0 : StyleSheet.hairlineWidth,
                })}
              >
                <Text style={{ color: t.accent, width: 14, fontSize: 15 }}>
                  {o.selected ? "✓" : ""}
                </Text>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: o.destructive ? t.danger : t.fg, fontSize: 15 }}>
                    {o.label}
                  </Text>
                  {o.hint ? (
                    <Text style={{ color: t.muted, fontSize: 12, marginTop: 1 }}>{o.hint}</Text>
                  ) : null}
                </View>
              </Pressable>
            ))}
          </ScrollView>
          <Pressable
            onPress={close}
            style={({ pressed }) => ({
              marginTop: 6,
              marginHorizontal: 12,
              paddingVertical: 12,
              alignItems: "center",
              borderRadius: 10,
              backgroundColor: pressed ? t.panel2 : t.bg,
            })}
          >
            <Text style={{ color: t.fg, fontSize: 15, fontWeight: "600" }}>Cancel</Text>
          </Pressable>
        </View>
      </Modal>
    );

  return { show, sheet };
}
