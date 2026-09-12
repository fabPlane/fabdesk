/** Pick where a new chat lives: one of the projects, or none. */
import { useProjects } from "@fabdesk/client-core";
import { Stack } from "expo-router";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { Loading, Screen, readable } from "@/components/ui";
import { useNewChat } from "@/hooks/new-chat";
import { useTheme } from "@/theme";

export default function NewChatScreen() {
  const t = useTheme();
  const projects = useProjects();
  const { start, busy } = useNewChat();

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
        renderItem={({ item }) => (
          <Pressable
            disabled={busy}
            onPress={() => void start(item.id)}
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
              The chat uses the agent set as default on the desktop; its title comes from your first
              message.
            </Text>
          </View>
        }
      />
    </Screen>
  );
}
