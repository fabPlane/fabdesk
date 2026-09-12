/**
 * Chats — the home screen, and the reason the app exists: pick up a thread the desktop is running.
 * Grouped by project with the same helper the desktop sidebar uses, so both agree on the order.
 */
import {
  groupThreadsByProject,
  useProjects,
  useRunsStore,
  useThreads,
  type ProjectThreadGroup,
} from "@fabdesk/client-core";
import type { Thread } from "@fabdesk/protocol";
import { router } from "expo-router";
import { useMemo, useState } from "react";
import { Pressable, SectionList, StyleSheet, Text, TextInput, View } from "react-native";
import { ConnectionGate } from "@/components/ConnectionGate";
import { Button, Empty, Loading, Screen, readable } from "@/components/ui";
import { useNewChat } from "@/hooks/new-chat";
import { useConnection } from "@/transport/CoreConnection";
import { usePullRefresh } from "@/components/pull-refresh";
import { useTheme } from "@/theme";
import { relativeTime } from "@/lib/format";

export default function ChatsScreen() {
  return (
    <ConnectionGate>
      <Chats />
    </ConnectionGate>
  );
}

function Chats() {
  const t = useTheme();
  const { connection, status } = useConnection();
  const [q, setQ] = useState("");
  const threads = useThreads(q ? { q } : undefined);
  const projects = useProjects();
  const refreshControl = usePullRefresh(threads.refetch);
  const runningThreads = useRunsStore((s) => s.runsByThread);
  const newChat = useNewChat();

  const sections = useMemo(() => {
    const groups = groupThreadsByProject(threads.data ?? [], projects.data ?? []);
    return groups.map((g) => ({ title: g.title, data: g.threads, group: g }));
  }, [threads.data, projects.data]);

  if (threads.isLoading) return <Loading label="Loading chats…" />;

  return (
    <Screen>
      <View style={{ padding: 12, paddingBottom: 6, ...readable }}>
        <TextInput
          // Android in landscape otherwise swaps the screen for a full-screen editor with a DONE key.
          disableFullscreenUI
          value={q}
          onChangeText={setQ}
          placeholder="Search chats"
          placeholderTextColor={t.muted}
          autoCapitalize="none"
          style={{
            backgroundColor: t.panel,
            borderColor: t.border,
            borderWidth: StyleSheet.hairlineWidth,
            borderRadius: 10,
            color: t.fg,
            paddingHorizontal: 12,
            paddingVertical: 9,
            fontSize: 15,
          }}
        />
        {status !== "open" && (
          <Text style={{ color: t.warning, fontSize: 12, marginTop: 6 }}>
            {status === "reconnecting" ? "Reconnecting…" : "Connecting…"} · {connection?.name}
          </Text>
        )}
      </View>
      <SectionList
        sections={sections}
        keyExtractor={(item) => item.id}
        refreshControl={refreshControl}
        ListEmptyComponent={
          <Empty
            title={q ? "No chats match" : "No chats yet"}
            hint={q ? undefined : "Start one here or on the desktop; they show up on both."}
            action={
              q ? undefined : (
                <Button
                  title="New chat"
                  variant="primary"
                  onPress={() => router.push("/new-chat")}
                />
              )
            }
          />
        }
        contentContainerStyle={
          sections.length === 0 ? { flexGrow: 1 } : { paddingBottom: 24, ...readable }
        }
        renderSectionHeader={({ section }) => (
          <SectionHeader
            group={section.group}
            onNew={newChat.busy ? undefined : (projectId) => void newChat.start(projectId)}
          />
        )}
        renderItem={({ item }) => <ThreadRow thread={item} running={!!runningThreads[item.id]} />}
      />
    </Screen>
  );
}

/**
 * A project's header doubles as the way to start a chat in it — a project with no chats yet is
 * otherwise a row that does nothing. The pinned group has no project to start one in.
 */
function SectionHeader({
  group,
  onNew,
}: {
  group: ProjectThreadGroup;
  onNew?: ((projectId: string | null) => void) | undefined;
}) {
  const t = useTheme();
  const canStart = group.kind !== "pinned" && onNew;
  return (
    <View
      style={{
        backgroundColor: t.bg,
        flexDirection: "row",
        alignItems: "center",
        paddingLeft: 16,
        paddingRight: 6,
      }}
    >
      <Text
        style={{
          color: t.muted,
          fontSize: 11,
          fontWeight: "700",
          letterSpacing: 0.6,
          paddingVertical: 6,
          textTransform: "uppercase",
          flex: 1,
        }}
      >
        {group.title}
      </Text>
      {canStart ? (
        <Pressable
          onPress={() => onNew(group.projectId)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={`New chat in ${group.title}`}
          style={({ pressed }) => ({
            paddingHorizontal: 10,
            paddingVertical: 4,
            opacity: pressed ? 0.5 : 1,
          })}
        >
          <Text style={{ color: t.accent, fontSize: 18, lineHeight: 20, fontWeight: "600" }}>
            ＋
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function ThreadRow({ thread, running }: { thread: Thread; running: boolean }) {
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
        gap: 10,
      })}
    >
      <View
        style={{
          width: 8,
          height: 8,
          borderRadius: 4,
          backgroundColor: running ? t.success : "transparent",
        }}
      />
      <View style={{ flex: 1 }}>
        <Text
          numberOfLines={1}
          style={{ color: t.fg, fontSize: 15, fontWeight: thread.pinned ? "700" : "500" }}
        >
          {thread.pinned ? "📌 " : ""}
          {thread.title}
        </Text>
        <Text style={{ color: t.muted, fontSize: 12, marginTop: 2 }}>
          {thread.agentId}
          {thread.model ? ` · ${thread.model}` : ""} · {relativeTime(thread.updatedAt)}
        </Text>
      </View>
    </Pressable>
  );
}
