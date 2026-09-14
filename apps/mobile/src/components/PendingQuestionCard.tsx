/**
 * The agent asked something. With options it is a row of buttons (plus "type an answer" for
 * something else); without, a text field and Send. Once answered — here or on the desktop — the
 * card shows the answer.
 */
import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { cleanAnswer, type QuestionPart } from "@/lib/pending-requests";
import { useTheme } from "@/theme";

export function PendingQuestionCard({
  part,
  busy,
  onAnswer,
}: {
  part: QuestionPart;
  busy: boolean;
  onAnswer: (requestId: string, answer: string) => void;
}) {
  const t = useTheme();
  const [text, setText] = useState("");
  const [custom, setCustom] = useState(false);
  const answered = part.answer !== null;
  const options = part.options ?? [];
  const showField = answered ? false : options.length === 0 || custom;
  const cleaned = cleanAnswer(text);
  const accent = answered ? t.muted : t.accent;

  return (
    <View
      style={{
        backgroundColor: t.panel,
        borderColor: accent,
        borderWidth: StyleSheet.hairlineWidth,
        borderLeftWidth: 3,
        borderRadius: 10,
        padding: 10,
        gap: 8,
      }}
    >
      <Text style={{ color: accent, fontSize: 11, fontWeight: "700" }}>
        {answered ? "QUESTION" : "NEEDS AN ANSWER"}
      </Text>
      <Text style={{ color: t.fg, fontSize: 14, lineHeight: 20 }}>{part.question}</Text>
      {answered ? (
        <Text style={{ color: t.success, fontSize: 13 }}>✓ {part.answer}</Text>
      ) : (
        <>
          {options.length > 0 && !custom ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {options.map((o) => (
                <Pressable
                  key={o}
                  disabled={busy}
                  onPress={() => onAnswer(part.requestId, o)}
                  accessibilityRole="button"
                  style={({ pressed }) => ({
                    paddingHorizontal: 14,
                    paddingVertical: 8,
                    borderRadius: 16,
                    backgroundColor: pressed ? t.panel2 : t.bg,
                    borderColor: t.accent,
                    borderWidth: 1,
                    opacity: busy ? 0.5 : 1,
                  })}
                >
                  <Text style={{ color: t.accent, fontWeight: "600", fontSize: 14 }}>{o}</Text>
                </Pressable>
              ))}
              <Pressable
                disabled={busy}
                onPress={() => setCustom(true)}
                accessibilityRole="button"
                style={{ paddingHorizontal: 6, paddingVertical: 8 }}
              >
                <Text style={{ color: t.muted, fontSize: 13 }}>or type an answer…</Text>
              </Pressable>
            </View>
          ) : null}
          {showField ? (
            <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8 }}>
              <TextInput
                disableFullscreenUI
                value={text}
                onChangeText={setText}
                placeholder="Your answer"
                placeholderTextColor={t.muted}
                multiline
                editable={!busy}
                style={{
                  flex: 1,
                  backgroundColor: t.bg,
                  borderColor: t.border,
                  borderWidth: StyleSheet.hairlineWidth,
                  borderRadius: 14,
                  color: t.fg,
                  fontSize: 14,
                  maxHeight: 100,
                  paddingHorizontal: 12,
                  paddingTop: 8,
                  paddingBottom: 8,
                }}
              />
              <Pressable
                disabled={busy || !cleaned}
                onPress={() => cleaned && onAnswer(part.requestId, cleaned)}
                accessibilityRole="button"
                accessibilityLabel="Send answer"
                style={{
                  backgroundColor: t.accent,
                  opacity: busy || !cleaned ? 0.4 : 1,
                  borderRadius: 14,
                  paddingHorizontal: 14,
                  paddingVertical: 9,
                }}
              >
                <Text style={{ color: t.accentFg, fontWeight: "700", fontSize: 13 }}>Send</Text>
              </Pressable>
            </View>
          ) : null}
          {busy ? <ActivityIndicator color={t.muted} style={{ alignSelf: "flex-start" }} /> : null}
        </>
      )}
    </View>
  );
}
