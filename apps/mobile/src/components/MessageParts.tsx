/**
 * Rendering a message's parts, ported from packages/ui/src/chat/MessageList.tsx.
 *
 * The desktop folds consecutive tool_use/tool_result pairs into one collapsible group; a phone
 * needs that even more, since a long agent run is mostly tool calls and the interesting text is
 * buried between them.
 */
import type { Message, MessagePart } from "@fabdesk/protocol";
import { useMemo, useState } from "react";
import { summarizeTools, toBlocks } from "../lib/message-blocks";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Markdown from "react-native-markdown-display";
import { useTheme, type Theme } from "../theme";

function markdownStyles(t: Theme) {
  return {
    body: { color: t.fg, fontSize: 15, lineHeight: 22 },
    code_inline: { backgroundColor: t.panel2, color: t.fg, fontFamily: "Menlo", fontSize: 13 },
    code_block: { backgroundColor: t.panel2, color: t.fg, fontFamily: "Menlo", fontSize: 12, padding: 10, borderRadius: 8 },
    fence: { backgroundColor: t.panel2, color: t.fg, fontFamily: "Menlo", fontSize: 12, padding: 10, borderRadius: 8 },
    link: { color: t.accent },
    blockquote: { backgroundColor: t.panel2, borderLeftColor: t.border, paddingHorizontal: 10 },
    hr: { backgroundColor: t.border },
  } as const;
}

export function MessageBody({ message, streaming }: { message: Message; streaming: boolean }) {
  const t = useTheme();
  const blocks = useMemo(() => toBlocks(message.parts), [message.parts]);
  const md = useMemo(() => markdownStyles(t), [t]);

  if (message.role === "user") {
    return (
      <View style={{ alignItems: "flex-end", paddingHorizontal: 12, paddingVertical: 5 }}>
        <View style={{ backgroundColor: t.panel2, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 9, maxWidth: "88%" }}>
          <Text style={{ color: t.fg, fontSize: 15, lineHeight: 21 }}>{message.contentMd}</Text>
        </View>
      </View>
    );
  }

  if (message.role === "system") {
    return (
      <Text style={{ color: t.muted, fontSize: 12, textAlign: "center", paddingHorizontal: 24, paddingVertical: 8 }}>{message.contentMd}</Text>
    );
  }

  return (
    <View style={{ paddingHorizontal: 14, paddingVertical: 5, gap: 8 }}>
      {blocks.map((block, i) => {
        if (block.kind === "text") {
          return (
            <View key={i}>
              <Markdown style={md as never}>{block.text}</Markdown>
              {streaming && block.last ? <Text style={{ color: t.accent, fontSize: 15 }}>▍</Text> : null}
            </View>
          );
        }
        if (block.kind === "thinking") return <ThinkingBlock key={i} text={block.text} />;
        if (block.kind === "image") {
          return (
            <Text key={i} style={{ color: t.muted, fontSize: 12, fontStyle: "italic" }}>
              🖼 {block.path}
            </Text>
          );
        }
        return <ToolGroup key={i} parts={block.parts} />;
      })}
    </View>
  );
}

function ThinkingBlock({ text }: { text: string }) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  return (
    <Pressable onPress={() => setOpen((o) => !o)}>
      <Text style={{ color: t.muted, fontSize: 12, fontStyle: "italic" }}>{open ? "▾ Thought" : "▸ Thought"}</Text>
      {open ? <Text style={{ color: t.muted, fontSize: 13, lineHeight: 19, marginTop: 4 }}>{text}</Text> : null}
    </Pressable>
  );
}

function ToolGroup({ parts }: { parts: MessagePart[] }) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const summary = useMemo(() => summarizeTools(parts), [parts]);

  return (
    <View style={{ backgroundColor: t.panel, borderColor: t.border, borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, overflow: "hidden" }}>
      <Pressable onPress={() => setOpen((o) => !o)} style={{ flexDirection: "row", alignItems: "center", gap: 6, padding: 10 }}>
        <Text style={{ color: t.muted, fontSize: 12 }}>{open ? "▾" : "▸"}</Text>
        <Text numberOfLines={1} style={{ color: summary.errors ? t.danger : t.muted, fontSize: 12, flex: 1, fontFamily: "Menlo" }}>
          {summary.label}
        </Text>
        {summary.pending ? <Text style={{ color: t.accent, fontSize: 11 }}>running</Text> : null}
        {summary.errors ? <Text style={{ color: t.danger, fontSize: 11 }}>{summary.errors} failed</Text> : null}
      </Pressable>
      {open ? (
        <View style={{ borderTopColor: t.border, borderTopWidth: StyleSheet.hairlineWidth, padding: 10, gap: 8 }}>
          {parts.map((p, i) => (
            <View key={i}>
              <Text style={{ color: t.muted, fontSize: 11, fontWeight: "700" }}>
                {p.type === "tool_use" ? `→ ${p.name}` : "← result"}
              </Text>
              <Text style={{ color: t.fg, fontSize: 11, fontFamily: "Menlo" }} numberOfLines={20}>
                {preview(p)}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function preview(part: MessagePart): string {
  const value = part.type === "tool_use" ? part.input : part.type === "tool_result" ? part.output : null;
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.slice(0, 2000);
  try {
    return JSON.stringify(value, null, 2).slice(0, 2000);
  } catch {
    return String(value);
  }
}
