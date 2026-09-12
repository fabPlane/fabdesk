/**
 * The agent + model a new chat should start on, and remembering what was picked last.
 *
 * Kept per phone rather than per computer: the choice is a habit of the person holding the phone,
 * and `resolveAgentChoice` already drops it when the connected computer lacks that agent.
 */
import { useDoctor, useSettings } from "@fabdesk/client-core";
import * as SecureStore from "expo-secure-store";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  parseStoredChoice,
  resolveAgentChoice,
  serializeChoice,
  type AgentChoice,
} from "@/lib/agent-choice";

const KEY = "fabdesk.last-agent-choice";

/** Persist the choice the user just made; `undefined` until the stored one has been read. */
export function useRememberedChoice() {
  const [remembered, setRemembered] = useState<AgentChoice | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    SecureStore.getItemAsync(KEY)
      .then((raw) => alive && setRemembered(parseStoredChoice(raw)))
      .catch(() => alive && setRemembered(null));
    return () => {
      alive = false;
    };
  }, []);
  const remember = useCallback((choice: AgentChoice) => {
    setRemembered(choice);
    SecureStore.setItemAsync(KEY, serializeChoice(choice)).catch(() => {});
  }, []);
  return { remembered, remember };
}

/**
 * The choice for a chat that does not exist yet. `choice` follows the stored one until the user
 * picks something on this screen; picking also stores it for next time.
 */
export function useNewChatChoice() {
  const doctor = useDoctor();
  const settings = useSettings();
  const { remembered, remember } = useRememberedChoice();
  const [picked, setPicked] = useState<AgentChoice | null>(null);

  const choice = useMemo(
    () =>
      picked ??
      resolveAgentChoice({
        agents: doctor.data?.agents,
        settings: settings.data,
        remembered: remembered ?? null,
      }),
    [picked, doctor.data?.agents, settings.data, remembered],
  );

  const setChoice = useCallback(
    (next: AgentChoice) => {
      setPicked(next);
      remember(next);
    },
    [remember],
  );

  return {
    choice,
    setChoice,
    agents: doctor.data?.agents ?? [],
    settings: settings.data,
    /** False until the stored choice and the agent list are both in, so a first tap is not lost. */
    ready: remembered !== undefined && !doctor.isLoading,
  };
}
