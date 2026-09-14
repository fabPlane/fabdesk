import { useProjects } from "@fabdesk/client-core";
import { Tabs, router } from "expo-router";
import { useMemo } from "react";
import { Alert, Pressable, SectionList, StyleSheet, Text, View } from "react-native";
import { ConnectionGate } from "@/components/ConnectionGate";
import { Button, Empty, Loading, Screen, readable } from "@/components/ui";
import { relativeTime } from "@/lib/format";
import { groupProjectsByFolder } from "@/lib/project-groups";
import { usePullRefresh } from "@/components/pull-refresh";
import { useTheme } from "@/theme";

export default function ProjectsScreen() {
  return (
    <ConnectionGate>
      <Projects />
    </ConnectionGate>
  );
}

/** New / From catalog — a native alert rather than a sheet: two options, both platforms. */
function askNewProject() {
  Alert.alert("New project", undefined, [
    { text: "New empty project", onPress: () => router.push("/new-project") },
    { text: "From the open-source catalog", onPress: () => router.push("/catalog") },
    { text: "Cancel", style: "cancel" },
  ]);
}

function Projects() {
  const t = useTheme();
  const projects = useProjects();
  const refreshControl = usePullRefresh(projects.refetch);
  const groups = useMemo(() => groupProjectsByFolder(projects.data ?? []), [projects.data]);
  const sections = useMemo(
    () => groups.map((g) => ({ title: g.title, data: g.projects, single: groups.length === 1 })),
    [groups],
  );
  if (projects.isLoading) return <Loading label="Loading projects…" />;

  return (
    <Screen>
      <Tabs.Screen
        options={{
          headerRight: () => (
            <Pressable
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="New project"
              onPress={askNewProject}
              style={{ paddingHorizontal: 16 }}
            >
              <Text style={{ color: t.accent, fontSize: 24, lineHeight: 28 }}>+</Text>
            </Pressable>
          ),
        }}
      />
      <SectionList
        sections={sections}
        keyExtractor={(p) => p.id}
        refreshControl={refreshControl}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={
          sections.length === 0 ? { flexGrow: 1 } : { paddingBottom: 24, ...readable }
        }
        ListEmptyComponent={
          <Empty
            title="No projects"
            hint="Start one here, remix a board from the catalog, or create one on the desktop."
            action={
              <View style={{ gap: 8, marginTop: 8, width: 240 }}>
                <Button
                  title="New project"
                  variant="primary"
                  onPress={() => router.push("/new-project")}
                />
                <Button title="Browse the catalog" onPress={() => router.push("/catalog")} />
              </View>
            }
          />
        }
        renderSectionHeader={({ section }) =>
          section.single ? null : (
            <Text
              style={{
                color: t.muted,
                fontSize: 11,
                fontWeight: "700",
                textTransform: "uppercase",
                letterSpacing: 0.6,
                paddingHorizontal: 16,
                paddingTop: 14,
                paddingBottom: 6,
                backgroundColor: t.bg,
              }}
            >
              {section.title}
            </Text>
          )
        }
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
              <Text style={{ color: t.muted, fontSize: 12, marginTop: 2 }}>
                changed {relativeTime(item.updatedAt)}
              </Text>
            </View>
          </Pressable>
        )}
      />
    </Screen>
  );
}
