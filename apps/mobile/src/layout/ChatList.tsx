/**
 * The Chats list — the home screen on a phone, the sidebar on a tablet. Grouped by project with
 * the same helper the desktop sidebar uses so both agree on the order; sorting, folding and the
 * unread dot come from `lib/chat-list` and are remembered locally.
 */
import { groupThreadsByProject, useProjects, useRunsStore, useThreads } from "@fabdesk/client-core";
import type { Thread } from "@fabdesk/protocol";
import { router, usePathname } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, SectionList, StyleSheet, Text, TextInput, View } from "react-native";
import { EnvironmentSwitcher } from "@/components/EnvironmentSwitcher";
import { Button, Empty, Loading, Screen, readable } from "@/components/ui";
import { usePullRefresh } from "@/components/pull-refresh";
import { useNewChat } from "@/hooks/new-chat";
import {
  buildSections,
  isUnread,
  sortModeLabel,
  threadIdFromPath,
  type ChatSection,
} from "@/lib/chat-list";
import { haptic } from "@/state/haptics";
import { useChatList } from "@/state/chat-list";
import { useConnection } from "@/transport/CoreConnection";
import { relativeTime } from "@/lib/format";
import { useTheme } from "@/theme";
import { useKeyboardShortcut } from "./keyboard";

export function ChatList({ variant }: { variant: "screen" | "sidebar" }) {
  const t = useTheme();
  const { connection, status } = useConnection();
  const [q, setQ] = useState("");
  const search = useRef<TextInput>(null);
  const threads = useThreads(q ? { q } : undefined);
  const projects = useProjects();
  const refreshControl = usePullRefresh(threads.refetch);
  const runningThreads = useRunsStore((s) => s.runsByThread);
  const newChat = useNewChat();
  const prefs = useChatList();
  const pathname = usePathname();
  const wide = variant === "sidebar";

  // The thread on screen right now (pushed over this list, or in the detail pane beside it) stays
  // read while it streams — a dot for the chat you are looking at would be noise.
  const viewingId = threadIdFromPath(pathname);
  const viewing = viewingId ? threads.data?.find((x) => x.id === viewingId) : undefined;
  const markSeen = prefs.markSeen;
  useEffect(() => {
    if (viewingId) markSeen(viewingId, viewing?.updatedAt);
  }, [viewingId, viewing?.updatedAt, markSeen]);

  useKeyboardShortcut("cmd+k", () => search.current?.focus());

  const sections = useMemo(
    () =>
      buildSections({
        groups: groupThreadsByProject(threads.data ?? [], projects.data ?? []),
        prefs,
        isRunning: (id) => !!runningThreads[id],
      }),
    [threads.data, projects.data, prefs, runningThreads],
  );

  const open = useCallback(
    (thread: Thread) => {
      haptic("selection");
      markSeen(thread.id, thread.updatedAt);
      const href = { pathname: "/thread/[id]", params: { id: thread.id } } as const;
      // Beside a detail pane, swapping the thread must not stack screens up behind the back button.
      if (threadIdFromPath(pathname)) router.replace(href);
      else router.push(href);
    },
    [markSeen, pathname],
  );

  if (threads.isLoading) return <Loading label="Loading chats…" />;

  const width = wide ? {} : readable;

  return (
    <Screen>
      <View style={{ padding: 12, paddingBottom: 6, ...width }}>
        <TextInput
          ref={search}
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
        <View style={{ flexDirection: "row", alignItems: "center", marginTop: 6, gap: 12 }}>
          {/* Which computer these chats belong to; tap to switch or pair another. */}
          <EnvironmentSwitcher />
          <Pressable
            onPress={() => prefs.setSort(prefs.sort === "updated" ? "created" : "updated")}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={`Sort by ${sortModeLabel[prefs.sort]}; tap to change`}
            style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1, flexDirection: "row", gap: 4 })}
          >
            <Text style={{ color: t.muted, fontSize: 12 }}>Sort</Text>
            <Text style={{ color: t.accent, fontSize: 12, fontWeight: "600" }}>
              {sortModeLabel[prefs.sort]} ⇅
            </Text>
          </Pressable>
          <View style={{ flex: 1 }} />
          <Pressable
            onPress={() => router.push("/archived")}
            hitSlop={8}
            accessibilityRole="button"
            style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
          >
            <Text style={{ color: t.accent, fontSize: 12, fontWeight: "600" }}>Archived ›</Text>
          </Pressable>
        </View>
      </View>
      <SectionList
        sections={sections}
        keyExtractor={(item) => item.id}
        refreshControl={refreshControl}
        stickySectionHeadersEnabled
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
          sections.length === 0 ? { flexGrow: 1 } : { paddingBottom: 24, ...width }
        }
        renderSectionHeader={({ section }) => (
          <SectionHeader
            section={section}
            onToggle={() => {
              haptic("selection");
              prefs.toggleGroup(section.key);
            }}
            onNew={newChat.busy ? undefined : (projectId) => void newChat.start(projectId)}
          />
        )}
        renderItem={({ item }) => (
          <ThreadRow
            thread={item}
            running={!!runningThreads[item.id]}
            unread={isUnread(item, prefs)}
            active={wide && item.id === viewingId}
            onPress={() => open(item)}
          />
        )}
      />
    </Screen>
  );
}

/**
 * A project's header doubles as the way to start a chat in it — a project with no chats yet is
 * otherwise a row that does nothing. The pinned group has no project to start one in. Tapping the
 * title folds the group; a folded header keeps its counts so it still says something.
 */
function SectionHeader({
  section,
  onToggle,
  onNew,
}: {
  section: ChatSection;
  onToggle: () => void;
  onNew?: ((projectId: string | null) => void) | undefined;
}) {
  const t = useTheme();
  const { group, collapsed, total, unread, running } = section;
  const canStart = group.kind !== "pinned" && onNew;
  const summary = collapsed
    ? [`${total}`, unread ? `${unread} unread` : null, running ? `${running} running` : null]
        .filter(Boolean)
        .join(" · ")
    : null;
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
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityState={{ expanded: !collapsed }}
        accessibilityLabel={`${group.title}, ${collapsed ? "collapsed" : "expanded"}`}
        style={({ pressed }) => ({
          flex: 1,
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          paddingVertical: 6,
          opacity: pressed ? 0.5 : 1,
        })}
      >
        <Text style={{ color: t.muted, fontSize: 10, width: 10 }}>{collapsed ? "▶" : "▼"}</Text>
        <Text
          numberOfLines={1}
          style={{
            color: t.muted,
            fontSize: 11,
            fontWeight: "700",
            letterSpacing: 0.6,
            textTransform: "uppercase",
            flexShrink: 1,
          }}
        >
          {group.title}
        </Text>
        {summary ? (
          <Text style={{ color: unread ? t.accent : t.muted, fontSize: 11 }}>{summary}</Text>
        ) : null}
      </Pressable>
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

function ThreadRow({
  thread,
  running,
  unread,
  active,
  onPress,
}: {
  thread: Thread;
  running: boolean;
  unread: boolean;
  active: boolean;
  onPress: () => void;
}) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityState={{ selected: active }}
      style={({ pressed }) => ({
        backgroundColor: pressed || active ? t.panel2 : t.panel,
        borderBottomColor: t.border,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderLeftColor: active ? t.accent : "transparent",
        borderLeftWidth: 3,
        paddingLeft: 13,
        paddingRight: 16,
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
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text
            numberOfLines={1}
            style={{
              color: t.fg,
              fontSize: 15,
              fontWeight: unread || thread.pinned ? "700" : "500",
              flexShrink: 1,
            }}
          >
            {thread.pinned ? "📌 " : ""}
            {thread.title}
          </Text>
          {unread ? (
            <View
              accessibilityLabel="Unread"
              style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: t.accent }}
            />
          ) : null}
        </View>
        <Text style={{ color: t.muted, fontSize: 12, marginTop: 2 }}>
          {thread.agentId}
          {thread.model ? ` · ${thread.model}` : ""} · {relativeTime(thread.updatedAt)}
        </Text>
      </View>
    </Pressable>
  );
}
