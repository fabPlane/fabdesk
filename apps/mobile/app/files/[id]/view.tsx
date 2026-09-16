/**
 * One project file: an image, rendered markdown (with a source toggle), highlighted text, or a
 * line saying why it cannot be shown. Text files get a pencil that opens the editor.
 */
import { useProject, useProjectText } from "@fabdesk/client-core";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import Markdown from "react-native-markdown-display";
import { CodeView } from "@/components/CodeView";
import { RenderImage } from "@/components/RenderImage";
import { Empty, Loading, Screen } from "@/components/ui";
import { MAX_TEXT_BYTES, fileKind, isEditable, languageFor } from "@/lib/file-tree";
import { formatBytes, relativeTime } from "@/lib/format";
import { useTheme, type Theme } from "@/theme";

function markdownStyles(t: Theme) {
  return {
    body: { color: t.fg, fontSize: 15, lineHeight: 22 },
    heading1: { color: t.fg, fontSize: 22, fontWeight: "700", marginTop: 12, marginBottom: 6 },
    heading2: { color: t.fg, fontSize: 18, fontWeight: "700", marginTop: 12, marginBottom: 4 },
    heading3: { color: t.fg, fontSize: 16, fontWeight: "600", marginTop: 10, marginBottom: 4 },
    code_inline: { backgroundColor: t.panel2, color: t.fg, fontFamily: "Menlo", fontSize: 13 },
    code_block: {
      backgroundColor: t.panel2,
      color: t.fg,
      fontFamily: "Menlo",
      fontSize: 12,
      padding: 10,
      borderRadius: 8,
    },
    fence: {
      backgroundColor: t.panel2,
      color: t.fg,
      fontFamily: "Menlo",
      fontSize: 12,
      padding: 10,
      borderRadius: 8,
    },
    link: { color: t.accent },
    blockquote: { backgroundColor: t.panel2, borderLeftColor: t.border, paddingHorizontal: 10 },
    hr: { backgroundColor: t.border },
    table: { borderColor: t.border },
    tr: { borderColor: t.border },
  } as const;
}

export default function FileViewScreen() {
  const { id, path } = useLocalSearchParams<{ id: string; path: string }>();
  const t = useTheme();
  const project = useProject(id ?? null);
  const entry = useMemo(
    () => project.data?.files.find((f) => f.path === path) ?? null,
    [project.data, path],
  );
  const kind = path ? fileKind(path) : "binary";
  const tooBig = !!entry && entry.size > MAX_TEXT_BYTES;
  const wantText = !!entry && !tooBig && (kind === "text" || kind === "markdown");
  const text = useProjectText(id ?? null, wantText ? path! : null);
  const [raw, setRaw] = useState(false);
  const md = useMemo(() => markdownStyles(t), [t]);
  const name = path ? path.slice(path.lastIndexOf("/") + 1) : "File";
  const editable = !!entry && isEditable(entry.path, entry.size);

  const header = (
    <Stack.Screen
      options={{
        title: name,
        headerRight: () =>
          editable && id && path ? (
            <Pressable
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="Edit file"
              onPress={() => router.push({ pathname: "/files/[id]/edit", params: { id, path } })}
            >
              <Text style={{ color: t.accent, fontSize: 16 }}>✎ Edit</Text>
            </Pressable>
          ) : null,
      }}
    />
  );

  if (project.isLoading) return <Loading label="Loading…" />;
  if (!id || !path || !entry) {
    return (
      <Screen>
        {header}
        <Empty
          title="File not found"
          hint={path ? `${path} is not in this project any more.` : undefined}
        />
      </Screen>
    );
  }

  const meta = (
    <View style={{ flexDirection: "row", gap: 8, paddingHorizontal: 14, paddingVertical: 8 }}>
      <Text
        numberOfLines={1}
        style={{ color: t.muted, fontSize: 11, flex: 1, fontFamily: "Menlo" }}
      >
        {entry.path}
      </Text>
      <Text style={{ color: t.muted, fontSize: 11 }}>
        {formatBytes(entry.size)} · {relativeTime(entry.mtime)}
      </Text>
    </View>
  );

  let body;
  if (kind === "image") {
    body = (
      <Pressable
        accessibilityRole="imagebutton"
        accessibilityLabel="Open full screen"
        onPress={() =>
          router.push({ pathname: "/board/[id]", params: { id, path: entry.path, v: entry.mtime } })
        }
        style={{ flex: 1, padding: 14 }}
      >
        <RenderImage
          projectId={id}
          entry={entry}
          style={{ flex: 1, borderRadius: 8, backgroundColor: t.panel2 }}
        />
        <Text style={{ color: t.muted, fontSize: 12, textAlign: "center", marginTop: 8 }}>
          Tap to zoom
        </Text>
      </Pressable>
    );
  } else if (kind === "binary" || tooBig) {
    body = (
      <Empty
        title={tooBig ? "Too large to show" : "Binary file"}
        hint={
          tooBig
            ? `${formatBytes(entry.size)} — the viewer stops at ${formatBytes(MAX_TEXT_BYTES)}.`
            : "Nothing to read here; open it on the desktop."
        }
      />
    );
  } else if (text.isLoading) {
    body = <Loading label="Loading file…" />;
  } else if (text.isError) {
    body = <Empty title="Could not load" hint={(text.error as Error).message} />;
  } else if (kind === "markdown" && !raw) {
    body = (
      <ScrollView contentContainerStyle={{ padding: 14 }}>
        <Markdown style={md as never}>{text.data ?? ""}</Markdown>
      </ScrollView>
    );
  } else {
    body = <CodeView text={text.data ?? ""} language={languageFor(entry.path)} />;
  }

  return (
    <Screen>
      {header}
      {meta}
      {kind === "markdown" && !tooBig ? (
        <View style={{ flexDirection: "row", gap: 8, paddingHorizontal: 14, paddingBottom: 6 }}>
          {(["Preview", "Source"] as const).map((label) => {
            const active = (label === "Source") === raw;
            return (
              <Pressable
                key={label}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                onPress={() => setRaw(label === "Source")}
                style={{
                  paddingHorizontal: 12,
                  paddingVertical: 5,
                  borderRadius: 8,
                  backgroundColor: active ? t.panel2 : "transparent",
                }}
              >
                <Text style={{ color: active ? t.fg : t.muted, fontSize: 13, fontWeight: "600" }}>
                  {label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {body}
    </Screen>
  );
}
