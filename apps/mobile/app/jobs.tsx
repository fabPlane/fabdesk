/**
 * Every job the daemon is running or has run — renders, routes, exports — with a Cancel on the
 * live ones. `GET /jobs` is the base; `job.*` events keep the rows it knows about current
 * (src/lib/jobs.ts merges the two), and the list re-polls while anything is active.
 */
import { useCancelJob, useJobs, useRunsStore } from "@fabdesk/client-core";
import { Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { usePullRefresh } from "@/components/pull-refresh";
import { Badge, Empty, Loading, Screen, readable } from "@/components/ui";
import { formatDuration, relativeTime } from "@/lib/format";
import {
  ACTIVE,
  activeCount,
  describeKind,
  jobDurationMs,
  jobsFor,
  mergeJobs,
  type JobRow,
} from "@/lib/jobs";
import { useTheme } from "@/theme";

export default function JobsScreen() {
  const { projectId } = useLocalSearchParams<{ projectId?: string }>();
  const t = useTheme();
  const jobs = useJobs();
  const live = useRunsStore((s) => s.jobs);
  const cancel = useCancelJob();
  const refreshControl = usePullRefresh(jobs.refetch);
  const all = useMemo(() => mergeJobs(jobs.data, live), [jobs.data, live]);
  const rows = useMemo(() => (projectId ? jobsFor(all, projectId) : all), [all, projectId]);
  const active = activeCount(rows);

  // Durations of running jobs tick; nothing else on the screen needs a clock.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (active === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);

  if (jobs.isLoading) return <Loading label="Loading jobs…" />;

  const confirmCancel = (job: JobRow) =>
    Alert.alert(
      `Cancel ${describeKind(job.kind)}?`,
      "The daemon stops the job; whatever it wrote so far stays.",
      [
        { text: "Keep running", style: "cancel" },
        {
          text: "Cancel job",
          style: "destructive",
          onPress: () =>
            cancel
              .mutateAsync(job.id)
              .catch((e: unknown) =>
                Alert.alert("Could not cancel", e instanceof Error ? e.message : String(e)),
              ),
        },
      ],
    );

  return (
    <Screen>
      <Stack.Screen options={{ title: active ? `Jobs · ${active} running` : "Jobs" }} />
      <FlatList
        data={rows}
        keyExtractor={(r) => r.id}
        refreshControl={refreshControl}
        contentContainerStyle={
          rows.length === 0 ? { flexGrow: 1 } : { paddingBottom: 24, ...readable }
        }
        ListEmptyComponent={
          <Empty
            title="No jobs"
            hint={
              jobs.isError
                ? (jobs.error as Error).message
                : projectId
                  ? "Nothing has run for this project since the daemon started."
                  : "Renders, routes and exports show up here while they run."
            }
          />
        }
        renderItem={({ item }) => {
          const isActive = ACTIVE.has(item.status);
          const duration = jobDurationMs(item, now);
          return (
            <View
              style={{
                paddingHorizontal: 16,
                paddingVertical: 12,
                gap: 4,
                backgroundColor: t.panel,
                borderBottomColor: t.border,
                borderBottomWidth: StyleSheet.hairlineWidth,
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text
                  style={{ color: t.fg, fontSize: 15, fontWeight: "500", flex: 1 }}
                  numberOfLines={1}
                >
                  {describeKind(item.kind)}
                </Text>
                <Badge label={item.status} tone={toneFor(item.status)} />
                {isActive ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Cancel ${describeKind(item.kind)}`}
                    hitSlop={8}
                    disabled={cancel.isPending}
                    onPress={() => confirmCancel(item)}
                    style={({ pressed }) => ({
                      paddingHorizontal: 10,
                      paddingVertical: 5,
                      borderRadius: 8,
                      backgroundColor: t.panel2,
                      opacity: pressed || cancel.isPending ? 0.6 : 1,
                    })}
                  >
                    <Text style={{ color: t.danger, fontSize: 13, fontWeight: "600" }}>Cancel</Text>
                  </Pressable>
                ) : null}
              </View>
              {isActive && item.progress !== null ? (
                <View
                  style={{
                    height: 4,
                    borderRadius: 2,
                    backgroundColor: t.panel2,
                    overflow: "hidden",
                  }}
                >
                  <View
                    style={{
                      width: `${Math.round(Math.min(1, Math.max(0, item.progress)) * 100)}%`,
                      height: 4,
                      backgroundColor: t.accent,
                    }}
                  />
                </View>
              ) : null}
              <Text style={{ color: t.muted, fontSize: 12 }}>
                {item.startedAt !== null
                  ? `started ${relativeTime(new Date(item.startedAt).toISOString(), now)}`
                  : "not started"}
                {duration !== null
                  ? ` · ${isActive ? "running for" : "took"} ${formatDuration(duration)}`
                  : ""}
                {item.progress !== null && isActive ? ` · ${Math.round(item.progress * 100)}%` : ""}
              </Text>
              {item.note ? (
                <Text style={{ color: t.muted, fontSize: 12 }} numberOfLines={2}>
                  {item.note}
                </Text>
              ) : null}
              {item.error ? (
                <Text style={{ color: t.danger, fontSize: 12 }} numberOfLines={3}>
                  {item.error}
                </Text>
              ) : null}
              <Text style={{ color: t.muted, fontSize: 10, fontFamily: "Menlo" }}>{item.id}</Text>
            </View>
          );
        }}
      />
    </Screen>
  );
}

function toneFor(status: JobRow["status"]): "success" | "danger" | "warning" | "default" {
  switch (status) {
    case "done":
      return "success";
    case "failed":
      return "danger";
    case "running":
      return "warning";
    default:
      return "default";
  }
}
