import { Tabs } from "expo-router";
import { Text } from "react-native";
import { useKeepAwakeWhileRunning } from "@/state/keep-awake";
import { useTheme } from "@/theme";

/** Text glyphs rather than an icon pack: one less dependency for an experimental app. */
function icon(glyph: string) {
  return ({ color }: { color: string }) => <Text style={{ color, fontSize: 18 }}>{glyph}</Text>;
}

export default function TabsLayout() {
  const t = useTheme();
  // The tabs are the bottom of the stack, so this is mounted for the app's whole life.
  useKeepAwakeWhileRunning();
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: t.panel },
        headerTintColor: t.fg,
        tabBarStyle: { backgroundColor: t.panel, borderTopColor: t.border },
        tabBarActiveTintColor: t.accent,
        tabBarInactiveTintColor: t.muted,
        sceneStyle: { backgroundColor: t.bg },
      }}
    >
      <Tabs.Screen name="index" options={{ title: "Chats", tabBarIcon: icon("💬") }} />
      <Tabs.Screen name="projects" options={{ title: "Projects", tabBarIcon: icon("▦") }} />
      <Tabs.Screen name="settings" options={{ title: "Settings", tabBarIcon: icon("⚙") }} />
    </Tabs>
  );
}
