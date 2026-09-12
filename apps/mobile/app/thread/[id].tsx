/**
 * The chat view: what a run on the desktop looks like from a phone, and where you answer it.
 *
 * Messages stream in over the WebSocket into the same react-query cache the desktop uses, so this
 * screen only has to render — there is no mobile-specific streaming logic. Sending picks up the
 * thread's own agent and model, so a chat started with codex on the desktop stays on codex.
 */
import { useMessages, useRunsStore, useThread } from "@fabdesk/client-core";
import { useCoreClient } from "@fabdesk/client-core";
import type { Message } from "@fabdesk/protocol";
import { Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MessageBody } from "@/components/MessageParts";
import { Loading, Screen, readable } from "@/components/ui";
import { formatDuration } from "@/lib/format";
import { useTheme } from "@/theme";

export default function ThreadScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useTheme();
  const client = useCoreClient();
  const insets = useSafeAreaInsets();
  const thread = useThread(id ?? null);
  const messages = useMessages(id ?? null);
  const run = useRunsStore((s) => (id ? s.runsByThread[id] : undefined));
  const running = !!run;

  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const list = useRef<FlatList<Message>>(null);

  // Newest last, and the view pinned to it — the tail is what you came to read.
  const data = messages.data ?? [];
  useEffect(() => {
    if (data.length) requestAnimationFrame(() => list.current?.scrollToEnd({ animated: true }));
  }, [data.length]);

  const send = async () => {
    const content = draft.trim();
    if (!content || !id) return;
    setSending(true);
    setDraft("");
    try {
      await client.sendMessage(id, { content });
      await messages.refetch();
    } catch (e) {
      setDraft(content);
      Alert.alert("Could not send", e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  const stop = async () => {
    if (!id) return;
    try {
      await client.abort(id);
    } catch (e) {
      Alert.alert("Could not stop the run", e instanceof Error ? e.message : String(e));
    }
  };

  if (messages.isLoading) return <Loading label="Loading chat…" />;

  return (
    <Screen>
      <Stack.Screen options={{ title: thread.data?.title ?? "Chat" }} />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        // Android is edge-to-edge under Expo SDK 54, so `adjustResize` no longer shrinks the window
        // for the keyboard; padding is what works there too. The offset is the navigation header.
        behavior="padding"
        keyboardVerticalOffset={insets.top + (Platform.OS === "ios" ? 44 : 56)}
      >
        <FlatList
          ref={list}
          data={data}
          keyExtractor={(m) => m.id}
          contentContainerStyle={{ paddingVertical: 10, ...readable }}
          renderItem={({ item, index }) => (
            <MessageBody
              message={item}
              streaming={running && index === data.length - 1 && item.role === "assistant"}
            />
          )}
          ListFooterComponent={
            running ? (
              <RunBanner startedAt={run.startedAt} agentId={run.agentId} error={run.error} />
            ) : null
          }
          onContentSizeChange={() => list.current?.scrollToEnd({ animated: false })}
        />
        <View
          style={{
            borderTopColor: t.border,
            borderTopWidth: StyleSheet.hairlineWidth,
            backgroundColor: t.panel,
            padding: 10,
            paddingBottom: Math.max(10, insets.bottom),
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8, ...readable }}>
            <TextInput
              // Android in landscape otherwise swaps the screen for a full-screen editor with a DONE key.
              disableFullscreenUI
              value={draft}
              onChangeText={setDraft}
              placeholder={thread.data ? `Message ${thread.data.agentId}` : "Message"}
              placeholderTextColor={t.muted}
              multiline
              style={{
                flex: 1,
                backgroundColor: t.bg,
                borderColor: t.border,
                borderWidth: StyleSheet.hairlineWidth,
                borderRadius: 18,
                color: t.fg,
                fontSize: 15,
                maxHeight: 140,
                paddingHorizontal: 14,
                paddingTop: 10,
                paddingBottom: 10,
              }}
            />
            <Pressable
              onPress={() => void (running ? stop() : send())}
              disabled={!running && (sending || !draft.trim())}
              style={{
                backgroundColor: running ? t.danger : t.accent,
                opacity: !running && (sending || !draft.trim()) ? 0.4 : 1,
                borderRadius: 18,
                paddingHorizontal: 16,
                paddingVertical: 11,
              }}
            >
              <Text style={{ color: t.accentFg, fontWeight: "700", fontSize: 14 }}>
                {running ? "Stop" : "Send"}
              </Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

function RunBanner({
  startedAt,
  agentId,
  error,
}: {
  startedAt: number;
  agentId: string;
  error?: string | undefined;
}) {
  const t = useTheme();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const elapsed = useMemo(() => formatDuration(now - startedAt), [now, startedAt]);

  if (error) {
    return (
      <View
        style={{
          margin: 14,
          padding: 10,
          borderRadius: 8,
          backgroundColor: t.panel,
          borderColor: t.danger,
          borderWidth: StyleSheet.hairlineWidth,
        }}
      >
        <Text style={{ color: t.danger, fontSize: 13 }}>{error}</Text>
      </View>
    );
  }
  return (
    <Text style={{ color: t.muted, fontSize: 12, paddingHorizontal: 16, paddingVertical: 8 }}>
      {agentId} is working · {elapsed}
    </Text>
  );
}
