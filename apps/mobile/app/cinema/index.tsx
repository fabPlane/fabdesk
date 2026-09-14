/** A project's routing runs (`GET /projects/:id/route-runs`), newest first; tap one for its Route Cinema. */
import { useRouteRuns } from "@fabdesk/client-core";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { useMemo } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { Badge, Empty, Loading, Screen } from "@/components/ui";
import { describeRun, sortRuns } from "@/lib/route-runs";
import { useTheme } from "@/theme";

export default function RouteRunsScreen() {
  const { projectId } = useLocalSearchParams<{ projectId: string }>();
  const t = useTheme();
  const runs = useRouteRuns(projectId ?? null);
  const rows = useMemo(() => sortRuns(runs.data ?? []).map((r) => describeRun(r)), [runs.data]);

  if (!projectId) return <Screen>{null}</Screen>;
  if (runs.isLoading) return <Loading label="Loading route runs…" />;

  return (
    <Screen>
      <Stack.Screen options={{ title: "Route runs" }} />
      <FlatList
        data={rows}
        keyExtractor={(r) => r.id}
        contentContainerStyle={rows.length === 0 ? { flex: 1 } : undefined}
        refreshControl={
          <RefreshControl
            refreshing={runs.isRefetching}
            onRefresh={() => void runs.refetch()}
            tintColor={t.muted}
          />
        }
        ListEmptyComponent={
          <Empty
            title="No routing runs yet"
            hint="Route the board from the desktop, or ask the agent to; runs show up here as they start."
          />
        }
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            onPress={() => router.push({ pathname: "/cinema/[runId]", params: { runId: item.id } })}
            style={({ pressed }) => ({
              paddingHorizontal: 16,
              paddingVertical: 12,
              gap: 4,
              backgroundColor: pressed ? t.panel2 : t.bg,
              borderBottomColor: t.border,
              borderBottomWidth: StyleSheet.hairlineWidth,
            })}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              {item.live ? (
                <View
                  style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: t.success }}
                />
              ) : null}
              <Text
                numberOfLines={1}
                style={{ color: t.fg, fontSize: 15, fontWeight: "600", flex: 1 }}
              >
                {item.title}
              </Text>
              <Badge label={item.status} tone={item.tone} />
            </View>
            <Text numberOfLines={1} style={{ color: t.muted, fontSize: 12 }}>
              {item.subtitle} · {item.id.slice(0, 8)}
            </Text>
          </Pressable>
        )}
      />
    </Screen>
  );
}
