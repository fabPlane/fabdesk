/**
 * Read-only source view: one FlatList row per line, tones from src/lib/highlight.ts, lines
 * wrapped rather than scrolled sideways (a phone is narrow and the desktop wraps too).
 */
import { useMemo } from "react";
import { FlatList, Text, View } from "react-native";
import type { Language } from "@/lib/file-tree";
import { highlightText, type Tone } from "@/lib/highlight";
import { useTheme, type Theme } from "@/theme";

function toneColor(t: Theme, tone: Tone): string {
  switch (tone) {
    case "keyword":
      return t.accent;
    case "string":
      return t.success;
    case "number":
      return t.warning;
    case "comment":
      return t.muted;
    case "punct":
      return t.muted;
    case "tag":
      return t.dark ? "#93c5fd" : "#1d4ed8";
    case "prop":
      return t.dark ? "#c4b5fd" : "#6d28d9";
    default:
      return t.fg;
  }
}

export function CodeView({ text, language }: { text: string; language: Language }) {
  const t = useTheme();
  const lines = useMemo(() => highlightText(text, language), [text, language]);
  const gutter = String(lines.length).length * 8 + 10;
  return (
    <FlatList
      data={lines}
      keyExtractor={(_l, i) => String(i)}
      initialNumToRender={60}
      windowSize={7}
      contentContainerStyle={{ paddingVertical: 8, paddingRight: 12 }}
      renderItem={({ item, index }) => (
        <View style={{ flexDirection: "row" }}>
          <Text
            selectable={false}
            style={{
              width: gutter,
              textAlign: "right",
              paddingRight: 8,
              color: t.muted,
              fontFamily: "Menlo",
              fontSize: 11,
              lineHeight: 18,
            }}
          >
            {index + 1}
          </Text>
          <Text
            selectable
            style={{ flex: 1, color: t.fg, fontFamily: "Menlo", fontSize: 12, lineHeight: 18 }}
          >
            {item.runs.length === 0
              ? " "
              : item.runs.map((r, i) => (
                  <Text key={i} style={{ color: toneColor(t, r.tone) }}>
                    {r.text}
                  </Text>
                ))}
          </Text>
        </View>
      )}
    />
  );
}
