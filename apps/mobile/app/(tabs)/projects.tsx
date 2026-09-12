import { useProjects } from "@fabdesk/client-core";
import { router } from "expo-router";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { ConnectionGate } from "@/components/ConnectionGate";
import { Empty, Loading, Screen } from "@/components/ui";
import { relativeTime } from "@/lib/format";
import { usePullRefresh } from "@/components/pull-refresh";
import { useTheme } from "@/theme";

export default function ProjectsScreen() {
  return (
    <ConnectionGate>
      <Projects />
    </ConnectionGate>
  );
}

function Projects() {
  const t = useTheme();
  const projects = useProjects();
  const refreshControl = usePullRefresh(projects.refetch);
  if (projects.isLoading) return <Loading label="Loading projects…" />;

  return (
    <Screen>
      <FlatList
        data={projects.data ?? []}
        keyExtractor={(p) => p.id}
        refreshControl={refreshControl}
        contentContainerStyle={(projects.data ?? []).length === 0 ? { flexGrow: 1 } : { paddingBottom: 24 }}
        ListEmptyComponent={<Empty title="No projects" hint="Create one on the desktop and it appears here." />}
        renderItem={({ item }) => (
          <Pressable
            onPress={() => router.push({ pathname: "/project/[id]", params: { id: item.id } })}
            style={({ pressed }) => ({
              backgroundColor: pressed ? t.panel2 : t.panel,
              borderBottomColor: t.border,
              borderBottomWidth: StyleSheet.hairlineWidth,
              paddingHorizontal: 16,
              paddingVertical: 13,
            })}
          >
            <Text numberOfLines={1} style={{ color: t.fg, fontSize: 15, fontWeight: "500" }}>
              {item.name}
            </Text>
            <View style={{ flexDirection: "row", gap: 6 }}>
              <Text style={{ color: t.muted, fontSize: 12, marginTop: 2 }}>changed {relativeTime(item.updatedAt)}</Text>
            </View>
          </Pressable>
        )}
      />
    </Screen>
  );
}
