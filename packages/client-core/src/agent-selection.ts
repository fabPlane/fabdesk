import type { AgentPreference, Settings, Thread } from "@fabdesk/protocol";
import type { CoreClient } from "./CoreClient";

/** Changing this conversation must not depend on saving defaults for future chats. */
export async function saveAgentSelection(client: Pick<CoreClient, "patchThread" | "saveAgentPreference">, choice: AgentPreference & { threadId?: string }): Promise<{ thread: Thread | null; settings: Settings | null; preferenceError: unknown }> {
  const { threadId, ...preference } = choice;
  // Save the chat first. A failed switch must leave its actual agent/model unchanged.
  const thread: Thread | null = threadId ? await client.patchThread(threadId, preference) : null;
  try {
    const settings = await client.saveAgentPreference(preference);
    return { thread, settings, preferenceError: null };
  } catch (preferenceError) {
    return { thread, settings: null, preferenceError };
  }
}
