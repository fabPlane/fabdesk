/**
 * A project as seen from a phone: the board, the DRC verdict, and the files — read-mostly, with
 * one action (re-render the board) because that is the thing you actually want while away from
 * the desk.
 */
import { useProject, useRunTool } from "@fabdesk/client-core";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { useMemo } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { RenderImage } from "@/components/RenderImage";
import { useStashRender } from "@/components/render-cache";
import { Badge, Button, Card, Loading, Screen, readable } from "@/components/ui";
import { formatBytes, relativeTime } from "@/lib/format";
import { galleryRenders, hasBoard, preferredRender, renderView } from "@/lib/renders";
import { usePullRefresh } from "@/components/pull-refresh";
import { useNewChat } from "@/hooks/new-chat";
import { useTheme } from "@/theme";

export default function ProjectScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useTheme();
  const project = useProject(id ?? null);
  const refreshControl = usePullRefresh(project.refetch);
  const newChat = useNewChat();
  const render = useRunTool();
  const stash = useStashRender(id ?? "");

  const preview = useMemo(() => preferredRender(project.data), [project.data]);
  const renders = useMemo(() => galleryRenders(project.data), [project.data]);
  const recentFiles = useMemo(
    () =>
      [...(project.data?.files ?? [])]
        .sort((a, b) => Date.parse(b.mtime) - Date.parse(a.mtime))
        .slice(0, 8),
    [project.data],
  );
  const board = hasBoard(project.data);

  if (project.isLoading) return <Loading label="Loading project…" />;
  if (!project.data || !id) return <Screen>{null}</Screen>;

  const rerender = async () => {
    // The daemon overwrites renders/top.png, so the copy to compare against has to be taken now.
    await stash(renders.find((f) => renderView(f.path) === "top") ?? null);
    // `render_board` is long-running, so the tool route answers with a job id and useRunTool
    // waits on it; the project refetch afterwards is what surfaces the new file.
    await render
      // `callTool` lifts `projectId` out and wraps the rest as the tool's args itself.
      .run("render", { projectId: id, view: "top", width: 1600, height: 1200, quality: "basic" })
      .then(() => project.refetch());
  };

  return (
    <Screen>
      <Stack.Screen options={{ title: project.data.name }} />
      <ScrollView
        contentContainerStyle={{ padding: 14, gap: 14, ...readable }}
        refreshControl={refreshControl}
      >
        <Card>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <Text style={{ color: t.fg, fontSize: 15, fontWeight: "600", flex: 1 }}>Board</Text>
            <Badge label={`${project.data.manifest.board.layers} layers`} />
            {board ? (
              <Badge label="built" tone="success" />
            ) : (
              <Badge label="not built" tone="warning" />
            )}
          </View>

          {preview ? (
            <Pressable
              onPress={() =>
                router.push({
                  pathname: "/board/[id]",
                  params: { id, path: preview.path, v: preview.mtime },
                })
              }
            >
              <RenderImage
                projectId={id}
                entry={preview}
                style={{
                  width: "100%",
                  aspectRatio: 4 / 3,
                  borderRadius: 8,
                  backgroundColor: t.panel2,
                }}
              />
              <Text style={{ color: t.muted, fontSize: 11, marginTop: 6 }}>
                {preview.path} · rendered {relativeTime(preview.mtime)} · tap to zoom
              </Text>
            </Pressable>
          ) : (
            <Text style={{ color: t.muted, fontSize: 13 }}>
              {board
                ? "No render yet."
                : "Nothing built yet — run circuit_build on the desktop first."}
            </Text>
          )}

          <Button
            title={render.state.status === "running" ? "Rendering…" : "Render the board"}
            onPress={() => void rerender()}
            disabled={!board || render.state.status === "running"}
            style={{ marginTop: 10 }}
          />
          {render.state.status === "failed" ? (
            <Text style={{ color: t.danger, fontSize: 12, marginTop: 6 }}>
              {render.state.error}
            </Text>
          ) : null}
        </Card>

        <Button
          title={newChat.busy ? "Starting…" : "New chat in this project"}
          variant="primary"
          disabled={newChat.busy}
          onPress={() => void newChat.start(id ?? null)}
        />

        {renders.length > 0 ? (
          <Card>
            <Pressable
              accessibilityRole="button"
              onPress={() => router.push({ pathname: "/renders/[id]", params: { id } })}
              style={{ flexDirection: "row", alignItems: "center", marginBottom: 8 }}
            >
              <Text style={{ color: t.fg, fontSize: 15, fontWeight: "600", flex: 1 }}>Renders</Text>
              <Text style={{ color: t.accent, fontSize: 13 }}>
                {renders.length} view{renders.length === 1 ? "" : "s"} · gallery ›
              </Text>
            </Pressable>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {renders.map((f) => (
                <Pressable
                  key={f.path}
                  accessibilityRole="imagebutton"
                  accessibilityLabel={renderView(f.path)}
                  onPress={() =>
                    router.push({ pathname: "/renders/[id]", params: { id, path: f.path } })
                  }
                >
                  <RenderImage
                    projectId={id}
                    entry={f}
                    contentFit="cover"
                    style={{ width: 96, height: 72, borderRadius: 6, backgroundColor: t.panel2 }}
                  />
                  <Text style={{ color: t.muted, fontSize: 10, marginTop: 2, textAlign: "center" }}>
                    {renderView(f.path)}
                  </Text>
                </Pressable>
              ))}
            </View>
          </Card>
        ) : null}

        <Card>
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push({ pathname: "/files/[id]", params: { id } })}
            style={{ flexDirection: "row", alignItems: "center", marginBottom: 8 }}
          >
            <Text style={{ color: t.fg, fontSize: 15, fontWeight: "600", flex: 1 }}>Files</Text>
            <Text style={{ color: t.accent, fontSize: 13 }}>
              {project.data.files.length} file{project.data.files.length === 1 ? "" : "s"} · browse
              ›
            </Text>
          </Pressable>
          {recentFiles.map((f) => (
            <Pressable
              key={f.path}
              accessibilityRole="button"
              onPress={() =>
                router.push({ pathname: "/files/[id]/view", params: { id, path: f.path } })
              }
              style={({ pressed }) => ({
                flexDirection: "row",
                paddingVertical: 5,
                borderBottomColor: t.border,
                borderBottomWidth: StyleSheet.hairlineWidth,
                opacity: pressed ? 0.6 : 1,
              })}
            >
              <Text
                numberOfLines={1}
                style={{ color: t.fg, fontSize: 12, flex: 1, fontFamily: "Menlo" }}
              >
                {f.path}
              </Text>
              <Text style={{ color: t.muted, fontSize: 12 }}>{formatBytes(f.size)}</Text>
            </Pressable>
          ))}
          <Text style={{ color: t.muted, fontSize: 11, marginTop: 6 }}>Most recently changed</Text>
        </Card>
      </ScrollView>
    </Screen>
  );
}
