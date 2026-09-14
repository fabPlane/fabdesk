/**
 * The frame around the navigator: the live connection to the desktop, hardware-keyboard shortcuts
 * and, on a tablet-sized window, the Chats list as a sidebar on the left with the navigator —
 * tabs, thread, project, all of it — as the pane on the right, so opening a chat fills the detail
 * side instead of covering the list. On a phone the frame is invisible.
 *
 * The navigator stays the same child in both modes so a rotation never remounts it (and never
 * loses the screen you were on): only the sidebar comes and goes.
 */
import { router } from "expo-router";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ConnectionGate } from "@/components/ConnectionGate";
import { SIDEBAR_WIDTH } from "@/lib/layout-mode";
import { CoreConnectionProvider } from "@/transport/CoreConnection";
import { useTheme } from "@/theme";
import { ChatList } from "./ChatList";
import { useKeyboardShortcut, useKeyboardShortcutsHost } from "./keyboard";
import { useLayoutMode } from "./use-layout";

export function AppShell({ children }: { children: ReactNode }) {
  const mode = useLayoutMode();
  useKeyboardShortcutsHost();
  useKeyboardShortcut("cmd+n", () => router.push("/new-chat"));
  return (
    <CoreConnectionProvider>
      <View style={{ flex: 1, flexDirection: "row" }}>
        {mode === "wide" ? <Sidebar /> : null}
        <View style={{ flex: 1 }}>{children}</View>
      </View>
    </CoreConnectionProvider>
  );
}

function Sidebar() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={{
        width: SIDEBAR_WIDTH,
        borderRightColor: t.border,
        borderRightWidth: StyleSheet.hairlineWidth,
        backgroundColor: t.bg,
        paddingTop: insets.top,
        paddingLeft: insets.left,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 16,
          paddingVertical: 10,
          borderBottomColor: t.border,
          borderBottomWidth: StyleSheet.hairlineWidth,
          backgroundColor: t.panel,
        }}
      >
        <Text style={{ color: t.fg, fontSize: 17, fontWeight: "700", flex: 1 }}>Chats</Text>
        <Pressable
          onPress={() => router.push("/new-chat")}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="New chat"
          style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1, paddingHorizontal: 6 })}
        >
          <Text style={{ color: t.accent, fontSize: 22, lineHeight: 24, fontWeight: "600" }}>
            ＋
          </Text>
        </Pressable>
      </View>
      <ConnectionGate>
        <ChatList variant="sidebar" />
      </ConnectionGate>
    </View>
  );
}
