/**
 * Chats — the home screen, and the reason the app exists: pick up a thread the desktop is running.
 * The list itself is `layout/ChatList`, shared with the tablet sidebar; here it is the whole tab
 * on a phone, and a "pick one" placeholder when the sidebar already shows it.
 */
import { router } from "expo-router";
import { ConnectionGate } from "@/components/ConnectionGate";
import { Button, Empty, Screen } from "@/components/ui";
import { ChatList } from "@/layout/ChatList";
import { hardwareKeyboardShortcutsAvailable } from "@/layout/keyboard";
import { useLayoutMode } from "@/layout/use-layout";

export default function ChatsScreen() {
  const mode = useLayoutMode();
  if (mode === "wide") {
    return (
      <Screen>
        <Empty
          title="Pick a chat from the sidebar"
          hint={
            hardwareKeyboardShortcutsAvailable
              ? "⌘N starts a new one; ⌘K searches."
              : "Or start a new one."
          }
          action={
            <Button title="New chat" variant="primary" onPress={() => router.push("/new-chat")} />
          }
        />
      </Screen>
    );
  }
  return (
    <ConnectionGate>
      <ChatList variant="screen" />
    </ConnectionGate>
  );
}
