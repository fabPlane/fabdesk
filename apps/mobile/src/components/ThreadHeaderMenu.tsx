/**
 * The `…` in the thread screen's header and the menu behind it.
 *
 * The button lives in the navigation header, but the sheet and the rename prompt are hosted by the
 * screen (`overlays`), because `headerRight` is re-created on every options change and is not a
 * good home for state.
 */
import type { Thread } from "@fabdesk/protocol";
import { router } from "expo-router";
import { useCallback, type ReactNode } from "react";
import { Pressable, Text } from "react-native";
import { useThreadActions } from "@/hooks/thread-actions";
import { threadMenuItems, type ThreadAction } from "@/lib/thread-actions";
import { useTheme } from "@/theme";
import { useOptionSheet } from "./OptionSheet";
import { useTextPrompt } from "./TextPrompt";

export function useThreadMenu(thread: Thread | undefined): {
  open: () => void;
  overlays: ReactNode;
  busy: boolean;
} {
  const actions = useThreadActions();
  const { show, sheet } = useOptionSheet();
  const { prompt, element } = useTextPrompt();

  const run = useCallback(
    async (t: Thread, action: ThreadAction) => {
      switch (action) {
        case "rename":
          prompt({
            title: "Rename chat",
            initial: t.title,
            submitLabel: "Rename",
            onSubmit: (v) => void actions.rename(t, v),
          });
          return;
        case "pin":
          await actions.togglePin(t);
          return;
        case "archive":
          // Archiving hides it from Chats, so leave the screen the way delete does; unarchiving
          // (from the Archived list) keeps you where you are.
          if ((await actions.toggleArchive(t)) && !t.archived) router.back();
          return;
        case "branch": {
          const created = await actions.branch(t);
          if (created) router.push({ pathname: "/thread/[id]", params: { id: created.id } });
          return;
        }
        case "delete":
          if (await actions.delete(t)) router.back();
          return;
      }
    },
    [actions, prompt],
  );

  const open = useCallback(() => {
    if (!thread) return;
    show({
      options: threadMenuItems(thread).map((item) => ({
        label: item.label,
        destructive: item.destructive,
        onPress: () => void run(thread, item.action),
      })),
    });
  }, [thread, show, run]);

  return {
    open,
    overlays: (
      <>
        {sheet}
        {element}
      </>
    ),
    busy: actions.busy,
  };
}

/** The header button itself; kept dumb so `headerRight` can render it from a closure. */
export function ThreadHeaderButton({
  onPress,
  disabled,
}: {
  onPress: () => void;
  disabled?: boolean | undefined;
}) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={12}
      accessibilityRole="button"
      accessibilityLabel="Chat actions"
      style={{ opacity: disabled ? 0.4 : 1, paddingHorizontal: 4 }}
    >
      <Text style={{ color: t.accent, fontSize: 22, lineHeight: 24, fontWeight: "700" }}>…</Text>
    </Pressable>
  );
}
