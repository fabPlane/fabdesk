/**
 * Schematic / PCB viewer: the daemon's `renders/<kind>.svg` (drawn by kicad-cli), zoomable, with
 * per-layer toggles for the board. The phone's `packages/ui/src/board/SvgTab.tsx`.
 */
import { useProjectText, useRunTool } from "@fabdesk/client-core";
import { Stack, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { SvgViewer, SvgWebViewer } from "@/components/SvgViewer";
import { Button, Empty, Loading, Screen } from "@/components/ui";
import { formatBytes } from "@/lib/format";
import {
  applySvgLayers,
  parseSvgLayers,
  prepareSvgForNative,
  svgRenderPath,
} from "@/lib/svg-layers";
import { useTheme } from "@/theme";

type Kind = "schematic" | "pcb";

const RENDER_TOOL: Record<Kind, string> = {
  schematic: "render_schematic_svg",
  pcb: "render_pcb_svg",
};
const TITLE: Record<Kind, string> = { schematic: "Schematic", pcb: "PCB" };
/** KiCad's own canvas colours: the plot's silkscreen and hole colours assume the dark board background. */
const BACKGROUND: Record<Kind, string> = { schematic: "#f5f4ef", pcb: "#001023" };

export default function SvgScreen() {
  const params = useLocalSearchParams<{ id: string; kind?: string }>();
  const kind: Kind = params.kind === "schematic" ? "schematic" : "pcb";
  const id = params.id ?? null;
  const t = useTheme();
  const path = `renders/${kind}.svg`;
  const rendered = useProjectText(id, path);
  const render = useRunTool();
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());

  const raw = rendered.data ?? null;
  const layers = useMemo(() => (raw && kind === "pcb" ? parseSvgLayers(raw) : []), [raw, kind]);
  const mode = raw ? svgRenderPath(raw) : "native";
  // Strip once, then only the (cheap) colour rewrite runs per toggle.
  const prepared = useMemo(
    () => (raw && mode === "native" ? prepareSvgForNative(raw) : null),
    [raw, mode],
  );
  const xml = useMemo(
    () => (prepared ? applySvgLayers(prepared, hidden) : null),
    [prepared, hidden],
  );

  const toggle = (color: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(color)) next.delete(color);
      else next.add(color);
      return next;
    });

  const rerender = () => {
    if (!id) return;
    void render.run(RENDER_TOOL[kind], { projectId: id }).then(() => rendered.refetch());
  };

  if (!id) return <Screen>{null}</Screen>;
  if (rendered.isLoading) return <Loading label={`Loading ${path}…`} />;

  if (!raw) {
    const running = render.state.status === "running";
    return (
      <Screen>
        <Stack.Screen options={{ title: TITLE[kind] }} />
        <Empty
          title={`No ${kind} render yet`}
          hint={
            kind === "pcb"
              ? "Build the board (circuit_build) on the desktop and render it, or ask the agent to design one."
              : "A compiled project has no drawn schematic; import a KiCad project to see one here."
          }
          action={
            <View style={{ alignItems: "center", gap: 8 }}>
              <Button
                title={running ? "Rendering…" : `Render ${kind}`}
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

  const size = formatBytes(raw.length);
  return (
    <Screen>
      <Stack.Screen options={{ title: TITLE[kind] }} />
      {layers.length > 0 && mode === "native" ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{
            flexGrow: 0,
            backgroundColor: t.panel,
            borderBottomColor: t.border,
            borderBottomWidth: 1,
          }}
          contentContainerStyle={{ paddingHorizontal: 10, paddingVertical: 6, gap: 6 }}
        >
          {layers.map((l) => {
            const off = hidden.has(l.color);
            return (
              <Pressable
                key={l.color}
                accessibilityRole="button"
                accessibilityState={{ selected: !off }}
                onPress={() => toggle(l.color)}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 6,
                  paddingHorizontal: 8,
                  paddingVertical: 4,
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor: t.border,
                  opacity: off ? 0.4 : 1,
                }}
              >
                <View
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: 2,
                    backgroundColor: l.color,
                    borderWidth: 1,
                    borderColor: t.border,
                  }}
                />
                <Text style={{ color: t.fg, fontSize: 12 }}>{l.name}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}
      {mode === "native" && xml ? (
        <SvgViewer
          xml={xml}
          background={BACKGROUND[kind]}
          caption={`${path} · ${size} · pinch or double-tap to zoom`}
        />
      ) : (
        <SvgWebViewer
          xml={raw}
          background={BACKGROUND[kind]}
          caption={`${path} · ${size} · shown in a WebView (too large to toggle layers)`}
        />
      )}
    </Screen>
  );
}
