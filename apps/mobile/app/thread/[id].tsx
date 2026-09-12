/**
 * The chat view: what a run on the desktop looks like from a phone, and where you answer it.
 *
 * Messages stream in over the WebSocket into the same react-query cache the desktop uses, so this
 * screen only has to render — there is no mobile-specific streaming logic. Sending picks up the
 * thread's own agent and model, so a chat started with codex on the desktop stays on codex; the
 * pill above the input is where you change that, and it patches the thread itself.
 */
import {
  useDoctor,
  useMessages,
  useQueueMessage,
  useRunsStore,
  useSettings,
  useThread,
  useThreadMutations,
} from "@fabdesk/client-core";
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
import { AgentModelPicker } from "@/components/AgentModelPicker";
import { AttachmentStrip } from "@/components/AttachmentStrip";
import { MessageBody, PendingCards } from "@/components/MessageParts";
import { useOptionSheet } from "@/components/OptionSheet";
import { QueuedMessages } from "@/components/QueuedMessages";
import { ThreadHeaderButton, useThreadMenu } from "@/components/ThreadHeaderMenu";
import { Loading, Screen, readable } from "@/components/ui";
import { useRememberedChoice } from "@/hooks/agent-choice";
import { useAttachments } from "@/hooks/attachments";
import { usePendingForThread } from "@/hooks/pending-requests";
import { choicePatch, sameChoice, type AgentChoice } from "@/lib/agent-choice";
import {
  attachmentsBlockedReason,
  attachmentsSettled,
  messageContent,
  toMessageAttachments,
} from "@/lib/attachments";
import { formatDuration } from "@/lib/format";
import { pendingCount } from "@/lib/pending-requests";
import { composerAction, queuedMessages } from "@/lib/queued-messages";
import { useKeyboardShortcut } from "@/layout/keyboard";
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

  // Agent + model. The thread is the source of truth; `pending` covers the moment between the tap
  // and the daemon's answer so the pill does not snap back while the PATCH is in flight.
  const doctor = useDoctor();
  const settings = useSettings();
  const { patch } = useThreadMutations();
  const { remember } = useRememberedChoice();
  const menu = useThreadMenu(thread.data);
  const [pending, setPending] = useState<AgentChoice | null>(null);
  const threadChoice = useMemo<AgentChoice | null>(
    () => (thread.data ? { agentId: thread.data.agentId, model: thread.data.model ?? "" } : null),
    [thread.data?.agentId, thread.data?.model],
  );
  const choice = pending ?? threadChoice;
  useEffect(() => {
    if (pending && sameChoice(pending, threadChoice)) setPending(null);
  }, [pending, threadChoice]);
  const changeChoice = async (next: AgentChoice) => {
    if (!id || sameChoice(next, choice)) return;
    setPending(next);
    remember(next);
    try {
      await patch.mutateAsync({ id, patch: choicePatch(next) });
    } catch (e) {
      setPending(null);
      Alert.alert("Could not switch agent", e instanceof Error ? e.message : String(e));
    }
  };

  // Newest last, and the view pinned to it — the tail is what you came to read.
  const data = messages.data ?? [];
  useEffect(() => {
    if (data.length) requestAnimationFrame(() => list.current?.scrollToEnd({ animated: true }));
  }, [data.length]);

  // Supervised mode: what the run is waiting on. Cards inside messages come from their parts;
  // anything the parts do not show yet is drawn after the last message.
  const requests = usePendingForThread(id ?? null, running);
  const unplaced = useMemo(() => requests.unplaced(messages.data), [requests, messages.data]);
  useEffect(() => {
    if (unplaced.length) requestAnimationFrame(() => list.current?.scrollToEnd({ animated: true }));
  }, [unplaced.length]);

  // Photos. They upload as project sketches the moment they are picked, so `+` needs a project.
  const attachments = useAttachments(thread.data?.projectId);
  const attachSheet = useOptionSheet();
  const blocked = attachmentsBlockedReason(thread.data);
  const addPhoto = () => {
    if (blocked) {
      Alert.alert("No project", blocked);
      return;
    }
    attachSheet.show({
      options: [
        { label: "Take photo", onPress: () => void attachments.pick("camera") },
        { label: "Choose from library", onPress: () => void attachments.pick("library") },
      ],
    });
  };

  const content = messageContent(draft, attachments.pending);
  const hasContent = !!content && attachmentsSettled(attachments.pending);
  const canSend = hasContent && !sending;

  // While a run is live the same draft is queued instead: the daemon holds it and sends it when
  // the run ends. Either way the composer clears at once and restores on failure.
  const queue = useQueueMessage();
  const queued = useMemo(() => queuedMessages(messages.data), [messages.data]);
  const action = composerAction({ running, hasContent, sending });

  const send = async () => {
    if (!canSend || !id) return;
    const text = draft;
    const sent = attachments.pending;
    const input = { content, attachments: toMessageAttachments(sent) };
    setSending(true);
    setDraft("");
    attachments.clear();
    try {
      if (running) await queue.mutateAsync({ threadId: id, input });
      else await client.sendMessage(id, input);
      await messages.refetch();
    } catch (e) {
      setDraft(text);
      attachments.restore(sent);
      Alert.alert(
        running ? "Could not queue" : "Could not send",
        e instanceof Error ? e.message : String(e),
      );
    } finally {
      setSending(false);
    }
  };

  // ⌘↩ on a hardware keyboard (iPad, the Thor) sends — or queues, while a run is live; inert
  // without the native key-command module.
  useKeyboardShortcut("cmd+enter", canSend ? () => void send() : undefined);

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
      <Stack.Screen
        options={{
          title: thread.data?.title ?? "Chat",
          headerRight: () => (
            <ThreadHeaderButton onPress={menu.open} disabled={!thread.data || menu.busy} />
          ),
        }}
      />
      {menu.overlays}
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
              projectId={thread.data?.projectId}
              pending={requests}
            />
          )}
          ListFooterComponent={
            <>
              <PendingCards parts={unplaced} pending={requests} />
              {running ? (
                <RunBanner
                  startedAt={run.startedAt}
                  agentId={run.agentId}
                  error={run.error}
                  waiting={pendingCount(requests.pending) > 0}
                />
              ) : null}
            </>
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
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              marginBottom: 8,
              ...readable,
            }}
          >
            {choice ? (
              <AgentModelPicker
                value={choice}
                onChange={(next) => void changeChoice(next)}
                agents={doctor.data?.agents ?? []}
                settings={settings.data}
                disabled={running || patch.isPending}
              />
            ) : null}
          </View>
          <View style={readable}>
            {id ? <QueuedMessages threadId={id} messages={queued} /> : null}
            <AttachmentStrip items={attachments.pending} onRemove={attachments.remove} />
          </View>
          {attachSheet.sheet}
          <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8, ...readable }}>
            <Pressable
              onPress={addPhoto}
              disabled={sending}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel={blocked ? `Attach photo (${blocked})` : "Attach photo"}
              style={({ pressed }) => ({
                width: 38,
                height: 38,
                borderRadius: 19,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: pressed ? t.panel2 : t.bg,
                borderColor: t.border,
                borderWidth: StyleSheet.hairlineWidth,
                opacity: blocked ? 0.45 : 1,
              })}
            >
              <Text style={{ color: t.fg, fontSize: 22, lineHeight: 24, fontWeight: "300" }}>
                ＋
              </Text>
            </Pressable>
            <TextInput
              // Android in landscape otherwise swaps the screen for a full-screen editor with a DONE key.
              disableFullscreenUI
              value={draft}
              onChangeText={setDraft}
              placeholder={choice ? `Message ${choice.agentId}` : "Message"}
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
            {action.kind === "queue" ? (
              // Stop stays reachable while a draft turns the main button into Queue.
              <Pressable
                onPress={() => void stop()}
                accessibilityRole="button"
                accessibilityLabel="Stop the run"
                hitSlop={6}
                style={({ pressed }) => ({
                  width: 38,
                  height: 38,
                  borderRadius: 19,
                  alignItems: "center",
                  justifyContent: "center",
                  borderColor: t.danger,
                  borderWidth: 1,
                  backgroundColor: pressed ? t.panel2 : "transparent",
                })}
              >
                <Text style={{ color: t.danger, fontSize: 12, fontWeight: "700" }}>■</Text>
              </Pressable>
            ) : null}
            <Pressable
              onPress={() => void (action.kind === "stop" ? stop() : send())}
              disabled={!action.enabled}
              accessibilityRole="button"
              accessibilityLabel={action.label}
              style={{
                backgroundColor: action.kind === "stop" ? t.danger : t.accent,
                opacity: action.enabled ? 1 : 0.4,
                borderRadius: 18,
                paddingHorizontal: 16,
                paddingVertical: 11,
              }}
            >
              <Text style={{ color: t.accentFg, fontWeight: "700", fontSize: 14 }}>
                {action.label}
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
  waiting,
}: {
  startedAt: number;
  agentId: string;
  error?: string | undefined;
  /** The run is paused on an approval or a question rather than working. */
  waiting?: boolean | undefined;
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
    <Text
      style={{
        color: waiting ? t.warning : t.muted,
        fontSize: 12,
        paddingHorizontal: 16,
        paddingVertical: 8,
      }}
    >
      {agentId} {waiting ? "is waiting for you" : "is working"} · {elapsed}
    </Text>
  );
}
