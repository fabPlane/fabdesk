/**
 * Starting a chat from the phone. The daemon's `defaultAgent` setting picks the agent, the model
 * is left to the daemon's default, and the thread opens straight away — the title is set from the
 * first message, the same way the desktop does it.
 */
import { useSettings, useThreadMutations } from "@fabdesk/client-core";
import { router } from "expo-router";
import { useCallback, useState } from "react";
import { Alert } from "react-native";

export function useNewChat() {
  const settings = useSettings();
  const { create } = useThreadMutations();
  const [busy, setBusy] = useState(false);

  const start = useCallback(
    async (projectId: string | null) => {
      if (busy) return;
      setBusy(true);
      try {
        const thread = await create.mutateAsync({
          projectId,
          agentId: settings.data?.defaultAgent ?? "claude",
        });
        router.push({ pathname: "/thread/[id]", params: { id: thread.id } });
      } catch (e) {
        Alert.alert("Could not start a chat", e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [busy, create, settings.data?.defaultAgent],
  );

  return { start, busy };
}
