/**
 * Every render of a project, one per page, swiped horizontally. A page whose "before" copy is in
 * the cache (see src/components/render-cache.ts) can flip into a wipe comparison with it.
 */
import type { FileEntry } from "@fabdesk/protocol";
import { useProject } from "@fabdesk/client-core";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  FlatList,
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { RenderCompare } from "@/components/RenderCompare";
import { RenderImage } from "@/components/RenderImage";
import { usePreviousRender } from "@/components/render-cache";
import { Badge, Button, Empty, Loading, Screen } from "@/components/ui";
import { formatBytes, relativeTime } from "@/lib/format";
import { galleryRenders, isPreviousRender, renderView } from "@/lib/renders";
import { useTheme } from "@/theme";

export default function RendersScreen() {
  const { id, path } = useLocalSearchParams<{ id: string; path?: string }>();
  const t = useTheme();
  const { width } = useWindowDimensions();
  const project = useProject(id ?? null);
  const renders = useMemo(() => galleryRenders(project.data), [project.data]);
  const initial = Math.max(
    0,
    renders.findIndex((f) => f.path === path),
  );
  const [page, setPage] = useState(initial);
  const list = useRef<FlatList<FileEntry>>(null);

  const onScrollEnd = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      setPage(Math.round(e.nativeEvent.contentOffset.x / width));
    },
    [width],
  );

  if (project.isLoading) return <Loading label="Loading renders…" />;
  if (!id || !project.data) return <Screen>{null}</Screen>;
  if (renders.length === 0) {
    return (
      <Screen>
        <Stack.Screen options={{ title: "Renders" }} />
        <Empty
          title="No renders yet"
          hint="Render the board from the project screen; each view lands here."
        />
      </Screen>
    );
  }

  return (
    <Screen>
      <Stack.Screen options={{ title: `Renders · ${page + 1}/${renders.length}` }} />
      <FlatList
        ref={list}
        data={renders}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        keyExtractor={(f) => f.path}
        initialScrollIndex={initial}
        getItemLayout={(_d, i) => ({ length: width, offset: width * i, index: i })}
        onMomentumScrollEnd={onScrollEnd}
        renderItem={({ item }) => <RenderPage projectId={id} entry={item} width={width} />}
      />
      <View style={{ flexDirection: "row", justifyContent: "center", gap: 6, paddingVertical: 10 }}>
        {renders.map((f, i) => (
          <Pressable
            key={f.path}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={renderView(f.path)}
            onPress={() => list.current?.scrollToIndex({ index: i, animated: true })}
            style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              backgroundColor: i === page ? t.accent : t.border,
            }}
          />
        ))}
      </View>
    </Screen>
  );
}

function RenderPage({
  projectId,
  entry,
  width,
}: {
  projectId: string;
  entry: FileEntry;
  width: number;
}) {
  const t = useTheme();
  const previous = usePreviousRender(projectId, entry);
  const canCompare = isPreviousRender(entry, previous);
  const [compare, setCompare] = useState(false);
  const view = renderView(entry.path);

  return (
    <ScrollView style={{ width }} contentContainerStyle={{ padding: 14, gap: 10 }}>
      {compare && canCompare ? (
        <RenderCompare projectId={projectId} entry={entry} previous={previous} />
      ) : (
        <Pressable
          accessibilityRole="imagebutton"
          accessibilityLabel={`${view} render, tap to zoom`}
          onPress={() =>
            router.push({
              pathname: "/board/[id]",
              params: { id: projectId, path: entry.path, v: entry.mtime },
            })
          }
        >
          <RenderImage
            projectId={projectId}
            entry={entry}
            style={{
              width: "100%",
              aspectRatio: 4 / 3,
              borderRadius: 8,
              backgroundColor: t.panel2,
            }}
          />
        </Pressable>
      )}

      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ color: t.fg, fontSize: 15, fontWeight: "600", flex: 1 }}>{view}</Text>
        <Badge label={formatBytes(entry.size)} />
        <Badge label={`rendered ${relativeTime(entry.mtime)}`} />
      </View>
      <Text style={{ color: t.muted, fontSize: 11 }}>{entry.path} · tap the picture to zoom</Text>

      {canCompare ? (
        <Button
          title={compare ? "Show current only" : "Compare with the previous render"}
          onPress={() => setCompare((c) => !c)}
        />
      ) : (
        <Text style={{ color: t.muted, fontSize: 12 }}>
          {previous
            ? "The previous copy matches this one — nothing has been re-rendered since."
            : "Render from the phone and the copy it replaces is kept for a before/after."}
        </Text>
      )}
      {compare && canCompare ? (
        <Text style={{ color: t.muted, fontSize: 12 }}>
          Drag the divider. Left of it is the current render; right of it, the one from{" "}
          {relativeTime(previous.mtime)}.
        </Text>
      ) : null}
    </ScrollView>
  );
}
