import { router, Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { Pressable, Text } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AppShell } from "@/layout/AppShell";
import { NotificationTapHandler } from "@/notifications/NotificationTapHandler";
import { Observability } from "@/observability";
import { useConnections } from "@/transport/connections";
import { useTheme } from "@/theme";

export default function RootLayout() {
  const t = useTheme();
  const hydrate = useConnections((s) => s.hydrate);
  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        {/* The connection provider plus, on tablets, the Chats sidebar; every route stays in this Stack. */}
        <AppShell>
          <StatusBar style={t.dark ? "light" : "dark"} />
          <Stack
            screenOptions={{
              headerStyle: { backgroundColor: t.panel },
              headerTintColor: t.fg,
              headerTitleStyle: { fontSize: 16 },
              contentStyle: { backgroundColor: t.bg },
              // Otherwise the back button is titled after the route group it came from: "(tabs)".
              headerBackButtonDisplayMode: "minimal",
            }}
          >
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen name="connect/index" options={{ title: "Connections" }} />
            <Stack.Screen name="connect/scan" options={{ title: "Scan pairing code" }} />
            <Stack.Screen name="pair" options={{ title: "Pairing" }} />
            <Stack.Screen name="new-chat" options={{ title: "New chat", presentation: "modal" }} />
            <Stack.Screen name="thread/[id]" options={{ title: "Chat" }} />
            <Stack.Screen name="project/[id]" options={{ title: "Project" }} />
            <Stack.Screen name="renders/[id]" options={{ title: "Renders" }} />
            <Stack.Screen name="drc/[id]" options={{ title: "DRC" }} />
            <Stack.Screen name="jobs" options={{ title: "Jobs" }} />
            <Stack.Screen
              name="new-project"
              options={{ title: "New project", presentation: "modal" }}
            />
            <Stack.Screen name="catalog/index" options={{ title: "Open-source boards" }} />
            <Stack.Screen name="catalog/[owner]/[slug]" options={{ title: "Board" }} />
            <Stack.Screen name="files/[id]/index" options={{ title: "Files" }} />
            <Stack.Screen name="files/[id]/view" options={{ title: "File" }} />
            <Stack.Screen
              name="files/[id]/edit"
              options={{ title: "Edit", presentation: "modal", gestureEnabled: false }}
            />
            <Stack.Screen
              name="board/[id]"
              options={{
                title: "Board",
                presentation: "fullScreenModal",
                // A full-screen modal cannot be swiped away, so it needs its own way out.
                headerRight: () => (
                  <Pressable
                    onPress={() => router.back()}
                    hitSlop={12}
                    accessibilityRole="button"
                    accessibilityLabel="Close"
                  >
                    <Text style={{ color: t.accent, fontSize: 16 }}>Close</Text>
                  </Pressable>
                ),
              }}
            />
            <Stack.Screen name="archived" options={{ title: "Archived" }} />
            <Stack.Screen name="svg/[id]" options={{ title: "Schematic" }} />
            <Stack.Screen name="three/[id]" options={{ title: "3D" }} />
            <Stack.Screen name="cinema/index" options={{ title: "Route runs" }} />
            <Stack.Screen name="cinema/[runId]" options={{ title: "Route run" }} />
          </Stack>
          {/* Notification taps → thread/jobs (docs/mobile-notifications.md §4.3). Renders nothing. */}
          <NotificationTapHandler />
          {/* Sentry tags + transport-failure events (src/observability.ts). Renders nothing. */}
          <Observability />
        </AppShell>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
