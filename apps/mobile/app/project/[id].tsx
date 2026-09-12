/**
 * A project as seen from a phone: the board, the DRC verdict, and the files — read-mostly, with
 * one action (re-render the board) because that is the thing you actually want while away from
 * the desk.
 */
import { useProject, useRunTool } from "@fabdesk/client-core";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { useMemo } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { ProjectImage } from "@/components/ProjectImage";
import { Badge, Button, Card, Loading, Screen, readable } from "@/components/ui";
import { formatBytes, relativeTime } from "@/lib/format";
import { hasBoard, preferredRender, renderImages } from "@/lib/renders";
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

  const preview = useMemo(() => preferredRender(project.data), [project.data]);
  const renders = useMemo(() => renderImages(project.data), [project.data]);
  const board = hasBoard(project.data);

  if (project.isLoading) return <Loading label="Loading project…" />;
  if (!project.data || !id) return <Screen>{null}</Screen>;

  const rerender = () => {
    // `render_board` is long-running, so the tool route answers with a job id and useRunTool
    // waits on it; the project refetch afterwards is what surfaces the new file.
    void render
      .run("render", {
        args: { view: "top", width: 1600, height: 1200, quality: "basic" },
        project: id,
      })
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
                router.push({ pathname: "/board/[id]", params: { id, path: preview.path } })
              }
            >
              <ProjectImage
                projectId={id}
                path={preview.path}
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
            onPress={rerender}
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

        {renders.length > 1 ? (
          <Card>
            <Text style={{ color: t.fg, fontSize: 15, fontWeight: "600", marginBottom: 8 }}>
              Renders
            </Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {renders.map((f) => (
                <Pressable
                  key={f.path}
                  onPress={() =>
                    router.push({ pathname: "/board/[id]", params: { id, path: f.path } })
                  }
                >
                  <ProjectImage
                    projectId={id}
                    path={f.path}
                    contentFit="cover"
                    style={{ width: 96, height: 72, borderRadius: 6, backgroundColor: t.panel2 }}
                  />
                </Pressable>
              ))}
            </View>
          </Card>
        ) : null}

        <Card>
          <Text style={{ color: t.fg, fontSize: 15, fontWeight: "600", marginBottom: 8 }}>
            Files
          </Text>
          {project.data.files.slice(0, 40).map((f) => (
            <View
              key={f.path}
              style={{
                flexDirection: "row",
                paddingVertical: 4,
                borderBottomColor: t.border,
                borderBottomWidth: StyleSheet.hairlineWidth,
              }}
            >
              <Text
                numberOfLines={1}
                style={{ color: t.fg, fontSize: 12, flex: 1, fontFamily: "Menlo" }}
              >
                {f.path}
              </Text>
              <Text style={{ color: t.muted, fontSize: 12 }}>{formatBytes(f.size)}</Text>
            </View>
          ))}
          {project.data.files.length > 40 ? (
            <Text style={{ color: t.muted, fontSize: 12, marginTop: 6 }}>
              and {project.data.files.length - 40} more
            </Text>
          ) : null}
        </Card>
      </ScrollView>
    </Screen>
  );
}
