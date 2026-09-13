/**
 * The row of viewers a project has to offer — Schematic / PCB / 3D / Route runs — for the project
 * screen. Each button is hidden when the project has nothing behind it, so a fresh project shows
 * nothing rather than four ways to reach an empty state.
 */
import type { ProjectDetail } from "@fabdesk/protocol";
import { router } from "expo-router";
import { Pressable, Text, View } from "react-native";
import { useRouteRuns } from "@fabdesk/client-core";
import { hasBoard } from "@/lib/renders";
import { useTheme } from "@/theme";

export const SCHEMATIC_SVG = "renders/schematic.svg";
export const PCB_SVG = "renders/pcb.svg";
export const BOARD_GLB = "renders/board.glb";

export function BoardViewerLinks({
  projectId,
  project,
}: {
  projectId: string;
  project: ProjectDetail;
}) {
  const t = useTheme();
  const runs = useRouteRuns(projectId);
  const has = (path: string) => project.files.some((f) => f.path === path);
  const board = hasBoard(project);

  const links: Array<{ label: string; onPress: () => void }> = [];
  if (has(SCHEMATIC_SVG))
    links.push({
      label: "Schematic",
      onPress: () =>
        router.push({ pathname: "/svg/[id]", params: { id: projectId, kind: "schematic" } }),
    });
  // The PCB viewer can render the SVG on demand, so a built board is enough to offer it.
  if (has(PCB_SVG) || board)
    links.push({
      label: "PCB",
      onPress: () => router.push({ pathname: "/svg/[id]", params: { id: projectId, kind: "pcb" } }),
    });
  if (has(BOARD_GLB) || board)
    links.push({
      label: "3D",
      onPress: () => router.push({ pathname: "/three/[id]", params: { id: projectId } }),
    });
  if ((runs.data?.length ?? 0) > 0)
    links.push({
      label: "Route runs",
      onPress: () => router.push({ pathname: "/cinema", params: { projectId } }),
    });

  if (links.length === 0) return null;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {links.map((l) => (
        <Pressable
          key={l.label}
          accessibilityRole="button"
          onPress={l.onPress}
          style={({ pressed }) => ({
            paddingHorizontal: 12,
            paddingVertical: 7,
            borderRadius: 8,
            backgroundColor: t.panel2,
            borderColor: t.border,
            borderWidth: 1,
            opacity: pressed ? 0.7 : 1,
          })}
        >
          <Text style={{ color: t.fg, fontSize: 13, fontWeight: "600" }}>{l.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}
