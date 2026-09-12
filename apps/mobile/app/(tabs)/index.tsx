/**
 * Chats — the home screen, and the reason the app exists: pick up a thread the desktop is running.
 * The list itself is `layout/ChatList`, so a tablet sidebar can show the same thing.
 */
import { ConnectionGate } from "@/components/ConnectionGate";
import { ChatList } from "@/layout/ChatList";

export default function ChatsScreen() {
  return (
    <ConnectionGate>
      <ChatList variant="screen" />
    </ConnectionGate>
  );
}
