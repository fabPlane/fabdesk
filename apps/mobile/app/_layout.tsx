import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { CoreConnectionProvider } from "@/transport/CoreConnection";
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
        <CoreConnectionProvider>
          <StatusBar style={t.dark ? "light" : "dark"} />
          <Stack
            screenOptions={{
              headerStyle: { backgroundColor: t.panel },
              headerTintColor: t.fg,
              headerTitleStyle: { fontSize: 16 },
              contentStyle: { backgroundColor: t.bg },
            }}
          >
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen name="connect/index" options={{ title: "Connections" }} />
            <Stack.Screen name="connect/scan" options={{ title: "Scan pairing code" }} />
            <Stack.Screen name="thread/[id]" options={{ title: "Chat" }} />
            <Stack.Screen name="project/[id]" options={{ title: "Project" }} />
            <Stack.Screen name="board/[id]" options={{ title: "Board", presentation: "fullScreenModal" }} />
            <Stack.Screen name="svg/[id]" options={{ title: "Schematic" }} />
            <Stack.Screen name="three/[id]" options={{ title: "3D" }} />
            <Stack.Screen name="cinema/index" options={{ title: "Route runs" }} />
            <Stack.Screen name="cinema/[runId]" options={{ title: "Route run" }} />
          </Stack>
        </CoreConnectionProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
