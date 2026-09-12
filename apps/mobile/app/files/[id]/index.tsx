/** The project's files as a tree; tap a directory to fold it, a file to open it. */
import { useProject } from "@fabdesk/client-core";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { usePullRefresh } from "@/components/pull-refresh";
import { Empty, Loading, Screen, readable } from "@/components/ui";
import {
  buildFileTree,
  fileKind,
  flattenTree,
  initialExpanded,
  type TreeRow,
} from "@/lib/file-tree";
import { formatBytes, relativeTime } from "@/lib/format";
import { useTheme } from "@/theme";

const GLYPH = { image: "🖼", markdown: "📝", text: "📄", binary: "📦" } as const;

export default function FilesScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useTheme();
  const project = useProject(id ?? null);
  const refreshControl = usePullRefresh(project.refetch);
  const tree = useMemo(() => buildFileTree(project.data?.files ?? []), [project.data?.files]);
  const [expanded, setExpanded] = useState<Set<string> | null>(null);
  // Top-level directories open on the first load only; after that the user's folds stand.
  useEffect(() => {
    if (expanded === null && project.data) setExpanded(initialExpanded(tree));
  }, [expanded, project.data, tree]);
  const rows = useMemo(() => flattenTree(tree, expanded ?? new Set()), [tree, expanded]);

  if (project.isLoading) return <Loading label="Loading files…" />;
  if (!id || !project.data) return <Screen>{null}</Screen>;

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev ?? []);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <Screen>
      <Stack.Screen options={{ title: `Files · ${project.data.name}` }} />
      <FlatList
        data={rows}
        keyExtractor={(r) => r.node.path}
        refreshControl={refreshControl}
        contentContainerStyle={
          rows.length === 0 ? { flexGrow: 1 } : { paddingBottom: 24, ...readable }
        }
        ListEmptyComponent={
          <Empty title="Empty project" hint="Nothing has been written here yet." />
        }
        renderItem={({ item }) => (
          <Row
            row={item}
            onPress={() =>
              item.node.kind === "dir"
                ? toggle(item.node.path)
                : router.push({
                    pathname: "/files/[id]/view",
                    params: { id, path: item.node.path },
                  })
            }
          />
        )}
        ListFooterComponent={
          <Text style={{ color: t.muted, fontSize: 12, padding: 16 }}>
            {tree.fileCount} file{tree.fileCount === 1 ? "" : "s"} · {formatBytes(tree.size)}
          </Text>
        }
      />
    </Screen>
  );
}

function Row({ row, onPress }: { row: TreeRow; onPress: () => void }) {
  const t = useTheme();
  const { node, depth, expanded } = row;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={node.kind === "dir" ? `${node.name} folder` : node.name}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingLeft: 16 + depth * 18,
        paddingRight: 16,
        paddingVertical: 9,
        backgroundColor: pressed ? t.panel2 : t.panel,
        borderBottomColor: t.border,
        borderBottomWidth: StyleSheet.hairlineWidth,
      })}
    >
      <Text style={{ color: t.muted, fontSize: 13, width: 18, textAlign: "center" }}>
        {node.kind === "dir" ? (expanded ? "▾" : "▸") : GLYPH[fileKind(node.path)]}
      </Text>
      <View style={{ flex: 1 }}>
        <Text
          numberOfLines={1}
          style={{
            color: t.fg,
            fontSize: 13,
            fontFamily: "Menlo",
            fontWeight: node.kind === "dir" ? "600" : "400",
          }}
        >
          {node.name}
        </Text>
        {node.kind === "file" ? (
          <Text style={{ color: t.muted, fontSize: 11 }}>
            changed {relativeTime(node.entry.mtime)}
          </Text>
        ) : null}
      </View>
      <Text style={{ color: t.muted, fontSize: 12 }}>
        {node.kind === "dir"
          ? `${node.fileCount} · ${formatBytes(node.size)}`
          : formatBytes(node.entry.size)}
      </Text>
    </Pressable>
  );
}
