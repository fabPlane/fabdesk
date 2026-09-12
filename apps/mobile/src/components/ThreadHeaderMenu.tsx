/**
 * The `…` in the thread screen's header and the menu behind it.
 *
 * The button lives in the navigation header, but the sheet and the rename prompt are hosted by the
 * screen (`overlays`), because `headerRight` is re-created on every options change and is not a
 * good home for state.
 *
 * The first row is the runtime mode (Full access / Supervised): it opens a second sheet, greyed
 * for an agent whose adapter cannot pause. The rest are the thread actions.
 */
import { useDoctor, useSetRuntimeMode } from "@fabdesk/client-core";
import type { Thread } from "@fabdesk/protocol";
import { router } from "expo-router";
import { useCallback, type ReactNode } from "react";
import { Alert, Pressable, Text } from "react-native";
import { useThreadActions } from "@/hooks/thread-actions";
import {
  runtimeModeOf,
  runtimeModeOptions,
  type AgentWithSupervised,
  type RuntimeMode,
  type ThreadWithMode,
} from "@/lib/pending-requests";
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
  const doctor = useDoctor();
  const setMode = useSetRuntimeMode();

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

  const changeMode = useCallback(
    async (t: Thread, runtimeMode: RuntimeMode) => {
      if (runtimeModeOf(t as ThreadWithMode) === runtimeMode) return;
      try {
        await setMode.mutateAsync({ threadId: t.id, runtimeMode });
      } catch (e) {
        Alert.alert("Could not change the mode", e instanceof Error ? e.message : String(e));
      }
    },
    [setMode],
  );

  const openModeSheet = useCallback(
    (t: Thread) => {
      const agent = (doctor.data?.agents as AgentWithSupervised[] | undefined)?.find(
        (a) => a.id === t.agentId,
      );
      show({
        title: "Runtime mode",
        message: "Supervised pauses writes and shell commands until you approve them.",
        options: runtimeModeOptions(runtimeModeOf(t as ThreadWithMode), agent).map((o) => ({
          label: o.label,
          hint: o.hint,
          selected: o.selected,
          disabled: o.disabled,
          onPress: () => void changeMode(t, o.mode),
        })),
      });
    },
    [doctor.data?.agents, show, changeMode],
  );

  const open = useCallback(() => {
    if (!thread) return;
    const mode = runtimeModeOf(thread as ThreadWithMode);
    show({
      options: [
        {
          label: mode === "supervised" ? "Mode: Supervised" : "Mode: Full access",
          hint: "Change how much the agent may do unasked",
          onPress: () => openModeSheet(thread),
        },
        ...threadMenuItems(thread).map((item) => ({
          label: item.label,
          destructive: item.destructive,
          onPress: () => void run(thread, item.action),
        })),
      ],
    });
  }, [thread, show, run, openModeSheet]);

  return {
    open,
    overlays: (
      <>
        {sheet}
        {element}
      </>
    ),
    busy: actions.busy || setMode.isPending,
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
