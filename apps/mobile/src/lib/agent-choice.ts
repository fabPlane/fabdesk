/**
 * Which agent and model a chat runs on, and how the phone decides that when nobody has said.
 *
 * Pure: the picker component and the hook that persists the last choice both sit on top of this,
 * and Bun runs the tests without React Native. `model === ""` means "the agent's own default",
 * matching the desktop composer; on the wire it becomes `model: null`.
 */
import { AgentId, type AgentInfo } from "@fabdesk/protocol";
import { pickerModelChoices } from "@fabdesk/client-core";

export interface AgentChoice {
  agentId: AgentId;
  /** Empty means the agent's default model. */
  model: string;
}

/** The parts of `Settings` the picker needs; keeps tests free of the whole settings object. */
export type PickerSettings = {
  defaultAgent?: AgentId | undefined;
  agents?: Partial<Record<string, { model?: string | null; pickerModels?: string[] }>> | undefined;
};

export interface ChoiceOption {
  label: string;
  hint?: string;
  selected: boolean;
}

export type AgentOption = ChoiceOption & { agentId: AgentId };
export type ModelOption = ChoiceOption & { model: string };

/**
 * A new chat's agent and model: the last one used on this phone if that agent is still installed
 * on the connected computer, else the desktop's default agent with the model configured for it,
 * else the first installed agent. The list of agents comes from `/agents` and may still be
 * loading, in which case a remembered choice is trusted as-is.
 */
export function resolveAgentChoice(input: {
  agents: readonly AgentInfo[] | undefined;
  settings: PickerSettings | undefined;
  remembered: AgentChoice | null;
}): AgentChoice {
  const { agents, settings, remembered } = input;
  const installed = (agents ?? []).filter((a) => a.installed);
  const known = agents === undefined || agents.length === 0;
  if (remembered && (known || installed.some((a) => a.id === remembered.agentId)))
    return remembered;
  const fallback = settings?.defaultAgent;
  if (fallback && (known || installed.some((a) => a.id === fallback))) {
    return { agentId: fallback, model: defaultModel(settings, fallback) };
  }
  const first = installed[0];
  if (first) return { agentId: first.id, model: defaultModel(settings, first.id) };
  return { agentId: fallback ?? "claude", model: defaultModel(settings, fallback ?? "claude") };
}

/** The model Settings configures for an agent, or empty when it is left to the adapter. */
export function defaultModel(settings: PickerSettings | undefined, agentId: AgentId): string {
  return settings?.agents?.[agentId]?.model ?? "";
}

/** Step one of the picker: installed agents only, the current one ticked. */
export function agentOptions(agents: readonly AgentInfo[], current: AgentChoice): AgentOption[] {
  return agents
    .filter((a) => a.installed)
    .map((a) => ({
      agentId: a.id,
      label: a.id,
      ...(a.version ? { hint: a.version } : {}),
      selected: a.id === current.agentId,
    }));
}

/**
 * Step two: the agent's default model first, then the models Settings offers in the desktop
 * dropdown (or the adapter's first three), with whatever the thread is on kept visible even when
 * it is no longer in that list.
 */
export function modelOptions(
  agent: Pick<AgentInfo, "id" | "models">,
  settings: PickerSettings | undefined,
  current: AgentChoice,
): ModelOption[] {
  const fallback = defaultModel(settings, agent.id);
  const active = current.agentId === agent.id;
  const onDefault = active && (current.model === "" || current.model === fallback);
  const configured = settings?.agents?.[agent.id]?.pickerModels ?? [];
  const models = pickerModelChoices(agent.models, configured, active ? current.model : "").filter(
    (m) => m !== fallback,
  );
  return [
    {
      model: fallback,
      label: "Default model",
      ...(fallback ? { hint: fallback } : {}),
      selected: onDefault,
    },
    ...models.map((m) => ({ model: m, label: m, selected: active && current.model === m })),
  ];
}

/** What the composer pill says: `claude · haiku`, or just `claude` on the default model. */
export function choiceLabel(choice: AgentChoice): string {
  return choice.model ? `${choice.agentId} · ${choice.model}` : choice.agentId;
}

export function sameChoice(a: AgentChoice | null, b: AgentChoice | null): boolean {
  return !!a && !!b && a.agentId === b.agentId && a.model === b.model;
}

/** Wire shape for `PATCH /threads/:id` and `POST /threads`: an empty model clears to the default. */
export function choicePatch(choice: AgentChoice): { agentId: AgentId; model: string | null } {
  return { agentId: choice.agentId, model: choice.model || null };
}

/** Reads a stored choice back; anything malformed (or an agent id we no longer know) is dropped. */
export function parseStoredChoice(raw: string | null | undefined): AgentChoice | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { agentId?: unknown; model?: unknown };
    const agentId = AgentId.safeParse(v.agentId);
    if (!agentId.success) return null;
    return { agentId: agentId.data, model: typeof v.model === "string" ? v.model : "" };
  } catch {
    return null;
  }
}

export function serializeChoice(choice: AgentChoice): string {
  return JSON.stringify({ agentId: choice.agentId, model: choice.model });
}
