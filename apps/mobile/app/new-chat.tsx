/** Pick the agent and model, then where the new chat lives: one of the projects, or none. */
import { useProjects } from "@fabdesk/client-core";
import { Stack } from "expo-router";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { AgentModelPicker } from "@/components/AgentModelPicker";
import { Loading, Screen, readable } from "@/components/ui";
import { useNewChat } from "@/hooks/new-chat";
import { useTheme } from "@/theme";

export default function NewChatScreen() {
  const t = useTheme();
  const projects = useProjects();
  const { start, busy, choice, setChoice, agents, settings, ready } = useNewChat();

  if (projects.isLoading) return <Loading label="Loading projects…" />;

  const rows: { id: string | null; name: string; hint: string }[] = [
    { id: null, name: "No project", hint: "A general chat; it cannot touch a board" },
    ...(projects.data ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      hint: "Chat inside this project",
    })),
  ];

  return (
    <Screen>
      <Stack.Screen options={{ title: "New chat" }} />
      <FlatList
        data={rows}
        keyExtractor={(r) => r.id ?? "none"}
        contentContainerStyle={{ paddingVertical: 8, ...readable }}
        ListHeaderComponent={
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              paddingHorizontal: 16,
              paddingVertical: 12,
              borderBottomColor: t.border,
              borderBottomWidth: StyleSheet.hairlineWidth,
            }}
          >
            <Text style={{ color: t.muted, fontSize: 13 }}>Agent</Text>
            <AgentModelPicker
              value={choice}
              onChange={setChoice}
              agents={agents}
              settings={settings}
              disabled={!ready}
            />
          </View>
        }
        renderItem={({ item }) => (
          <Pressable
            disabled={busy || !ready}
            onPress={() => void start(item.id, choice)}
            style={({ pressed }) => ({
              backgroundColor: pressed ? t.panel2 : t.panel,
              borderBottomColor: t.border,
              borderBottomWidth: StyleSheet.hairlineWidth,
              paddingHorizontal: 16,
              paddingVertical: 14,
              opacity: busy ? 0.6 : 1,
            })}
          >
            <Text style={{ color: t.fg, fontSize: 15, fontWeight: "500" }}>{item.name}</Text>
            <Text style={{ color: t.muted, fontSize: 12, marginTop: 2 }}>{item.hint}</Text>
          </Pressable>
        )}
        ListFooterComponent={
          <View style={{ padding: 16 }}>
            <Text style={{ color: t.muted, fontSize: 12 }}>
              The agent you pick here is remembered on this phone; the chat's title comes from your
              first message.
            </Text>
          </View>
        }
      />
    </Screen>
  );
}
