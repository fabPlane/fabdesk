/**
 * A project as seen from a phone: the board, the DRC verdict, and the files — read-mostly, with
 * one action (re-render the board) because that is the thing you actually want while away from
 * the desk.
 */
import {
  useDeleteProject,
  useProject,
  useProjectJson,
  useRunTool,
  useRunsStore,
} from "@fabdesk/client-core";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { useMemo } from "react";
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { ConnectionGate } from "@/components/ConnectionGate";
import { BoardViewerLinks } from "@/components/BoardViewerLinks";
import { RenderImage } from "@/components/RenderImage";
import { useStashRender } from "@/components/render-cache";
import { Badge, Button, Card, Loading, Screen, readable } from "@/components/ui";
import { normalizeReport, summarize } from "@/lib/drc";
import { ACTIVE } from "@/lib/jobs";
import { formatBytes, relativeTime } from "@/lib/format";
import { galleryRenders, hasBoard, preferredRender, renderView } from "@/lib/renders";
import { usePullRefresh } from "@/components/pull-refresh";
import { useNewChat } from "@/hooks/new-chat";
import { useTheme } from "@/theme";

/**
 * Reached by deep link and notification tap as well as from the tabs, so the gate lives here:
 * a cold start lands on this route before the connection has a client to read from.
 */
export default function ProjectScreen() {
  return (
    <ConnectionGate>
      <ProjectScreenBody />
    </ConnectionGate>
  );
}

function ProjectScreenBody() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useTheme();
  const window = useWindowDimensions();
  const project = useProject(id ?? null);
  const refreshControl = usePullRefresh(project.refetch);
  const newChat = useNewChat();
  const render = useRunTool();
  const stash = useStashRender(id ?? "");
  const remove = useDeleteProject();

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
  // The reports are small and cached per file, so the badge costs two requests the DRC screen
  // would make anyway.
  const drc = useProjectJson(id ?? null, "reports/drc.json");
  const erc = useProjectJson(id ?? null, "reports/erc.json");
  const checks = useMemo(
    () => summarize([...normalizeReport(drc.data, "drc"), ...normalizeReport(erc.data, "erc")]),
    [drc.data, erc.data],
  );
  const hasReports = drc.data !== null || erc.data !== null;
  // Jobs the stream has told us about; enough to know whether "Jobs" is worth a header button.
  const liveJobs = useRunsStore((s) => s.jobs);
  const runningJobs = useMemo(
    () => Object.values(liveJobs).filter((j) => j.projectId === id && ACTIVE.has(j.status)).length,
    [liveJobs, id],
  );

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

  const confirmDelete = () => {
    const name = project.data?.name ?? "this project";
    const run = (purge: boolean) =>
      remove
        .mutateAsync({ projectId: id, purge })
        .then(() => router.back())
        .catch((e: unknown) =>
          Alert.alert("Could not delete", e instanceof Error ? e.message : String(e)),
        );
    Alert.alert(
      `Delete ${name}?`,
      "Forget it in fabPlane and keep the folder on the computer, or delete the folder too. Its chats are removed either way.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Forget, keep files", onPress: () => void run(false) },
        { text: "Delete files too", style: "destructive", onPress: () => void run(true) },
      ],
    );
  };

  return (
    <Screen>
      <Stack.Screen
        options={{
          title: project.data.name,
          headerRight: () =>
            runningJobs > 0 || render.state.status === "running" ? (
              <Pressable
                hitSlop={12}
                accessibilityRole="button"
                accessibilityLabel="Jobs"
                onPress={() => router.push({ pathname: "/jobs", params: { projectId: id } })}
              >
                <Text style={{ color: t.accent, fontSize: 15 }}>⟳ {runningJobs || 1} running</Text>
              </Pressable>
            ) : null,
        }}
      />
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
                  // On a short landscape window (a handheld) a 4:3 preview at full content width
                  // would be the whole screen; the gallery is one tap away for a big look.
                  maxHeight: Math.round(window.height * 0.45),
                  alignSelf: "center",
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
                : "Nothing built yet — ask the agent in a chat to build the board."}
            </Text>
          )}

          <Button
            title={render.state.status === "running" ? "Rendering…" : "Render the board"}
            onPress={() => void rerender()}
            disabled={!board || render.state.status === "running"}
            style={{ marginTop: 10 }}
          />
          {render.state.status === "running" ? (
            <Pressable
              accessibilityRole="link"
              onPress={() => router.push({ pathname: "/jobs", params: { projectId: id } })}
            >
              <Text style={{ color: t.accent, fontSize: 12, marginTop: 8, textAlign: "center" }}>
                Watch or cancel it in Jobs ›
              </Text>
            </Pressable>
          ) : null}
          {render.state.status === "failed" ? (
            <Text style={{ color: t.danger, fontSize: 12, marginTop: 6 }}>
              {render.state.error}
            </Text>
          ) : null}
        </Card>

        <BoardViewerLinks projectId={id} project={project.data} />

        <Card>
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push({ pathname: "/drc/[id]", params: { id } })}
            style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
          >
            <Text style={{ color: t.fg, fontSize: 15, fontWeight: "600", flex: 1 }}>DRC / ERC</Text>
            {!hasReports ? (
              <Badge label="no reports" />
            ) : checks.total === 0 ? (
              <Badge label="passes" tone="success" />
            ) : (
              <>
                {checks.errors ? (
                  <Badge
                    label={`${checks.errors} error${checks.errors === 1 ? "" : "s"}`}
                    tone="danger"
                  />
                ) : null}
                {checks.warnings ? (
                  <Badge
                    label={`${checks.warnings} warning${checks.warnings === 1 ? "" : "s"}`}
                    tone="warning"
                  />
                ) : null}
              </>
            )}
            <Text style={{ color: t.accent, fontSize: 13 }}>›</Text>
          </Pressable>
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

        <Button
          title={remove.isPending ? "Deleting…" : "Delete project"}
          variant="danger"
          disabled={remove.isPending}
          onPress={confirmDelete}
          style={{ marginTop: 8 }}
        />
        <Text style={{ color: t.muted, fontSize: 11, textAlign: "center", marginTop: -6 }}>
          {project.data.path}
        </Text>
      </ScrollView>
    </Screen>
  );
}
