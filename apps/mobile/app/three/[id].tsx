/**
 * 3D view of the board: `renders/board.glb` (exported by `render_glb`) in `GlbViewer`, or an
 * offer to export it. Reset puts the camera back where model-viewer framed the model.
 */
import { useProject, useRunTool } from "@fabdesk/client-core";
import { Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { GlbViewer, type GlbViewerHandle } from "@/components/GlbViewer";
import { Button, Empty, Loading, Screen } from "@/components/ui";
import { formatBytes, relativeTime } from "@/lib/format";
import { useTheme } from "@/theme";
import { useSafeAreaInsets } from "react-native-safe-area-context";

const GLB_PATH = "renders/board.glb";

export default function ThreeScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const project = useProject(id ?? null);
  const render = useRunTool();
  const [handle, setHandle] = useState<GlbViewerHandle | null>(null);

  const glb = project.data?.files.find((f) => f.path === GLB_PATH);
  const running = render.state.status === "running";

  const rerender = () => {
    if (!id) return;
    void render.run("glb", { projectId: id }).then(() => project.refetch());
  };

  if (!id) return <Screen>{null}</Screen>;
  if (project.isLoading) return <Loading label="Loading project…" />;

  if (!glb) {
    return (
      <Screen>
        <Stack.Screen options={{ title: "3D" }} />
        <Empty
          title="No 3D model yet"
          hint={
            project.data?.files.some((f) => f.path.endsWith(".kicad_pcb"))
              ? "Export the routed board to renders/board.glb with KiCad."
              : "Nothing built yet — ask the agent in a chat to build the board, then export the 3D model."
          }
          action={
            <View style={{ alignItems: "center", gap: 8 }}>
              <Button
                title={running ? "Exporting…" : "Render 3D"}
                variant="primary"
                onPress={rerender}
                disabled={running}
              />
              {render.state.status === "failed" ? (
                <Text style={{ color: t.danger, fontSize: 12 }}>{render.state.error}</Text>
              ) : null}
            </View>
          }
        />
      </Screen>
    );
  }

  return (
    <Screen>
      <Stack.Screen
        options={{
          title: "3D",
          headerRight: () => (
            <View style={{ flexDirection: "row", gap: 14 }}>
              <Pressable
                accessibilityRole="button"
                onPress={() => handle?.reset()}
                disabled={!handle}
                hitSlop={8}
              >
                <Text style={{ color: handle ? t.accent : t.muted, fontSize: 15 }}>Reset</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={rerender}
                disabled={running}
                hitSlop={8}
              >
                <Text style={{ color: running ? t.muted : t.accent, fontSize: 15 }}>
                  {running ? "Exporting…" : "Re-render"}
                </Text>
              </Pressable>
            </View>
          ),
        }}
      />
      {/* Keyed on mtime so a re-export reloads the page and its cached blob. */}
      <GlbViewer key={glb.mtime} projectId={id} path={GLB_PATH} onHandle={setHandle} />
      <Text
        pointerEvents="none"
        style={{
          position: "absolute",
          bottom: 28 + insets.bottom,
          left: 0,
          right: 0,
          textAlign: "center",
          color: t.muted,
          fontSize: 11,
        }}
      >
        {GLB_PATH} · {formatBytes(glb.size)} · exported {relativeTime(glb.mtime)} · drag to orbit,
        pinch to zoom
      </Text>
      {render.state.status === "failed" ? (
        <Text
          style={{
            position: "absolute",
            bottom: 48,
            left: 16,
            right: 16,
            textAlign: "center",
            color: t.danger,
            fontSize: 12,
          }}
        >
          {render.state.error}
        </Text>
      ) : null}
    </Screen>
  );
}
