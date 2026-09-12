/**
 * Starting a chat from the phone. The agent and model are whatever this phone used last (falling
 * back to the daemon's `defaultAgent` setting), unless the caller passes an explicit choice, and
 * the thread opens straight away — the title is set from the first message, the same way the
 * desktop does it.
 */
import { useThreadMutations } from "@fabdesk/client-core";
import { router } from "expo-router";
import { useCallback, useState } from "react";
import { Alert } from "react-native";
import { useNewChatChoice } from "./agent-choice";
import { type AgentChoice } from "@/lib/agent-choice";

export function useNewChat() {
  const { create } = useThreadMutations();
  const defaults = useNewChatChoice();
  const [busy, setBusy] = useState(false);

  const start = useCallback(
    async (projectId: string | null, choice: AgentChoice = defaults.choice) => {
      if (busy) return;
      setBusy(true);
      try {
        const thread = await create.mutateAsync({
          projectId,
          agentId: choice.agentId,
          ...(choice.model ? { model: choice.model } : {}),
        });
        router.push({ pathname: "/thread/[id]", params: { id: thread.id } });
      } catch (e) {
        Alert.alert("Could not start a chat", e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [busy, create, defaults.choice],
  );

  return { start, busy, ...defaults };
}
