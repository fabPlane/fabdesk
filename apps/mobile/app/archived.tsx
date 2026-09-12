/**
 * Archived chats, flat and newest first. Chats hides them (the grouping helper skips archived
 * threads), so this is the only place on the phone they can be found and brought back.
 */
import { useThreads } from "@fabdesk/client-core";
import type { Thread } from "@fabdesk/protocol";
import { router, Stack } from "expo-router";
import { useMemo } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { usePullRefresh } from "@/components/pull-refresh";
import { Empty, Loading, Screen, readable } from "@/components/ui";
import { useThreadActions } from "@/hooks/thread-actions";
import { relativeTime } from "@/lib/format";
import { archivedThreads } from "@/lib/thread-actions";
import { useTheme } from "@/theme";

export default function ArchivedScreen() {
  const threads = useThreads();
  const refreshControl = usePullRefresh(threads.refetch);
  const actions = useThreadActions();
  const data = useMemo(() => archivedThreads(threads.data ?? []), [threads.data]);

  if (threads.isLoading) return <Loading label="Loading archived chats…" />;

  return (
    <Screen>
      <Stack.Screen options={{ title: "Archived" }} />
      <FlatList
        data={data}
        keyExtractor={(t) => t.id}
        refreshControl={refreshControl}
        contentContainerStyle={{ paddingVertical: 8, flexGrow: 1, ...readable }}
        renderItem={({ item }) => (
          <ArchivedRow
            thread={item}
            busy={actions.busy}
            onUnarchive={() => void actions.toggleArchive(item)}
          />
        )}
        ListEmptyComponent={
          <Empty title="Nothing archived" hint="Archive a chat from its … menu to park it here." />
        }
      />
    </Screen>
  );
}

function ArchivedRow({
  thread,
  busy,
  onUnarchive,
}: {
  thread: Thread;
  busy: boolean;
  onUnarchive: () => void;
}) {
  const t = useTheme();
  return (
    <Pressable
      onPress={() => router.push({ pathname: "/thread/[id]", params: { id: thread.id } })}
      style={({ pressed }) => ({
        backgroundColor: pressed ? t.panel2 : t.panel,
        borderBottomColor: t.border,
        borderBottomWidth: StyleSheet.hairlineWidth,
        paddingHorizontal: 16,
        paddingVertical: 12,
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
      })}
    >
      <View style={{ flex: 1 }}>
        <Text numberOfLines={1} style={{ color: t.fg, fontSize: 15, fontWeight: "500" }}>
          {thread.title}
        </Text>
        <Text style={{ color: t.muted, fontSize: 12, marginTop: 2 }}>
          {thread.agentId}
          {thread.model ? ` · ${thread.model}` : ""} · {relativeTime(thread.updatedAt)}
        </Text>
      </View>
      <Pressable
        onPress={onUnarchive}
        disabled={busy}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={`Unarchive ${thread.title}`}
        style={({ pressed }) => ({
          borderColor: t.border,
          borderWidth: StyleSheet.hairlineWidth,
          borderRadius: 8,
          paddingHorizontal: 10,
          paddingVertical: 6,
          backgroundColor: pressed ? t.panel2 : t.bg,
          opacity: busy ? 0.5 : 1,
        })}
      >
        <Text style={{ color: t.accent, fontSize: 13, fontWeight: "600" }}>Unarchive</Text>
      </Pressable>
    </Pressable>
  );
}
