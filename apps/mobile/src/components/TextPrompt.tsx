/**
 * "Type a value" dialog: `Alert.prompt` on iOS, which Android's Alert does not have, so there it is
 * a small modal with one input. Same imperative shape as `useOptionSheet`.
 */
import { useCallback, useState, type ReactNode } from "react";
import { Alert, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useTheme } from "../theme";

export interface PromptSpec {
  title: string;
  message?: string | undefined;
  initial?: string | undefined;
  submitLabel?: string | undefined;
  onSubmit: (value: string) => void;
}

export function useTextPrompt(): { prompt: (spec: PromptSpec) => void; element: ReactNode } {
  const t = useTheme();
  const [spec, setSpec] = useState<PromptSpec | null>(null);
  const [value, setValue] = useState("");

  const prompt = useCallback((next: PromptSpec) => {
    if (Platform.OS === "ios") {
      Alert.prompt(
        next.title,
        next.message,
        [
          { text: "Cancel", style: "cancel" },
          { text: next.submitLabel ?? "OK", onPress: (v?: string) => next.onSubmit(v ?? "") },
        ],
        "plain-text",
        next.initial,
      );
      return;
    }
    setValue(next.initial ?? "");
    setSpec(next);
  }, []);

  const close = () => setSpec(null);
  const submit = () => {
    const s = spec;
    close();
    s?.onSubmit(value);
  };

  const element =
    Platform.OS === "ios" ? null : (
      <Modal visible={!!spec} transparent animationType="fade" onRequestClose={close}>
        <Pressable
          style={{
            flex: 1,
            backgroundColor: "rgba(0,0,0,0.45)",
            justifyContent: "center",
            padding: 24,
          }}
          onPress={close}
        >
          <Pressable
            onPress={() => {}}
            style={{ backgroundColor: t.panel, borderRadius: 14, padding: 18, gap: 10 }}
          >
            <Text style={{ color: t.fg, fontSize: 16, fontWeight: "600" }}>{spec?.title}</Text>
            {spec?.message ? (
              <Text style={{ color: t.muted, fontSize: 13 }}>{spec.message}</Text>
            ) : null}
            <TextInput
              autoFocus
              disableFullscreenUI
              value={value}
              onChangeText={setValue}
              onSubmitEditing={submit}
              returnKeyType="done"
              placeholderTextColor={t.muted}
              style={{
                backgroundColor: t.bg,
                borderColor: t.border,
                borderWidth: StyleSheet.hairlineWidth,
                borderRadius: 8,
                color: t.fg,
                fontSize: 15,
                paddingHorizontal: 12,
                paddingVertical: 9,
              }}
            />
            <View
              style={{ flexDirection: "row", justifyContent: "flex-end", gap: 18, marginTop: 4 }}
            >
              <Pressable onPress={close} hitSlop={8}>
                <Text style={{ color: t.muted, fontSize: 15, fontWeight: "600" }}>Cancel</Text>
              </Pressable>
              <Pressable onPress={submit} hitSlop={8}>
                <Text style={{ color: t.accent, fontSize: 15, fontWeight: "600" }}>
                  {spec?.submitLabel ?? "OK"}
                </Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    );

  return { prompt, element };
}
