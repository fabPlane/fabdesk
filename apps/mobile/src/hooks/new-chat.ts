/**
 * Starting a chat from the phone. The agent and model are whatever this phone used last (falling
 * back to the daemon's `defaultAgent` setting), unless the caller passes an explicit choice, and
 * the thread opens straight away — the title is set from the first message, the same way the
 * desktop does it.
 *
 * The runtime mode starts at the daemon's `defaultRuntimeMode` and falls back to full access
 * when the chosen agent cannot pause (`supportsSupervised` false or absent).
 */
import { useThreadMutations, type CreateThreadInput } from "@fabdesk/client-core";
import { router } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { Alert } from "react-native";
import { useNewChatChoice } from "./agent-choice";
import { type AgentChoice } from "@/lib/agent-choice";
import {
  agentSupportsSupervised,
  defaultRuntimeMode,
  type AgentWithSupervised,
  type RuntimeMode,
} from "@/lib/pending-requests";

export function useNewChat() {
  const { create } = useThreadMutations();
  const defaults = useNewChatChoice();
  const [busy, setBusy] = useState(false);
  const [pickedMode, setPickedMode] = useState<RuntimeMode | null>(null);

  const agent = useMemo(
    () =>
      (defaults.agents as readonly AgentWithSupervised[]).find(
        (a) => a.id === defaults.choice.agentId,
      ),
    [defaults.agents, defaults.choice.agentId],
  );
  const canSupervise = agentSupportsSupervised(agent);
  const mode: RuntimeMode = canSupervise
    ? (pickedMode ?? defaultRuntimeMode(defaults.settings))
    : "full";

  const start = useCallback(
    async (projectId: string | null, choice: AgentChoice = defaults.choice) => {
      if (busy) return;
      setBusy(true);
      try {
        const input: CreateThreadInput = {
          projectId,
          agentId: choice.agentId,
          ...(choice.model ? { model: choice.model } : {}),
        };
        // `runtimeMode` is not on `CreateThreadInput` until the protocol carries it; the daemon
        // reads the field off the body either way, and a daemon without the feature ignores it.
        const body = mode === "supervised" ? { ...input, runtimeMode: mode } : input;
        const thread = await create.mutateAsync(body as CreateThreadInput);
        router.push({ pathname: "/thread/[id]", params: { id: thread.id } });
      } catch (e) {
        Alert.alert("Could not start a chat", e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [busy, create, defaults.choice, mode],
  );

  return { start, busy, mode, setMode: setPickedMode, agent, ...defaults };
}
