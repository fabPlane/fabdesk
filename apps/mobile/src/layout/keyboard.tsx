/**
 * Hardware-keyboard shortcuts (iPad, the AYN Thor, a phone with a Bluetooth keyboard).
 *
 * `useKeyboardShortcut("cmd+n", fn)` binds while the calling component is mounted; the newest
 * binding for a combo wins, so a pushed screen shadows the list underneath it. The presses come
 * from `modules/fabdesk-key-commands`; without that native build every binding is a no-op, which
 * is how Expo Go behaves.
 *
 * Bindings so far: ⌘N new chat (app shell), ⌘K focus the chat search (Chats list). ⌘↩ send is the
 * thread screen's to wire: `useKeyboardShortcut("cmd+enter", send)` next to its composer.
 */
import { useEffect, useRef } from "react";
import { createShortcutRegistry, type ShortcutHandler } from "@/lib/shortcut-registry";
import { KeyCommands } from "./key-commands-native";

const registry = createShortcutRegistry((ids) => KeyCommands?.setCommands(ids));

/** Mount once, at the root. Subscribes to native presses for as long as it is mounted. */
export function useKeyboardShortcutsHost(): void {
  useEffect(() => {
    if (!KeyCommands) return;
    const sub = KeyCommands.addListener("onKeyCommand", ({ id }) => registry.dispatch(id));
    // The native side may have started after the first bindings registered.
    KeyCommands.setCommands(registry.ids());
    return () => sub.remove();
  }, []);
}

/**
 * Binds `combo` to `handler` for the component's lifetime. Pass `undefined` to unbind without
 * unmounting (a disabled Send button, say). The latest handler is used without re-registering.
 */
export function useKeyboardShortcut(combo: string, handler: ShortcutHandler | undefined): void {
  const latest = useRef(handler);
  latest.current = handler;
  const bound = handler !== undefined;
  useEffect(() => {
    if (!bound) return;
    const off = registry.register(combo, () => latest.current?.());
    return () => off?.();
  }, [combo, bound]);
}

/** Whether presses can arrive at all — for a "keyboard shortcuts" hint that should not lie. */
export const hardwareKeyboardShortcutsAvailable = KeyCommands !== null;
