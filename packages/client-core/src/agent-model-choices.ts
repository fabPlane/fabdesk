import type { AgentInfo } from "@fabdesk/protocol";

export const PICKER_MODEL_LIMIT = 3;

/**
 * Models offered for one agent in the composer dropdown: the ones configured in Settings when any,
 * otherwise the adapter's first three. The current selection is always included so it stays visible.
 */
export function pickerModelChoices(available: readonly string[], configured: readonly string[], current = ""): string[] {
  const base = configured.length > 0 ? [...configured] : available.slice(0, PICKER_MODEL_LIMIT);
  const out = base.filter((m, i) => m && base.indexOf(m) === i);
  if (current && !out.includes(current)) out.push(current);
  return out;
}

/** Composer trigger label: `Codex · gpt-5.5`, or just `Claude` on the agent's default model. */
export function agentModelLabel(agent: Pick<AgentInfo, "displayName"> | undefined, agentId: string, model: string): string {
  const name = agent?.displayName ?? agentId;
  return model ? `${name} · ${model}` : name;
}
