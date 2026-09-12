/**
 * The messages waiting for the current run to finish, as chips above the composer. ✕ withdraws
 * one (`DELETE /threads/:id/messages/:id`); the daemon refuses once it has been sent, in which
 * case the refetch simply shows it as a normal message.
 */
import { useUnqueueMessage } from "@fabdesk/client-core";
import type { Message } from "@fabdesk/protocol";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { chipLabel } from "@/lib/queued-messages";
import { useTheme } from "@/theme";

export function QueuedMessages({ threadId, messages }: { threadId: string; messages: Message[] }) {
  const t = useTheme();
  const unqueue = useUnqueueMessage();
  if (messages.length === 0) return null;

  const remove = (m: Message) =>
    unqueue
      .mutateAsync({ threadId, messageId: m.id })
      .catch((e: unknown) =>
        Alert.alert("Could not withdraw", e instanceof Error ? e.message : String(e)),
      );

  return (
    <View style={{ marginBottom: 8, gap: 4 }}>
      <Text style={{ color: t.muted, fontSize: 11 }}>Queued · sends when the run ends</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="always"
      >
        <View style={{ flexDirection: "row", gap: 6 }}>
          {messages.map((m) => (
            <View
              key={m.id}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                backgroundColor: t.panel2,
                borderColor: t.border,
                borderWidth: StyleSheet.hairlineWidth,
                borderRadius: 14,
                paddingLeft: 10,
                paddingRight: 4,
                paddingVertical: 4,
                maxWidth: 260,
              }}
            >
              <Text numberOfLines={1} style={{ color: t.fg, fontSize: 13, flexShrink: 1 }}>
                {chipLabel(m)}
              </Text>
              <Pressable
                onPress={() => void remove(m)}
                disabled={unqueue.isPending}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={`Withdraw queued message: ${chipLabel(m)}`}
                style={{ paddingHorizontal: 4, paddingVertical: 1 }}
              >
                <Text style={{ color: t.muted, fontSize: 14, fontWeight: "700" }}>✕</Text>
              </Pressable>
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}
